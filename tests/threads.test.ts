/**
 * A conversation that outlives the process having it.
 *
 * Two things are being kept apart here and the tests are mostly about the
 * seam between them: the record, which is whole and loses nothing, and the
 * window, which is bounded and is what actually goes back to the model.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { planAgent } from "../src/compile/plan.js";
import { tokens } from "../src/harness/budget.js";
import { BuiltinHarness } from "../src/harness/builtin.js";
import { Threads, carry } from "../src/harness/threads.js";
import type { Conversations, Thread, Turn } from "../src/harness/threads.js";
import { loadProject } from "../src/project/load.js";
import { MODEL_ENV, TEST_MODELS, cleanup, FRAMEWORK, makeProject, stubModel } from "./helpers.js";

let state: string;
const roots: string[] = [];

beforeEach(async () => {
  state = await mkdtemp(join(tmpdir(), "praecise-threads-"));
});

afterEach(async () => {
  await rm(state, { recursive: true, force: true });
  await Promise.all(roots.splice(0).map(cleanup));
});

const said = (role: Turn["role"], content: string): Turn => ({ role, content, at: 1 });

/** A conversation of `pairs` exchanges, each turn `width` characters wide. */
function talk(pairs: number, width: number): Turn[] {
  const turns: Turn[] = [];
  for (let i = 0; i < pairs; i++) {
    turns.push(said("user", `q${i}`.padEnd(width, ".")));
    turns.push(said("assistant", `a${i}`.padEnd(width, ".")));
  }
  return turns;
}

describe("the window onto a conversation", () => {
  it("carries the whole thing while the whole thing fits", () => {
    const turns = talk(3, 10);
    expect(carry(turns, 10_000)).toHaveLength(6);
  });

  it("drops what it has to from the front, oldest first", () => {
    const window = carry(talk(20, 100), 1000);
    expect(window.length).toBeLessThan(40);
    expect(window[window.length - 1]?.content).toContain("a19");
  });

  it("keeps what it carries inside the budget it was given", () => {
    const budget = 1000;
    const window = carry(talk(20, 100), budget);
    const kept = window.reduce((sum, turn) => sum + tokens(turn.content) + 8, 0);
    expect(kept).toBeLessThanOrEqual(budget);
  });

  it("holds the front still while the conversation goes on around it", () => {
    // Dropping the least it could would put the front of the request one turn
    // further along every time anyone said anything, and no endpoint could
    // serve any of it from a prefix it had already read.
    const budget = 1000;
    const grown = talk(20, 100);

    const fronts = new Set<string>();
    for (let i = 0; i < 10; i++) {
      fronts.add(carry(grown, budget)[0]?.content ?? "");
      grown.push(said("user", `and another ${i}`), said("assistant", "noted"));
    }
    expect(fronts.size).toBeLessThanOrEqual(3);
  });

  it("never opens on a reply, which would read as the agent speaking first", () => {
    const window = carry(talk(20, 100), 1000);
    expect(window[0]?.role).toBe("user");
  });

  it("carries nothing rather than something broken when nothing fits", () => {
    expect(carry(talk(1, 5000), 100)).toHaveLength(0);
  });

  it("takes the timestamps off before they go anywhere near a model", () => {
    for (const turn of carry(talk(1, 10), 10_000)) {
      expect(turn).not.toHaveProperty("at");
    }
  });
});

