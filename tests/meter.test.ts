import { afterEach, describe, expect, it } from "vitest";

import {
  CallLimitReached,
  MeterRefused,
  agent,
  createApp,
  fn,
  permissionClassifier,
  workflow,
  type App,
  type AppDefinition,
  type AppOptions,
  type Meter,
  type MeteredCall,
  type MeteredUsage,
} from "../src/index.js";
import { scriptedModel, type Scripted } from "../src/testing/index.js";
import { cleanup, makeProject } from "./helpers.js";

/** A meter that writes down what it was asked and told, and refuses where a test says. */
function ledger(refuse?: (call: MeteredCall, seen: number) => string | undefined) {
  const reserved: MeteredCall[] = [];
  const settled: { call: MeteredCall; usage: MeteredUsage; error?: unknown }[] = [];
  const meter: Meter = {
    reserve: (call) => {
      reserved.push(call);
      return refuse?.(call, reserved.length);
    },
    settle: (call, usage, error) => void settled.push({ call, usage, error }),
  };
  return { meter, reserved, settled };
}

const lookup = fn({ description: "Look an order up by its id.", input: { order: "the order id" }, run: () => "shipped" });

describe("a meter asked before every model call", () => {
  let root: string | undefined;
  let app: App | undefined;

  afterEach(async () => {
    await app?.close();
    if (root) await cleanup(root);
    app = undefined;
    root = undefined;
  });

  async function build(replies: Scripted[], definition: AppDefinition, options: AppOptions = {}, endpoint = {}) {
    root = await makeProject({});
    const model = scriptedModel(replies, endpoint);
    app = await createApp({ root, ...definition, config: { ...definition.config, models: model.models } }, options);
    return model;
  }

  it("is asked before each call with the agent, rung, caller, context and an estimate, and settled after", async () => {
    const books = ledger();
    const model = await build(
      [{ tool: { name: "lookup", args: { order: "9" } } }, { text: "It shipped.", usage: { inputTokens: 200, outputTokens: 40 } }],
      { agents: { support: agent({ role: "You answer questions about orders.", tools: ["lookup"] }) }, functions: { lookup } },
      { meter: books.meter },
      { prices: { currency: "USD", fast: { input: 1, output: 2 }, balanced: { input: 3, output: 6 }, best: { input: 9, output: 18 } } },
    );

    const context = { tenant: "t-1" };
    await app!.ask("support", "where is order 9?", { caller: { person: "p-1" }, context });

    expect(model.requests).toHaveLength(2);
    expect(books.reserved).toHaveLength(2);
    const first = books.reserved[0]!;
    expect(first).toMatchObject({ agent: "support", purpose: "answer", provider: "scripted", model: "fast", rung: "fast", caller: { person: "p-1" } });
    expect(first.context).toBe(context);
    expect(first.estimate.inputTokens).toBeGreaterThan(0);
    expect(first.estimate.cost?.currency).toBe("USD");
    expect(first.estimate.cost?.amount).toBeGreaterThan(0);

    expect(books.settled.map((entry) => entry.call.id)).toEqual(books.reserved.map((call) => call.id));
    expect(new Set(books.reserved.map((call) => call.id)).size).toBe(2);
    expect(books.settled[1]!.usage).toMatchObject({ inputTokens: 200, outputTokens: 40, cost: { currency: "USD" } });
    expect(books.settled[1]!.usage.cost!.amount).toBeCloseTo((200 * 1 + 40 * 2) / 1_000_000, 12);
  });

  it("ends the request on a refusal, as the meter's and not a provider's, and does not climb", async () => {
    const books = ledger(() => "this account has used its allowance for today");
    const model = await build(["never sent"], { agents: { a: agent({ role: "You answer." }) } }, { meter: books.meter });

    const failure = await app!.ask("a", "hi").then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(MeterRefused);
    expect((failure as MeterRefused).message).toContain("the meter refused");
    expect((failure as MeterRefused).reason).toBe("this account has used its allowance for today");
    expect((failure as MeterRefused).call.agent).toBe("a");
    // Asked once, for the first rung, and no rung after it was tried.
    expect(books.reserved).toHaveLength(1);
    expect(model.requests).toHaveLength(0);
    expect(books.settled).toHaveLength(0);
  });

  it("reads a meter that throws as a refusal", async () => {
    const meter: Meter = {
      reserve: () => {
        throw new Error("ledger offline");
      },
    };
    await build(["never sent"], { agents: { a: agent({ role: "You answer." }) } }, { meter });
    await expect(app!.ask("a", "hi")).rejects.toThrow(/the meter could not be asked \(ledger offline\)/);
  });

  it("settles a call that failed, and asks again before the rung that is tried next", async () => {
    const books = ledger();
    await build([{ fail: 400 }, "from the next rung"], { agents: { a: agent({ role: "You answer." }) } }, { meter: books.meter });

    const answer = await app!.ask("a", "hi");
    expect(answer.text).toBe("from the next rung");
    expect(books.reserved.map((call) => call.rung)).toEqual(["fast", "balanced"]);
    expect(books.settled).toHaveLength(2);
    expect(books.settled[0]!.error).toBeInstanceOf(Error);
    expect(books.settled[0]!.usage).toEqual({ inputTokens: 0, outputTokens: 0, cachedTokens: 0 });
    expect(books.settled[1]!.error).toBeUndefined();
  });

  it("is asked for the samples that check an answer, and a refusal there ends the request", async () => {
    // Under "cost" an answer is checked against itself, which is more model calls.
    const counting = ledger();
    const model = await build(
      [],
      { config: { preference: "cost" }, agents: { a: agent({ role: "You answer in one word." }) } },
      { meter: counting.meter },
      { fallback: "Paris" },
    );
    const answer = await app!.ask("a", "capital of France?");
    expect(answer.routing?.verified).toBe(true);
    expect(counting.reserved.length).toBe(model.requests.length);
    expect(counting.reserved.length).toBeGreaterThan(1);
    expect(counting.reserved.slice(1).every((call) => call.purpose === "sample")).toBe(true);
    await app!.close();

    const strict = ledger((call) => (call.purpose === "sample" ? "no checking on this plan" : undefined));
    await build(
      [],
      { config: { preference: "cost" }, agents: { a: agent({ role: "You answer in one word." }) } },
      { meter: strict.meter },
      { fallback: "Paris" },
    );
    await expect(app!.ask("a", "capital of France?")).rejects.toBeInstanceOf(MeterRefused);
  });

  it("is asked for an agent another agent asks, and a refusal there ends the whole request", async () => {
    const books = ledger((call) => (call.agent === "desk" ? "the desk is not on this plan" : undefined));
    const model = await build(
      [{ tool: { name: "desk", args: { task: "look up order 9" } } }, "should not be reached"],
      {
        agents: {
          lead: agent({ role: "You hand work to the desk.", tools: ["desk"] }),
          desk: agent({ role: "You look things up." }),
        },
      },
      { meter: books.meter },
    );

    await expect(app!.ask("lead", "where is order 9", { context: "c-9" })).rejects.toThrow(/the desk is not on this plan/);
    expect(books.reserved.map((call) => call.agent)).toEqual(["lead", "desk"]);
    expect(books.reserved[1]!.context).toBe("c-9");
    // The lead was not asked again once the meter had said no.
    expect(model.requests).toHaveLength(1);
  });

  it("is asked for the calls a workflow step makes", async () => {
    const books = ledger();
    await build(
      ["drafted"],
      {
        config: { preference: "quality" },
        agents: { writer: agent({ role: "You write." }) },
        workflows: { flow: workflow({ steps: [{ id: "draft", ask: "write it", agent: "writer" }] }) },
      },
      { meter: books.meter },
    );
    const run = await app!.startWorkflow("flow", {}, { caller: { person: "p-2" } });
    expect(run.status).toBe("done");
    expect(books.reserved).toHaveLength(1);
    expect(books.reserved[0]).toMatchObject({ agent: "writer", caller: { person: "p-2" } });
  });

  it("is asked by the permission classifier when it is handed the same meter", async () => {
    const books = ledger();
    const model = scriptedModel([{ text: { decision: "allow", reason: "it only reads" } }]);
    const classifier = permissionClassifier({ policy: "Reading is allowed.", models: model.models, env: {}, meter: books.meter });
    const verdict = await classifier.check({ agent: "a", tool: "lookup", origin: "local", args: {}, caller: { person: "p-3" } });
    expect(verdict).toEqual({ allow: true });
    expect(books.reserved).toHaveLength(1);
    expect(books.reserved[0]).toMatchObject({ agent: "a", purpose: "classifier", caller: { person: "p-3" } });
    expect(books.settled).toHaveLength(1);
  });
});

