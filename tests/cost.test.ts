/**
 * What a request cost in money, where the app said what its models charge.
 *
 * The framework knows no prices. Everything here is arithmetic over what an endpoint
 * declared, and the property worth defending is the absence: an endpoint that declared
 * nothing is not priced at zero, it is not priced, and a limit in money stops a run it
 * cannot measure rather than calling it free.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { planModels } from "../src/compile/models.js";
import { agent, workflow } from "../src/define.js";
import { amountOf, priceFor, unpriced } from "../src/harness/cost.js";
import type { Span } from "../src/harness/trace.js";
import { createApp } from "../src/sdk.js";
import { MODEL_ENV } from "./helpers.js";

/** An endpoint on the messages wire that answers once and reports what it counted. */
function endpoint(usage: Record<string, unknown> = { input_tokens: 1_000, output_tokens: 500 }) {
  const models: string[] = [];
  const impl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { model: string };
    models.push(body.model);
    return new Response(
      JSON.stringify({ content: [{ type: "text", text: "Done." }], stop_reason: "end_turn", usage }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return { fetch: impl, models };
}

const HOUSE = {
  url: "https://models.test",
  credential: "HOUSE_KEY",
  speaks: "messages",
  fast: "small",
  balanced: "mid",
  best: "large",
};

const USD = {
  currency: "USD",
  fast: { input: 1, output: 5 },
  balanced: { input: 3, output: 15, cachedRead: 0.3, cacheWrite: 3.75 },
  best: { input: 15, output: 75 },
};

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "praecise-cost-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("what tokens cost at a declared price", () => {
  const price = { currency: "USD", input: 3, output: 15, cachedRead: 0.3, cacheWrite: 3.75, reasoning: 10 };

  it("charges each kind of token at its own rate, taking it out of the total it is part of", () => {
    const amount = amountOf(
      { inputTokens: 1_000_000, outputTokens: 200_000, cachedTokens: 600_000, cacheWriteTokens: 100_000, reasoningTokens: 50_000 },
      price,
    );
    // 300k plain input, 600k read, 100k written; 150k answer, 50k reasoning.
    expect(amount).toBeCloseTo(0.3 * 3 + 0.6 * 0.3 + 0.1 * 3.75 + 0.15 * 15 + 0.05 * 10, 10);
  });

  it("charges cached, written and reasoning tokens as plain ones where no other rate was declared", () => {
    const amount = amountOf(
      { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedTokens: 400_000, reasoningTokens: 400_000 },
      { currency: "USD", input: 2, output: 8 },
    );
    expect(amount).toBeCloseTo(10, 10);
  });

  it("is no price at all when the declaration is not a currency and two numbers", () => {
    expect(priceFor(undefined, "fast")).toBeUndefined();
    expect(priceFor({ currency: "", fast: { input: 1, output: 2 } }, "fast")).toBeUndefined();
    expect(priceFor({ currency: "USD", fast: { input: -1, output: 2 } }, "fast")).toBeUndefined();
    expect(priceFor({ currency: "USD", best: { input: 1, output: 2 } }, "fast")).toBeUndefined();
    expect(priceFor({ currency: "usd", fast: { input: 1, output: 2 } }, "fast")).toEqual({ currency: "USD", input: 1, output: 2 });
  });

  it("prices a rung by the model it ends up running on", () => {
    const rungs = planModels({
      env: MODEL_ENV,
      quality: "best",
      providers: {
        house: { url: "https://models.test", credential: "HOUSE_KEY", thinking: "effort", balanced: "mid", prices: { currency: "USD", balanced: { input: 3, output: 15 } } },
      },
    });
    // One model named, so every rung is that model and is charged as it.
    expect(rungs.length).toBeGreaterThan(0);
    for (const rung of rungs) expect(rung.price).toEqual({ currency: "USD", input: 3, output: 15 });
  });
});

