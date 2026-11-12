import { afterEach, describe, expect, it } from "vitest";

import { agent, createApp, fn, guard, workflow, type App, type Attempt, type FunctionRunOptions } from "../src/index.js";
import { cleanup, makeProject, MODEL_ENV, stubModel } from "./helpers.js";

const MODELS = {
  house: { url: "https://models.test", credential: "HOUSE_KEY", speaks: "messages", fast: "small", balanced: "mid", best: "large" },
};

const SECRET = "tenant-7f3a-do-not-leak";

describe("caller and context reach the guard, the authority and functions", () => {
  let root: string | undefined;
  let app: App | undefined;

  afterEach(async () => {
    await app?.close();
    if (root) await cleanup(root);
    app = undefined;
    root = undefined;
  });

  async function build(model: ReturnType<typeof stubModel>) {
    root = await makeProject({});
    const seen: { opts: FunctionRunOptions[]; guard: Attempt[]; authority: Attempt[] } = { opts: [], guard: [], authority: [] };
    app = await createApp(
      {
        root,
        config: { models: MODELS },
        agents: {
          desk: agent({ role: "You look things up.", tools: ["lookup"] }),
          lead: agent({ role: "You hand work to the desk.", tools: ["desk"] }),
        },
        functions: {
          lookup: fn({
            description: "Look an order up by its id.",
            input: { order: "the order id" },
            run: (_args, opts) => {
              seen.opts.push(opts ?? {});
              return "found";
            },
          }),
        },
        workflows: {
          flow: workflow({
            steps: [
              { id: "direct", use: "lookup", with: { order: "1" } },
              { id: "asked", ask: "look up order 2", agent: "desk" },
            ],
          }),
        },
        guard: guard((attempt) => {
          seen.guard.push(attempt);
          return undefined;
        }),
      },
      {
        env: MODEL_ENV,
        fetch: model.fetch,
        authority: {
          check: (attempt: Attempt) => {
            seen.authority.push(attempt);
            return { allow: true };
          },
        } as never,
      },
    );
    return seen;
  }

  it("hands both to the guard, the authority and the function a model called", async () => {
    const model = stubModel([{ text: "", tool: { name: "lookup", args: { order: "9" } } }, { text: "done" }]);
    const seen = await build(model);
    const context = { tenant: SECRET, handle: Symbol("db") };

    await app!.ask("desk", "where is order 9", { caller: { person: "zelda-9", plan: "pro" }, context });

    expect(seen.guard[0]!.caller).toEqual({ person: "zelda-9", plan: "pro" });
    expect(seen.guard[0]!.context).toBe(context);
    expect(seen.authority[0]!.context).toBe(context);
    expect(seen.opts[0]!.caller).toEqual({ person: "zelda-9", plan: "pro" });
    expect(seen.opts[0]!.context).toBe(context);
    // A function called from the loop still learns where the call sits.
    expect(seen.opts[0]!.transcript?.length).toBeGreaterThan(0);
    expect(typeof seen.opts[0]!.publish).toBe("function");
    // Nothing of either was sent to the model.
    expect(JSON.stringify(model.calls)).not.toContain(SECRET);
    expect(JSON.stringify(model.calls)).not.toContain("zelda-9");
  });

  it("leaves both absent when the app named nobody", async () => {
    const model = stubModel([{ text: "", tool: { name: "lookup", args: { order: "9" } } }, { text: "done" }]);
    const seen = await build(model);
    await app!.ask("desk", "where is order 9");
    expect("caller" in seen.guard[0]!).toBe(false);
    expect("context" in seen.guard[0]!).toBe(false);
    expect(seen.opts[0]!.caller).toBeUndefined();
  });

  it("carries both to an agent another agent asks", async () => {
    const model = stubModel([
      { text: "", tool: { name: "desk", args: { task: "look up order 9" } } },
      { text: "", tool: { name: "lookup", args: { order: "9" } } },
      { text: "found it" },
      { text: "the desk found it" },
    ]);
    const seen = await build(model);
    await app!.ask("lead", "where is order 9", { caller: { person: "zelda-9" }, context: { tenant: SECRET } });

    const lookup = seen.guard.find((attempt) => attempt.tool === "lookup")!;
    expect(lookup.agent).toBe("desk");
    expect(lookup.caller).toEqual({ person: "zelda-9" });
    expect(lookup.context).toEqual({ tenant: SECRET });
    expect(seen.opts[0]!.context).toEqual({ tenant: SECRET });
    expect(JSON.stringify(model.calls)).not.toContain(SECRET);
  });

  it("carries both through a workflow's steps and a direct call", async () => {
    const model = stubModel([{ text: "", tool: { name: "lookup", args: { order: "2" } } }, { text: "done" }]);
    const seen = await build(model);

    const run = await app!.startWorkflow("flow", {}, { caller: { person: "grace" }, context: { tenant: SECRET } });
    expect(run.status).toBe("done");
    expect(seen.opts).toHaveLength(2);
    for (const opts of seen.opts) {
      expect(opts.caller).toEqual({ person: "grace" });
      expect(opts.context).toEqual({ tenant: SECRET });
    }
    expect(seen.guard.map((attempt) => attempt.via)).toEqual(["workflow", undefined]);
    for (const attempt of seen.guard) expect(attempt.context).toEqual({ tenant: SECRET });
    // Held for the drive of the run, not written with it.
    expect(JSON.stringify(await app!.runs.load(run.id))).not.toContain(SECRET);

    await app!.callTool("lookup", { order: "3" }, { via: "http", caller: { person: "lin" }, context: 42 });
    expect(seen.opts[2]!.caller).toEqual({ person: "lin" });
    expect(seen.opts[2]!.context).toBe(42);
    expect(seen.guard[2]!.caller).toEqual({ person: "lin" });
  });
});