describe("the record", () => {
  it("starts a conversation by being named", async () => {
    const threads = new Threads(join(state, "threads"));
    await threads.append("t1", "a", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);

    const thread = await threads.load("t1");
    expect(thread?.agent).toBe("a");
    expect(thread?.turns).toHaveLength(2);
    expect(thread?.turns[0]?.at).toBeGreaterThan(0);
  });

  it("adds to one that is already going", async () => {
    const threads = new Threads(join(state, "threads"));
    await threads.append("t1", "a", [{ role: "user", content: "one" }]);
    await threads.append("t1", "a", [{ role: "user", content: "two" }]);

    const thread = await threads.load("t1");
    expect(thread?.turns.map((turn) => turn.content)).toEqual(["one", "two"]);
    expect(thread?.startedAt).toBeLessThanOrEqual(thread!.updatedAt);
  });

  it("keeps every turn, however long the conversation gets", async () => {
    const threads = new Threads(join(state, "threads"));
    for (let i = 0; i < 40; i++) {
      await threads.append("t1", "a", [{ role: "user", content: "x".repeat(4000) }]);
    }

    const thread = await threads.load("t1");
    expect(thread?.turns).toHaveLength(40);
    // The record is whole; the window onto it is not.
    expect((await threads.carry("t1")).length).toBeLessThan(40);
  });

  it("says nothing about a conversation nobody has had", async () => {
    const threads = new Threads(join(state, "threads"));
    expect(await threads.load("nope")).toBeUndefined();
    expect(await threads.carry("nope")).toEqual([]);
    expect(await threads.forget("nope")).toBe(false);
  });

  it("lists them most recently spoken in first, with what they opened on", async () => {
    const threads = new Threads(join(state, "threads"));
    await threads.append("older", "a", [{ role: "user", content: "about the roof" }]);
    await new Promise((done) => setTimeout(done, 2));
    await threads.append("newer", "b", [{ role: "user", content: "about the drains" }]);

    const all = await threads.list();
    expect(all.map((thread) => thread.id)).toEqual(["newer", "older"]);
    expect(all[0]?.opened).toBe("about the drains");
    expect(all[0]?.turns).toBe(1);
    expect((await threads.list("a")).map((thread) => thread.id)).toEqual(["older"]);
  });

  it("throws one away when asked for by name", async () => {
    const threads = new Threads(join(state, "threads"));
    await threads.append("t1", "a", [{ role: "user", content: "hello" }]);

    expect(await threads.forget("t1")).toBe(true);
    expect(await threads.load("t1")).toBeUndefined();
    expect(await threads.list()).toEqual([]);
  });

  it("keeps a name that would otherwise be a path out of the directory", async () => {
    const threads = new Threads(join(state, "threads"));
    await threads.append("../escape", "a", [{ role: "user", content: "hello" }]);

    const all = await threads.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe("../escape");
    expect(await threads.carry("../escape")).toHaveLength(1);
  });
});

async function planFor(source: string) {
  const root = await makeProject({
    ...TEST_MODELS,
    "agents/a.ts": `import { agent } from "${FRAMEWORK}";\nexport default agent(${source});`,
  });
  roots.push(root);
  const project = await loadProject(root);
  return planAgent(project, project.agents.a!, { env: MODEL_ENV });
}

describe("asking twice", () => {
  it("carries the first turn into the second without being handed it", async () => {
    const plan = await planFor(`{ role: "Help.", memory: false }`);
    const stub = stubModel([{ text: "Tuesday." }, { text: "The one after." }]);
    const harness = new BuiltinHarness({ stateDir: state, fetch: stub.fetch });

    await harness.ask(plan, "when is bin day?", { thread: "t1" });
    await harness.ask(plan, "and the week after?", { thread: "t1" });

    const heard = JSON.stringify(stub.calls[1]?.body.messages);
    expect(heard).toContain("when is bin day?");
    expect(heard).toContain("Tuesday.");
  });

  it("keeps two conversations apart", async () => {
    const plan = await planFor(`{ role: "Help.", memory: false }`);
    const stub = stubModel([{ text: "Tuesday." }, { text: "No idea." }]);
    const harness = new BuiltinHarness({ stateDir: state, fetch: stub.fetch });

    await harness.ask(plan, "when is bin day?", { thread: "t1" });
    await harness.ask(plan, "and the week after?", { thread: "t2" });

    expect(JSON.stringify(stub.calls[1]?.body.messages)).not.toContain("Tuesday.");
  });

  it("leaves a caller that keeps its own turns holding them", async () => {
    const plan = await planFor(`{ role: "Help.", memory: false }`);
    const stub = stubModel([{ text: "Tuesday." }, { text: "The one after." }]);
    const harness = new BuiltinHarness({ stateDir: state, fetch: stub.fetch });

    await harness.ask(plan, "when is bin day?", { thread: "t1" });
    await harness.ask(plan, "and the week after?", {
      thread: "t1",
      history: [{ role: "user", content: "something else entirely" }],
    });

    const second = JSON.stringify(stub.calls[1]?.body.messages);
    expect(second).toContain("something else entirely");
    expect(second).not.toContain("when is bin day?");
    // What it was handed is what it heard; what was said is still kept.
    expect((await harness.threads.load("t1"))?.turns).toHaveLength(4);
  });

  it("says nothing about the conversation when nobody named one", async () => {
    const plan = await planFor(`{ role: "Help.", memory: false }`);
    const stub = stubModel([{ text: "Tuesday." }]);
    const harness = new BuiltinHarness({ stateDir: state, fetch: stub.fetch });

    await harness.ask(plan, "when is bin day?");
    expect(await harness.threads.list()).toEqual([]);
  });
});

