import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { planAgent } from "../src/compile/plan.js";
import { loadProject } from "../src/project/load.js";
import { BuiltinHarness } from "../src/harness/builtin.js";
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

  it("starts at a stronger model when the request is large enough to warrant it", async () => {
    const plan = await planFor(`{ role: "Help.", quality: "balanced", memory: false }`);
    const stub = stubModel([{ text: "A considered answer." }]);
    const harness = new BuiltinHarness({ stateDir: state, fetch: stub.fetch });

    const answer = await harness.ask(plan, long(2500), {
      history: Array.from({ length: 8 }, () => ({ role: "user", content: "prior" }) as Message),
    });

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

  it("survives one provider failing by trying the next rung", async () => {
    const plan = await planFor(`{ role: "Help.", quality: "balanced", memory: false }`);
    let call = 0;
    const impl = (async () => {
      call++;
      if (call === 1) return new Response("upstream is down", { status: 500 });
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