describe("an answer's cost", () => {
  it("is on the answer when the endpoint declared its prices", async () => {
    const model = endpoint({ input_tokens: 1_000, output_tokens: 500, cache_read_input_tokens: 4_000, cache_creation_input_tokens: 2_000 });
    const app = await createApp(
      { root, config: { models: { house: { ...HOUSE, prices: USD } } }, agents: { helper: agent({ role: "Help.", quality: "fast" }) } },
      { env: MODEL_ENV, fetch: model.fetch },
    );
    const answer = await app.ask("helper", "hello");

    // The fast rung: 7,000 input tokens (its own, read and written) and 500 out, at 1 and 5.
    expect(answer.usage.inputTokens).toBe(7_000);
    expect(answer.usage.cost).toEqual({ USD: expect.closeTo((7_000 * 1 + 500 * 5) / 1_000_000, 10) });
    expect(answer.usage.unpricedTokens).toBeUndefined();
    await app.close();
  });

  it("is absent, not zero, when nothing declared a price", async () => {
    const model = endpoint();
    const app = await createApp(
      { root, config: { models: { house: HOUSE } }, agents: { helper: agent({ role: "Help.", quality: "fast" }) } },
      { env: MODEL_ENV, fetch: model.fetch },
    );
    const answer = await app.ask("helper", "hello");

    expect(answer.usage).toEqual({ inputTokens: 1_000, outputTokens: 500, cachedTokens: 0, decidingTokens: 0 });
    await app.close();
  });

  it("says what it leaves out when one rung of a ladder is priced and the one that answered is not", async () => {
    const model = endpoint();
    const app = await createApp(
      {
        root,
        config: { models: { house: { ...HOUSE, prices: { currency: "USD", best: { input: 15, output: 75 } } } } },
        agents: { helper: agent({ role: "Help.", quality: "best" }) },
      },
      { env: MODEL_ENV, fetch: model.fetch },
    );
    const answer = await app.ask("helper", "hello");

    expect(model.models).toEqual(["small"]);
    expect(answer.usage.cost).toBeUndefined();
    expect(answer.usage.unpricedTokens).toBe(1_500);
    expect(answer.notes?.join(" ")).toContain("no declared price");
    await app.close();
  });

  it("is on the span of the call that incurred it, under this framework's own attribute names", async () => {
    const spans: Span[] = [];
    const model = endpoint();
    const app = await createApp(
      { root, config: { models: { house: { ...HOUSE, prices: USD } } }, agents: { helper: agent({ role: "Help.", quality: "fast" }) } },
      { env: MODEL_ENV, fetch: model.fetch, tracer: (span) => spans.push(span) },
    );
    await app.ask("helper", "hello");

    const chat = spans.find((span) => span.attributes["gen_ai.operation.name"] === "chat")!;
    expect(chat.attributes["praecise.usage.cost"]).toBeCloseTo(0.0035, 10);
    expect(chat.attributes["praecise.usage.cost.currency"]).toBe("USD");
    await app.close();
  });
});

describe("a limit in money on a run", () => {
  const flow = workflow({
    steps: [
      { id: "one", ask: "first", agent: "helper" },
      { id: "two", ask: "second", agent: "helper" },
    ],
  });
  const agents = { helper: agent({ role: "Help.", quality: "fast" }) };

  it("counts what each step cost and lets a run under the limit finish", async () => {
    const app = await createApp(
      { root, config: { models: { house: { ...HOUSE, prices: USD } }, limits: { spend: { amount: 1, currency: "USD" } } }, agents, workflows: { flow } },
      { env: MODEL_ENV, fetch: endpoint().fetch },
    );
    const run = await app.startWorkflow("flow", {});

    expect(run.status).toBe("done");
    expect(run.usage.cost?.USD).toBeCloseTo(0.007, 10);
    await app.close();
  });

  it("stops a run that passes it, and says what was spent", async () => {
    const app = await createApp(
      { root, config: { models: { house: { ...HOUSE, prices: USD } }, limits: { spend: { amount: 0.005, currency: "USD" } } }, agents, workflows: { flow } },
      { env: MODEL_ENV, fetch: endpoint().fetch },
    );
    const run = await app.startWorkflow("flow", {});

    expect(run.status).toBe("failed");
    expect(run.error).toContain("spending limit of 0.005 USD");
    expect(run.error).toContain("0.007 USD spent");
    await app.close();
  });

  it("stops a run answered by a model with no price, rather than counting it as free", async () => {
    const app = await createApp(
      { root, config: { models: { house: HOUSE }, limits: { spend: { amount: 1, currency: "USD" } } }, agents, workflows: { flow } },
      { env: MODEL_ENV, fetch: endpoint().fetch },
    );
    const run = await app.startWorkflow("flow", {});

    expect(run.status).toBe("failed");
    expect(run.error).toContain("no declared price in USD");
    await app.close();
  });

  it("cannot be held against spend in another currency", () => {
    const limit = { amount: 1, currency: "USD" };
    expect(unpriced({ inputTokens: 10, outputTokens: 5, cost: { EUR: 0.1 } }, limit)).toContain("EUR");
    expect(unpriced({ inputTokens: 10, outputTokens: 5, cost: { USD: 0.1 }, unpricedTokens: 3 }, limit)).toContain("no declared price");
    expect(unpriced({ inputTokens: 10, outputTokens: 5, cost: { USD: 0.1 } }, limit)).toBeUndefined();
    // Nothing was spent, so there is nothing the limit failed to see.
    expect(unpriced({ inputTokens: 0, outputTokens: 0 }, limit)).toBeUndefined();
  });
});
