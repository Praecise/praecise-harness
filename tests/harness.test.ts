import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { planAgent } from "../src/compile/plan.js";
import { loadProject } from "../src/project/load.js";
import { BuiltinHarness } from "../src/harness/builtin.js";
import { resolveHarness } from "../src/harness/index.js";
import type { Message } from "../src/harness/types.js";
import { MODEL_ENV, TEST_MODELS, cleanup, FRAMEWORK, makeProject, stubModel } from "./helpers.js";

let state: string;
const roots: string[] = [];

beforeEach(async () => {
  state = await mkdtemp(join(tmpdir(), "praecise-state-"));
});

afterEach(async () => {
  await rm(state, { recursive: true, force: true });
  await Promise.all(roots.splice(0).map(cleanup));
});

async function planFor(source: string, env: Record<string, string> = MODEL_ENV) {
  const root = await makeProject({
    ...TEST_MODELS,
    "agents/a.ts": `import { agent } from "${FRAMEWORK}";\nexport default agent(${source});`,
    "memory/faq.md": "Refunds take five business days.",
  });
  roots.push(root);
  const project = await loadProject(root);
  return planAgent(project, project.agents.a!, { env });
}

/** An app that was never pointed at a model at all — a folder five minutes old. */
async function unconfigured() {
  const root = await makeProject({
    "agents/a.ts": `import { agent } from "${FRAMEWORK}";\nexport default agent({ role: "Help." });`,
  });
  roots.push(root);
  const project = await loadProject(root);
  return planAgent(project, project.agents.a!, { env: {} });
}

/** Long enough to read as work rather than as a greeting. */
const long = (characters: number) => "consider the following clause ".repeat(characters / 30);

/** Enough turns behind a request to push it to the edge of the cheap model's band. */
const borderline: Message[] = [
  { role: "user", content: "earlier" },
  { role: "assistant", content: "noted" },
  { role: "user", content: "and also" },
];

/**
 * Enough work behind a request to put it beyond the cheap model outright: a full
 * conversation, and as much to read back before answering as the estimate counts.
 */
const deep: Message[] = Array.from(
  { length: 8 },
  () => ({ role: "user", content: long(5_000) }) as Message,
);

