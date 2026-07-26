import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentPlan } from "../src/compile/plan.js";
import { workflow } from "../src/define.js";
import type { Answer, Harness } from "../src/harness/types.js";
import { resumeRun, startRun, type WorkflowDeps } from "../src/workflow/run.js";
import { RunStore } from "../src/workflow/store.js";

const plan: AgentPlan = {
  name: "test",
  description: "test",
  quality: "fast",
  instructions: "",
  rungs: [],
  services: [],
  locals: [],
  memory: false,
  problems: [],
};

function answer(text: string, data?: unknown): Answer {
  return {
    text,
    data,
    confidence: 1,
    path: ["stub"],
    usage: { inputTokens: 0, outputTokens: 0 },
    toolCalls: [],
    harness: "stub",
  };
}

let dir: string;
let store: RunStore;
let asked: string[];
let tooled: { ref: string; args: unknown }[];

function deps(reply: (input: string) => Answer): WorkflowDeps {
  const harness: Harness = {
    name: "stub",
    async ask(_plan, input) {
      asked.push(input);
      return reply(input);
    },
  };
  return {
    harness,
    store,
    planFor: async () => plan,
    callTool: async (ref, args) => {
      tooled.push({ ref, args });
      return { ok: ref };
    },
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "praecise-runs-"));
  store = new RunStore(dir);
  asked = [];
  tooled = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("startRun", () => {
  it("runs steps in order and returns the last output", async () => {
    const spec = workflow({
      name: "chain",
      steps: [
        { id: "first", ask: "Summarise {{topic}}" },
        { id: "second", ask: "Rewrite {{first}}" },
      ],
    });

    const run = await startRun(spec, { topic: "otters" }, deps((input) => answer(`<${input}>`)));

    expect(run.status).toBe("done");
    expect(asked).toEqual(["Summarise otters", "Rewrite <Summarise otters>"]);
    expect(run.result).toBe("<Rewrite <Summarise otters>>");
  });

  it("passes structured data forward with its type intact", async () => {
    const spec = workflow({
      name: "typed",
      steps: [
        { id: "draft", ask: "write" },
        { id: "send", use: "mail.send", with: { body: "{{draft}}" } },
      ],
    });

    await startRun(spec, {}, deps(() => answer("text", { title: "Hi" })));
    expect(tooled).toEqual([{ ref: "mail.send", args: { body: { title: "Hi" } } }]);
  });

  it("iterates an each step and binds the item", async () => {
    const spec = workflow({
      name: "loop",
      steps: [{ id: "all", each: "{{items}}", as: "row", do: [{ id: "one", ask: "see {{row}}" }] }],
    });

    const run = await startRun(spec, { items: ["a", "b"] }, deps((i) => answer(i.toUpperCase())));
    expect(asked).toEqual(["see a", "see b"]);
    expect(run.result).toEqual(["SEE A", "SEE B"]);
  });

  it("respects an each limit", async () => {
    const spec = workflow({
      name: "capped",
      steps: [{ id: "all", each: "{{items}}", max: 1, do: [{ id: "one", ask: "{{item}}" }] }],
    });
    await startRun(spec, { items: ["a", "b", "c"] }, deps((i) => answer(i)));
    expect(asked).toEqual(["a"]);
  });

  it("takes the matching branch of a when step", async () => {
    const spec = workflow({
      name: "branch",
      steps: [
        {
          id: "route",
          when: "{{kind}}",
          is: { refund: [{ id: "r", ask: "refund path" }] },
          otherwise: [{ id: "o", ask: "other path" }],
        },
      ],
    });

    await startRun(spec, { kind: "refund" }, deps((i) => answer(i)));
    expect(asked).toEqual(["refund path"]);

    asked = [];
    await startRun(spec, { kind: "question" }, deps((i) => answer(i)));
    expect(asked).toEqual(["other path"]);
  });

  it("records a failure rather than throwing", async () => {
    const spec = workflow({ name: "boom", steps: [{ id: "x", ask: "go" }] });
    const broken: WorkflowDeps = {
      ...deps(() => answer("")),
      harness: {
        name: "stub",
        ask: async () => {
          throw new Error("provider down");
        },
      },
    };
    const run = await startRun(spec, {}, broken);
    expect(run.status).toBe("failed");
    expect(run.error).toBe("provider down");
  });
});

describe("approval", () => {
  const spec = workflow({
    name: "gated",
    steps: [
      { id: "draft", ask: "draft it" },
      { id: "ok", approve: "Send {{draft}}?" },
      { id: "send", ask: "send it" },
    ],
  });

  it("suspends at the gate with the interpolated prompt", async () => {
    const run = await startRun(spec, {}, deps((i) => answer(`[${i}]`)));
    expect(run.status).toBe("waiting");
    expect(run.waitingFor).toEqual({ step: "ok", prompt: "Send [draft it]?" });
    expect(asked).toEqual(["draft it"]);
  });

  it("replays completed steps instead of re-running them", async () => {
    const first = await startRun(spec, {}, deps((i) => answer(`[${i}]`)));
    asked = [];

    const resumed = await resumeRun(first.id, { approved: true }, spec, deps((i) => answer(`[${i}]`)));

    expect(resumed.status).toBe("done");
    expect(asked).toEqual(["send it"]);
    expect(resumed.result).toBe("[send it]");
  });

  it("ends the run on rejection without running the rest", async () => {
    const first = await startRun(spec, {}, deps((i) => answer(i)));
    asked = [];

    const resumed = await resumeRun(
      first.id,
      { approved: false, note: "not yet" },
      spec,
      deps((i) => answer(i)),
    );

    expect(resumed.status).toBe("done");
    expect(resumed.result).toEqual({ approved: false, note: "not yet" });
    expect(asked).toEqual([]);
    expect(resumed.events.at(-1)).toMatchObject({ step: "ok", detail: "rejected" });
  });

  it("refuses to resume a run that is not waiting", async () => {
    const done = await startRun(
      workflow({ name: "quick", steps: [{ id: "a", ask: "x" }] }),
      {},
      deps((i) => answer(i)),
    );
    await expect(resumeRun(done.id, { approved: true }, spec, deps((i) => answer(i)))).rejects.toThrow(
      /not waiting/,
    );
  });
});

describe("RunStore", () => {
  it("round-trips a run and lists it", async () => {
    const run = await startRun(
      workflow({ name: "saved", steps: [{ id: "a", ask: "x" }] }),
      {},
      deps((i) => answer(i)),
    );
    expect(await store.load(run.id)).toMatchObject({ id: run.id, status: "done" });
    expect((await store.list()).map((r) => r.id)).toContain(run.id);
  });
});