/**
 * Somewhere else to keep them.
 *
 * The point of the seam is that the window is decided in one place whatever is
 * underneath, and that a backend is asked to append rather than being handed a
 * whole conversation to put back — which is what would lose a turn the moment
 * two processes were talking to the same one.
 */
describe("keeping conversations somewhere else", () => {
  /** A backend that keeps them in memory and counts what it was asked to do. */
  function elsewhere() {
    const held = new Map<string, Thread>();
    const asked = { load: 0, append: 0, list: 0, forget: 0 };
    const kept: Conversations = {
      async load(id) {
        asked.load++;
        return held.get(id);
      },
      async append(id, agent, turns) {
        asked.append++;
        const now = Date.now();
        const thread = held.get(id) ?? { id, agent, turns: [], startedAt: now, updatedAt: now };
        thread.agent = agent;
        thread.updatedAt = now;
        for (const message of turns) thread.turns.push({ ...message, at: now });
        held.set(id, thread);
      },
      async list(agent) {
        asked.list++;
        return [...held.values()]
          .filter((thread) => !agent || thread.agent === agent)
          .map((thread) => ({
            id: thread.id,
            agent: thread.agent,
            turns: thread.turns.length,
            startedAt: thread.startedAt,
            updatedAt: thread.updatedAt,
            opened: thread.turns.find((turn) => turn.role === "user")?.content ?? "",
          }));
      },
      async forget(id) {
        asked.forget++;
        return held.delete(id);
      },
    };
    return { kept, asked, held };
  }

  it("passes every stored thing straight through", async () => {
    const { kept, asked } = elsewhere();
    const threads = new Threads(kept);

    await threads.append("t1", "support", [{ role: "user", content: "hello" }]);
    expect((await threads.load("t1"))?.turns).toHaveLength(1);
    expect(await threads.list("support")).toHaveLength(1);
    expect(await threads.forget("t1")).toBe(true);
    expect(await threads.list()).toEqual([]);

    expect(asked).toMatchObject({ append: 1, list: 2, forget: 1 });
  });

  it("asks the backend to append rather than handing back a whole conversation", async () => {
    const { kept, asked } = elsewhere();
    const threads = new Threads(kept);

    await threads.append("t1", "support", [{ role: "user", content: "one" }]);
    await threads.append("t1", "support", [{ role: "user", content: "two" }]);

    // Two turns went in as two appends, and nothing above read the thread to
    // put it back — which is the only reason two processes could both add.
    expect(asked.append).toBe(2);
    expect(asked.load).toBe(0);
    expect((await threads.load("t1"))?.turns.map((turn) => turn.content)).toEqual(["one", "two"]);
  });

  it("decides the window the same way wherever they are kept", async () => {
    const { kept, held } = elsewhere();
    const threads = new Threads(kept);
    const now = Date.now();
    held.set("t1", {
      id: "t1",
      agent: "support",
      turns: talk(40, 4_000),
      startedAt: now,
      updatedAt: now,
    });

    const window = await threads.carry("t1");
    // Same rules as a folder: bounded, and never opening on a reply.
    expect(window.length).toBeLessThan(80);
    expect(window[0]?.role).toBe("user");
    expect(window.at(-1)?.content).toContain("a39");
  });

  it("carries nothing for a conversation the backend does not have", async () => {
    const threads = new Threads(elsewhere().kept);
    expect(await threads.carry("nope")).toEqual([]);
  });

  it("is what the runtime writes into when it is handed one", async () => {
    const { kept } = elsewhere();
    const threads = new Threads(kept);
    const plan = await planFor(`{ role: "Help.", memory: false }`);
    const stub = stubModel([{ text: "Tuesday." }]);
    const harness = new BuiltinHarness({ stateDir: state, fetch: stub.fetch, threads });

    await harness.ask(plan, "when is bin day?", { thread: "t1" });

    expect((await kept.load("t1"))?.turns).toHaveLength(2);
  });
});