describe("BuiltinHarness", () => {
  it("answers a small question with the cheapest model, and asks it once", async () => {
    const plan = await planFor(`{ role: "Help.", quality: "best", memory: false }`);
    const stub = stubModel([{ text: "Five days." }]);
    const harness = new BuiltinHarness({ stateDir: state, fetch: stub.fetch });

    const answer = await harness.ask(plan, "how long do refunds take?");

    expect(answer.text).toBe("Five days.");
    expect(answer.path).toHaveLength(1);
    expect(stub.calls).toHaveLength(1);
    expect(answer.routing?.verified).toBe(false);
    expect(answer.agreement).toBeUndefined();
  });

  it("starts at a stronger model when the WORK behind the request warrants it", async () => {
    // Re-tuned, and the re-tuning is the point. This used to be a long question with a
    // token conversation behind it, and it started high because question length was the
    // heaviest term in the estimate. Length is a failure-risk axis rather than a
    // difficulty one, so it no longer moves which rung answers — and a fixture that
    // "started at mid" on nothing but its own size was asserting the bug. What warrants
    // a stronger model is the work: a deep conversation with a great deal to read back
    // before answering can start.
    const plan = await planFor(`{ role: "Help.", quality: "balanced", memory: false }`);
    const stub = stubModel([{ text: "A considered answer." }]);
    const harness = new BuiltinHarness({ stateDir: state, fetch: stub.fetch });

    const answer = await harness.ask(plan, long(2500), { history: deep });

    // Nothing was climbed: the cheap model was never asked in the first place.
    expect(stub.calls).toHaveLength(1);
    expect(answer.path).toHaveLength(1);
    expect(answer.routing?.climbed).toBe(false);
    expect(answer.routing?.entry).toContain("mid");
    expect(answer.notes?.join(" ")).toContain("started at mid");
  });

  it("asks a borderline question more than once and keeps the answer that holds up", async () => {
    const plan = await planFor(`{ role: "Help.", quality: "balanced", memory: false }`);
    const stub = stubModel([
      { text: "Refunds are settled within five business days." },
      { text: "Refunds settle within five business days." },
    ]);
    const harness = new BuiltinHarness({ stateDir: state, fetch: stub.fetch });

    const answer = await harness.ask(plan, long(2500), { history: borderline });

    expect(stub.calls).toHaveLength(2);
    expect(stub.calls.every((call) => call.model === stub.calls[0]?.model)).toBe(true);
    expect(answer.path).toHaveLength(1);
    expect(answer.routing?.verified).toBe(true);
    expect(answer.agreement).toBeGreaterThan(0.6);
    expect(answer.text).toContain("five business days");
  });

  it("climbs when the same model gives a different answer each time it is asked", async () => {
    const plan = await planFor(`{ role: "Help.", quality: "balanced", memory: false }`);
    const stub = stubModel([
      { text: "Maybe a week, possibly longer, hard to say." },
      { text: "Refunds are instant." },
      { text: "Five business days." },
    ]);
    const harness = new BuiltinHarness({ stateDir: state, fetch: stub.fetch });

    const answer = await harness.ask(plan, long(2500), { history: borderline });

    expect(stub.calls).toHaveLength(3);
    expect(answer.text).toBe("Five business days.");
    expect(answer.path).toHaveLength(2);
    expect(answer.routing?.climbed).toBe(true);
    expect(answer.notes?.join(" ")).toContain("different answer each time");
  });

  it("counts what it spent deciding separately from what it spent answering", async () => {
    const plan = await planFor(`{ role: "Help.", quality: "balanced", memory: false }`);
    const stub = stubModel([{ text: "Five days." }, { text: "Five days." }]);
    const harness = new BuiltinHarness({ stateDir: state, fetch: stub.fetch });

    const answer = await harness.ask(plan, long(2500), { history: borderline });

    // Two calls were made; one of them only ever existed to check the other.
    expect(answer.usage.decidingTokens).toBe(15);
    expect(answer.usage.inputTokens + answer.usage.outputTokens).toBe(30);
  });

  it("never asks a model how sure it is", async () => {
    const plan = await planFor(`{ role: "Help.", quality: "best", memory: false }`);
    const stub = stubModel([{ text: "ok" }]);
    await new BuiltinHarness({ stateDir: state, fetch: stub.fetch }).ask(plan, "hi");

    expect(String(stub.calls[0]?.body.system)).not.toContain("confidence");
  });

  it("carries knowledge into the system prompt", async () => {
    const plan = await planFor(`{ role: "Help.", knows: ["memory/faq.md"], memory: false }`);
    const stub = stubModel([{ text: "ok" }]);
    await new BuiltinHarness({ stateDir: state, fetch: stub.fetch }).ask(plan, "hi");

    expect(String(stub.calls[0]?.body.system)).toContain("Refunds take five business days.");
  });

  it("waits and asks the SAME rung again when the endpoint is merely busy", async () => {
    // A 429 or a 5xx is the moment failing, not the model. Climbing here would send
    // traffic to the dearer rung exactly when load is high — the ladder paying more
    // because the endpoint was busy, which inverts the reason it exists.
    const plan = await planFor(`{ role: "Help.", quality: "balanced", memory: false }`);
    let call = 0;
    const impl = (async () => {
      call++;
      if (call === 1) return new Response("slow down", { status: 429 });
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "recovered" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const answer = await new BuiltinHarness({ stateDir: state, fetch: impl }).ask(plan, "hi");
    expect(answer.text).toBe("recovered");
    expect(answer.notes?.join(" ")).toContain("is busy");
    expect(answer.notes?.join(" ")).not.toContain("trying the next model");
    expect(answer.routing?.climbed).toBe(false);
  });

  it("survives one provider failing by trying the next rung", async () => {
    const plan = await planFor(`{ role: "Help.", quality: "balanced", memory: false }`);
    let call = 0;
    const impl = (async () => {
      call++;
      // 400 is the endpoint judging the request, not a passing fault — so it climbs.
      if (call === 1) return new Response("bad request", { status: 400 });
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "recovered" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const answer = await new BuiltinHarness({ stateDir: state, fetch: impl }).ask(plan, "hi");
    expect(answer.text).toBe("recovered");
    expect(answer.notes?.join(" ")).toContain("trying the next model");
    // A failure is not the router having misjudged anything, so it is not a climb.
    expect(answer.routing?.climbed).toBe(false);
  });

  it("answers offline, without throwing, when nothing was ever configured", async () => {
    const plan = await unconfigured();
    const answer = await new BuiltinHarness({ stateDir: state }).ask(plan, "hi");
    expect(answer.harness).toBe("offline");
    expect(answer.text).toContain("No model endpoint is configured");
  });

  it("marks a placeholder as one, in the answer rather than only in its prose", async () => {
    // The defect: an app with no model returned plausible text and reported
    // `done`, and nothing a caller could read said it was not an answer.
    const plan = await unconfigured();
    const answer = await new BuiltinHarness({ stateDir: state }).ask(plan, "hi");
    expect(answer.placeholder).toBe(true);
    expect(answer.notes?.join(" ")).toContain("placeholder");
  });

  it("refuses instead of a placeholder when the app is strict", async () => {
    const plan = await unconfigured();
    await expect(new BuiltinHarness({ stateDir: state, strict: true }).ask(plan, "hi")).rejects.toThrow(
      /no model endpoint, and this app is strict/,
    );
  });

  it("never fabricates for an app that has models and cannot reach them", async () => {
    // A typo'd credential in production is the dangerous case: the app WAS
    // configured, so a friendly placeholder is a confident wrong answer.
    const plan = await planFor(`{ role: "Help." }`, {});
    expect(plan.unreachable).toEqual(["\"house\" needs HOUSE_KEY to be set"]);
    await expect(new BuiltinHarness({ stateDir: state }).ask(plan, "hi")).rejects.toThrow(
      /could not reach any of them: "house" needs HOUSE_KEY to be set/,
    );
  });

  it("recalls a prior exchange on the next question", async () => {
    const plan = await planFor(`{ role: "Help.", memory: true }`);
    const stub = stubModel([{ text: "Your order is 42." }, { text: "still 42" }]);
    const harness = new BuiltinHarness({ stateDir: state, fetch: stub.fetch });

    await harness.ask(plan, "what is my order number?");
    await harness.ask(plan, "what is my order number again?");

    expect(String(stub.calls[1]?.body.system)).toContain("Your order is 42.");
  });

  it("keeps what never changes in front of what does, so a prefix can be reused", async () => {
    const plan = await planFor(`{ role: "Help.", knows: ["memory/faq.md"], memory: true }`);
    const stub = stubModel([{ text: "Your order is 42." }, { text: "still 42" }]);
    const harness = new BuiltinHarness({ stateDir: state, fetch: stub.fetch });

    await harness.ask(plan, "what is my order number?");
    await harness.ask(plan, "what is my order number again?");

    const first = String(stub.calls[0]?.body.system);
    const second = String(stub.calls[1]?.body.system);
    // The second request recalled something the first could not, so the prompts
    // differ — but they differ at the end, and everything before that is shared
    // and can be served from a cache rather than read again.
    expect(second).not.toBe(first);
    expect(second.startsWith(first)).toBe(true);
    expect(first.startsWith(plan.instructions)).toBe(true);
  });
});

/**
 * Escalating along DEPTH before escalating across models.
 *
 * The fixtures below all land on the middle rung of a three-rung ladder, and they do
 * that on purpose: the cheapest rung of every ladder `compile/models.ts` builds is capped
 * at no depth at all, so it is the one rung where none of this can happen and the only
 * escalation available to it is a crossing. Eight turns of conversation is what puts a
 * request past it without putting it at the top.
 */
describe("more room to think, before another model", () => {
  /** Eight turns: past the cheapest rung, nowhere near the strongest. */
  const conversation: Message[] = Array.from(
    { length: 8 },
    () => ({ role: "user", content: "prior" }) as Message,
  );

  /** The depth each call asked the endpoint for, in order. */
  const depths = (stub: ReturnType<typeof stubModel>) =>
    stub.calls.map((call) => (call.body.output_config as { effort: string } | undefined)?.effort);

  const models = (stub: ReturnType<typeof stubModel>) => stub.calls.map((call) => call.model);

  it("checks a borderline answer by asking the SAME model with more room, not another model", async () => {
    // The check and the escalation are one call. A repeat would buy only the comparison;
    // this buys the comparison and, if it goes badly, the better answer along with it —
    // on a model whose prefix cache is still warm, which a crossing always throws away.
    const plan = await planFor(`{ role: "Help.", quality: "best", memory: false }`);
    const stub = stubModel([
      { text: "Refunds are settled within five business days." },
      { text: "Refunds settle within five business days." },
    ]);
    const harness = new BuiltinHarness({ stateDir: state, fetch: stub.fetch });

    const answer = await harness.ask(plan, long(2500), { history: conversation });

    expect(stub.calls).toHaveLength(2);
    expect(models(stub)).toEqual(["mid", "mid"]);
    expect(depths(stub)).toEqual(["low", "medium"]);
    expect(answer.routing?.verified).toBe(true);
    expect(answer.routing?.climbed).toBe(false);
    expect(answer.path).toEqual(["house/mid"]);
  });

  it("keeps the deeper answer when the two depths disagree, rather than crossing", async () => {
    // Two depths of one model disagreeing says the request needed more room, which is
    // exactly what has just been spent on it. It is not evidence about a different model.
    const plan = await planFor(`{ role: "Help.", quality: "best", memory: false }`);
    const stub = stubModel([
      { text: "Maybe a week, possibly longer, hard to say." },
      { text: "Five business days." },
      { text: "Five business days." },
    ]);
    const harness = new BuiltinHarness({ stateDir: state, fetch: stub.fetch });

    const answer = await harness.ask(plan, long(2500), { history: conversation });

    // Three calls, not four: the deeper answer drawn to settle the first comparison IS
    // the second attempt. Asking for it again would pay twice for the one call the whole
    // design turns on.
    expect(stub.calls).toHaveLength(3);
    expect(models(stub)).toEqual(["mid", "mid", "mid"]);
    expect(depths(stub)).toEqual(["low", "medium", "high"]);
    expect(answer.text).toBe("Five business days.");
    expect(answer.routing?.climbed).toBe(false);
    expect(answer.notes?.join(" ")).toContain("more room to think");
  });

  it("crosses to another model only from the top of the depth ladder", async () => {
    const plan = await planFor(`{ role: "Help.", quality: "best", memory: false }`);
    const stub = stubModel([
      { text: "Maybe a week, possibly longer." },
      { text: "Refunds are instant, always." },
      { text: "Somewhere between two and nine days." },
      { text: "It depends entirely on your bank." },
      { text: "Five business days." },
    ]);
    const harness = new BuiltinHarness({ stateDir: state, fetch: stub.fetch });

    const answer = await harness.ask(plan, long(2500), { history: conversation });

    // Every depth the endpoint can tell apart is spent on the cheaper model before the
    // dearer one is asked to read the prompt again from cold.
    expect(models(stub)).toEqual(["mid", "mid", "mid", "mid", "large"]);
    expect(answer.text).toBe("Five business days.");
    expect(answer.routing?.climbed).toBe(true);
    expect(answer.path).toEqual(["house/mid", "house/mid", "house/mid", "house/large"]);
  });

  it("spends one deeper pass on an answer that came back demonstrably broken", async () => {
    // The only two things about an answer this framework knows for nothing are whether a
    // declared shape parsed and whether a tool errored. They are therefore the only two
    // allowed to escalate without a check being paid for first — and the escalation they
    // buy is the cheap one, on the same model, never a crossing.
    const plan = await planFor(
      `{ role: "Help.", quality: "best", memory: false, returns: { days: "how many" } }`,
    );
    const stub = stubModel([{ text: "about five, I think" }, { text: `{"days": 5}` }]);
    const harness = new BuiltinHarness({ stateDir: state, fetch: stub.fetch });

    const answer = await harness.ask(plan, "how long?", { history: conversation });

    expect(stub.calls).toHaveLength(2);
    expect(models(stub)).toEqual(["mid", "mid"]);
    expect(depths(stub)).toEqual(["low", "medium"]);
    expect(answer.data).toEqual({ days: 5 });
    expect(answer.routing?.climbed).toBe(false);
    expect(answer.notes?.join(" ")).toContain("not in the shape asked for");
  });

  /** An agent whose one tool always fails, so a free fault is guaranteed. */
  async function brokenToolPlan() {
    const root = await makeProject({
      ...TEST_MODELS,
      "functions/lookup.ts": `import { fn } from "${FRAMEWORK}";\nexport default fn({ description: "Look something up.", run: () => { throw new Error("upstream is down"); } });`,
      "agents/a.ts": `import { agent } from "${FRAMEWORK}";\nexport default agent({ role: "Help.", quality: "best", memory: false, tools: ["lookup"] });`,
    });
    roots.push(root);
    const project = await loadProject(root);
    return planAgent(project, project.agents.a!, { env: MODEL_ENV });
  }

  it("deepens after a tool errored, when nobody has been shown anything yet", async () => {
    const plan = await brokenToolPlan();
    const stub = stubModel([
      { text: "Let me look.", tool: { name: "lookup", args: {} } },
      { text: "I could not reach the system." },
      { text: "Refunds take five business days." },
    ]);
    const answer = await new BuiltinHarness({ stateDir: state, fetch: stub.fetch }).ask(
      plan,
      "how long?",
      { history: conversation },
    );

    expect(models(stub)).toEqual(["mid", "mid", "mid"]);
    expect(depths(stub)).toEqual(["low", "low", "medium"]);
    expect(answer.text).toBe("Refunds take five business days.");
  });

  it("does not deepen away from an answer a reader has already been shown", async () => {
    // Nothing reported is ever taken back. The same broken tool, the same free fault, and
    // the escalation is declined — because a fragment has been handed over and no better
    // answer later is worth an interface that rewrites itself.
    const plan = await brokenToolPlan();
    const stub = stubModel([
      { text: "Let me look.", tool: { name: "lookup", args: {} } },
      { text: "I could not reach the system." },
      { text: "Refunds take five business days." },
    ]);
    const answer = await new BuiltinHarness({ stateDir: state, fetch: stub.fetch }).ask(
      plan,
      "how long?",
      { history: conversation, onProgress: () => {} },
    );

    expect(stub.calls).toHaveLength(2);
    expect(answer.text).toBe("I could not reach the system.");
  });
});

describe("randomising a share of decisions, so the record can be read back", () => {
  const rowsFor = async (agent: string) =>
    (await readFile(join(state, "routing", `${agent}.jsonl`), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  it("writes a propensity of one when nothing was randomised", async () => {
    // Which is the same as writing down that this log cannot be read for anything
    // counterfactual — an honest zero rather than a silent one.
    const plan = await planFor(`{ role: "Help.", quality: "best", memory: false }`);
    const stub = stubModel([{ text: "Five days." }]);
    await new BuiltinHarness({ stateDir: state, fetch: stub.fetch }).ask(plan, "how long?");

    const [row] = await rowsFor("a");
    expect(row?.propensity).toBe(1);
    expect(row?.explored).toBe(false);
    expect(stub.calls[0]?.model).toBe("small");
  });

  it("reaches the harness from the app's own config, rather than being a setting nothing reads", async () => {
    const plan = await planFor(`{ role: "Help.", quality: "best", memory: false }`);
    const stub = stubModel([{ text: "Five days." }, { text: "Five days." }]);
    const harness = await resolveHarness({
      root: state,
      config: { explore: 0.05 },
      fetch: stub.fetch,
      random: () => 0,
    });

    await harness.ask(plan, "how long?");
    expect(stub.calls[0]?.model).toBe("mid");
  });

  it("sends a randomised request elsewhere, says so, and writes down how likely that was", async () => {
    const plan = await planFor(`{ role: "Help.", quality: "best", memory: false }`);
    const stub = stubModel([{ text: "Five days." }, { text: "Five days." }]);
    const answer = await new BuiltinHarness({
      stateDir: state,
      fetch: stub.fetch,
      explore: 0.05,
      random: () => 0,
    }).ask(plan, "how long?");

    // A trivial question the estimate would have sent to the cheapest rung.
    expect(stub.calls[0]?.model).toBe("mid");
    expect(answer.notes?.join(" ")).toContain("at random");

    const [row] = await rowsFor("a");
    expect(row?.explored).toBe(true);
    expect(row?.propensity).toBe(0.05);
    expect(row?.entry).toBe(1);
  });
});
