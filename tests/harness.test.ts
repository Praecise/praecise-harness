import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { planAgent } from "../src/compile/plan.js";
import { loadProject } from "../src/project/load.js";
import { BuiltinHarness } from "../src/harness/builtin.js";
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

describe("BuiltinHarness", () => {
  it("stops at the cheapest model when it is confident", async () => {
    const plan = await planFor(`{ role: "Help.", quality: "best", memory: false }`);
    const stub = stubModel([{ text: `{"answer":"Five days.","confidence":0.95}` }]);
    const harness = new BuiltinHarness({ stateDir: state, fetch: stub.fetch });

    const answer = await harness.ask(plan, "how long do refunds take?");

    expect(answer.text).toBe("Five days.");
    expect(answer.path).toHaveLength(1);
    expect(stub.calls).toHaveLength(1);
  });

  it("climbs to a stronger model when the cheap one is unsure", async () => {
    const plan = await planFor(`{ role: "Help.", quality: "balanced", memory: false }`);
    const stub = stubModel([
      { text: `{"answer":"Maybe a week?","confidence":0.4}` },
      { text: `{"answer":"Five business days.","confidence":0.97}` },
    ]);
    const harness = new BuiltinHarness({ stateDir: state, fetch: stub.fetch });

    const answer = await harness.ask(plan, "how long do refunds take?");

    expect(answer.text).toBe("Five business days.");
    expect(answer.path).toHaveLength(2);
    expect(stub.calls[0]?.model).not.toBe(stub.calls[1]?.model);
    expect(answer.notes?.join(" ")).toContain("handing off");
  });

  it("hands off when the cheap model ignores the envelope format", async () => {
    const plan = await planFor(`{ role: "Help.", quality: "balanced", memory: false }`);
    const stub = stubModel([
      { text: "just prose, no json at all" },
      { text: `{"answer":"Five business days.","confidence":0.99}` },
    ]);
    const harness = new BuiltinHarness({ stateDir: state, fetch: stub.fetch });

    const answer = await harness.ask(plan, "how long?");
    expect(answer.path).toHaveLength(2);
    expect(answer.text).toBe("Five business days.");
  });

  it("carries knowledge into the system prompt", async () => {
    const plan = await planFor(`{ role: "Help.", knows: ["memory/faq.md"], memory: false }`);
    const stub = stubModel([{ text: `{"answer":"ok","confidence":1}` }]);
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
          content: [{ type: "text", text: `{"answer":"recovered","confidence":1}` }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const answer = await new BuiltinHarness({ stateDir: state, fetch: impl }).ask(plan, "hi");
    expect(answer.text).toBe("recovered");
    expect(answer.notes?.join(" ")).toContain("trying the next model");
  });

  it("answers offline, without throwing, when there is no credential", async () => {
    const plan = await planFor(`{ role: "Help." }`, {});
    const answer = await new BuiltinHarness({ stateDir: state }).ask(plan, "hi");
    expect(answer.harness).toBe("offline");
    expect(answer.text).toContain("No model endpoint is configured");
  });

  it("recalls a prior exchange on the next question", async () => {
    const plan = await planFor(`{ role: "Help.", memory: true }`);
    const stub = stubModel([
      { text: `{"answer":"Your order is 42.","confidence":1}` },
      { text: `{"answer":"still 42","confidence":1}` },
    ]);
    const harness = new BuiltinHarness({ stateDir: state, fetch: stub.fetch });

    await harness.ask(plan, "what is my order number?");
    await harness.ask(plan, "what is my order number again?");

    expect(String(stub.calls[1]?.body.system)).toContain("Your order is 42.");
  });
});
