import { afterEach, describe, expect, it } from "vitest";

import {
  agent,
  composeHooks,
  createApp,
  defineApp,
  fn,
  hooks,
  type App,
  type AppDefinition,
  type RecordSelf,
  type SelfProvider,
  type SelfRecording,
  type SelfWork,
} from "../src/index.js";
import { scriptedModel } from "../src/testing/index.js";
import { cleanup, makeProject } from "./helpers.js";

/** A self provider that hands out a ticket and keeps what it is sent. */
function provider() {
  const recorded: { ticket: string; work: SelfWork }[] = [];
  const selves: SelfProvider = {
    context: async () => ({ preamble: "", ticket: "ticket-1" }),
    record: async (ticket, work) => void recorded.push({ ticket, work }),
    outcome: async () => undefined,
  };
  return { selves, recorded };
}

describe("what a self is sent can be shortened, replaced or dropped", () => {
  let root: string | undefined;
  let app: App | undefined;

  afterEach(async () => {
    await app?.close();
    if (root) await cleanup(root);
    app = undefined;
    root = undefined;
  });

  async function build(definition: Omit<AppDefinition, "agents">, record?: RecordSelf) {
    root = await makeProject({});
    const model = scriptedModel([{ tool: { name: "lookup", args: { order: "9" } } }, "Order 9 belongs to jo@example.com and has shipped."]);
    const kept = provider();
    app = await createApp(
      {
        root,
        ...definition,
        config: { models: model.models },
        agents: {
          desk: agent({
            role: "You work the desk.",
            tools: ["lookup"],
            self: { handle: "desk", ...(record ? { record } : {}) },
          }),
        },
        functions: { lookup: fn({ description: "Look an order up.", input: { order: "the id" }, run: () => "shipped" }) },
      },
      { selves: kept.selves },
    );
    return kept;
  }

  const ASKED = "where is order 9, for jo@example.com?";

  it("sends the work as it is where nobody says otherwise", async () => {
    const kept = await build({});
    await app!.ask("desk", ASKED);
    expect(kept.recorded).toEqual([
      { ticket: "ticket-1", work: { task: ASKED, answer: "Order 9 belongs to jo@example.com and has shipped.", tools: ["lookup"] } },
    ]);
  });

  it("sends what the agent's record returns, and tells it whose work it is", async () => {
    const seen: { work: SelfWork; about: SelfRecording }[] = [];
    const kept = await build({}, (work, about) => {
      seen.push({ work, about });
      return { ...work, task: work.task.replace(/\S+@\S+/g, "[email]"), answer: work.answer.slice(0, 7), tools: [] };
    });

    await app!.ask("desk", ASKED, { caller: { person: "p-1" }, context: { tenant: "t-1" } });

    expect(seen[0]!.about).toEqual({ agent: "desk", handle: "desk", caller: { person: "p-1" }, context: { tenant: "t-1" } });
    expect(seen[0]!.work.tools).toEqual(["lookup"]);
    expect(kept.recorded[0]!.work).toEqual({ task: "where is order 9, for [email]", answer: "Order 9", tools: [] });
  });

  it("sends nothing when the agent's record returns nothing, and still answers", async () => {
    const kept = await build({}, () => undefined);
    const answer = await app!.ask("desk", ASKED);
    expect(answer.text).toContain("has shipped");
    expect(answer.self?.handle).toBe("desk");
    expect(kept.recorded).toEqual([]);
  });

  it("asks the app's hook after the agent's, with what the agent's left", async () => {
    const order: string[] = [];
    const kept = await build(
      {
        hooks: hooks({
          beforeRecord: (work) => {
            order.push(`app saw: ${work.answer}`);
            return { ...work, answer: `${work.answer} (reviewed)` };
          },
        }),
      },
      (work) => {
        order.push("agent");
        return { ...work, answer: "redacted" };
      },
    );
    await app!.ask("desk", ASKED);
    expect(order).toEqual(["agent", "app saw: redacted"]);
    expect(kept.recorded[0]!.work.answer).toBe("redacted (reviewed)");
  });

  it("lets the app's hook drop it, and does not ask the app once the agent has", async () => {
    const dropped = await build({ hooks: hooks({ beforeRecord: () => undefined }) });
    await app!.ask("desk", ASKED);
    expect(dropped.recorded).toEqual([]);
    await app!.close();

    let asked = 0;
    const kept = await build(
      {
        hooks: hooks({
          beforeRecord: (work) => {
            asked++;
            return work;
          },
        }),
      },
      () => undefined,
    );
    await app!.ask("desk", ASKED);
    expect(asked).toBe(0);
    expect(kept.recorded).toEqual([]);
  });

  it("sends nothing when a check throws or returns something that is not work, and says so", async () => {
    const thrown = await build({}, () => {
      throw new Error("scrubber offline");
    });
    const answer = await app!.ask("desk", ASKED);
    expect(thrown.recorded).toEqual([]);
    expect(answer.notes?.join("\n")).toContain("scrubber offline");
    await app!.close();

    const wrong = await build({}, (() => "just a string") as unknown as RecordSelf);
    const second = await app!.ask("desk", ASKED);
    expect(wrong.recorded).toEqual([]);
    expect(second.notes?.join("\n")).toContain("not work to record");
  });

  it("composes several hooks in order, the first to drop ending it", async () => {
    const both = composeHooks([
      { beforeRecord: (work) => ({ ...work, answer: `${work.answer}!` }) },
      { beforeRecord: (work) => ({ ...work, answer: `${work.answer}?` }) },
    ])!;
    const about = { agent: "a", handle: "h" };
    expect(await both.beforeRecord!({ task: "t", answer: "x", tools: [] }, about)).toEqual({ task: "t", answer: "x!?", tools: [] });

    let reached = false;
    const stopped = composeHooks([
      { beforeRecord: () => undefined },
      {
        beforeRecord: (work) => {
          reached = true;
          return work;
        },
      },
    ])!;
    expect(await stopped.beforeRecord!({ task: "t", answer: "x", tools: [] }, about)).toBeUndefined();
    expect(reached).toBe(false);
  });

  it("refuses a record that is not a function when the app is defined", () => {
    const project = defineApp({
      agents: { desk: agent({ role: "You work the desk.", self: { handle: "desk", record: "yes" as unknown as RecordSelf } }) },
    });
    expect(project.faults?.join("\n")).toContain("a self's `record` is a function");
  });
});