describe("a limit on the model calls one request may make", () => {
  let root: string | undefined;
  let app: App | undefined;

  afterEach(async () => {
    await app?.close();
    if (root) await cleanup(root);
    app = undefined;
    root = undefined;
  });

  const looping: Scripted = { tool: { name: "lookup", args: { order: "9" } } };

  it("ends a request that reaches it, and makes no call past it", async () => {
    root = await makeProject({});
    const model = scriptedModel([], { fallback: looping });
    app = await createApp({
      root,
      config: { models: model.models },
      agents: { a: agent({ role: "You look things up.", tools: ["lookup"] }) },
      functions: { lookup },
    });

    const failure = await app.ask("a", "go", { maxCalls: 3 }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(CallLimitReached);
    expect((failure as CallLimitReached).limit).toBe(3);
    expect(model.requests).toHaveLength(3);
  });

  it("takes its default from limits.calls, and counts an agent asked on the way", async () => {
    root = await makeProject({});
    const model = scriptedModel([
      { tool: { name: "desk", args: { task: "look" } } },
      { tool: { name: "lookup", args: { order: "9" } } },
      "never reached",
    ]);
    app = await createApp({
      root,
      config: { models: model.models, limits: { calls: 2 } },
      agents: {
        lead: agent({ role: "You hand work to the desk.", tools: ["desk"] }),
        desk: agent({ role: "You look things up.", tools: ["lookup"] }),
      },
      functions: { lookup },
    });

    await expect(app.ask("lead", "go")).rejects.toBeInstanceOf(CallLimitReached);
    expect(model.requests).toHaveLength(2);
  });

  it("leaves an answer standing unchecked when the check is what would go past it", async () => {
    root = await makeProject({});
    const model = scriptedModel([], { fallback: "Paris" });
    app = await createApp({
      root,
      config: { models: model.models, preference: "cost" },
      agents: { a: agent({ role: "You answer in one word." }) },
    });

    const answer = await app.ask("a", "capital of France?", { maxCalls: 1 });
    expect(answer.text).toBe("Paris");
    expect(model.requests).toHaveLength(1);
    expect(answer.notes?.join("\n")).toContain("stands unchecked");
  });

  it("places no limit where none was set", async () => {
    root = await makeProject({});
    const model = scriptedModel([looping, looping, looping, "done"]);
    app = await createApp({
      root,
      config: { models: model.models },
      agents: { a: agent({ role: "You look things up.", tools: ["lookup"] }) },
      functions: { lookup },
    });
    expect((await app.ask("a", "go")).text).toBe("done");
    expect(model.requests).toHaveLength(4);
  });
});
