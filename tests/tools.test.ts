import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveServices } from "../src/compile/services.js";
import { planAgent } from "../src/compile/plan.js";
import { BuiltinHarness } from "../src/harness/builtin.js";
import { contentsWire } from "../src/harness/wire/contents.js";
import { collectTools, splitToolName, toolName } from "../src/harness/mcp.js";
import { loadProject } from "../src/project/load.js";
import { MODEL_ENV, TEST_MODELS, cleanup, FRAMEWORK, makeProject } from "./helpers.js";

/** A stand-in for both an MCP server and a model endpoint on one fetch. */
function stubStack(options: { toolResult?: string; failListing?: boolean } = {}) {
  const called: { tool?: string; args?: unknown }[] = [];
  /** Every body the model was sent, so a test can see what reached the context. */
  const sent: Record<string, unknown>[] = [];
  let turn = 0;

  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;

    if (url.includes("mcp.example")) {
      if (options.failListing && body.method === "tools/list") {
        return new Response("nope", { status: 503 });
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });

      let result: unknown;
      if (body.method === "initialize") {
        result = { protocolVersion: "2025-06-18", capabilities: {} };
      } else if (body.method === "tools/list") {
        result = {
          tools: [
            {
              name: "lookup_order",
              description: "Find an order by id.",
              inputSchema: {
                type: "object",
                properties: { id: { type: "string" } },
                required: ["id"],
              },
            },
          ],
        };
      } else {
        const params = body.params as { name: string; arguments: unknown };
        called.push({ tool: params.name, args: params.arguments });
        result = {
          content: [{ type: "text", text: options.toolResult ?? "order 4021: delivered" }],
        };
      }

      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // The model: ask for the tool once, then answer using what came back.
    sent.push(body);
    turn++;
    const content =
      turn === 1
        ? [{ type: "tool_use", id: "t1", name: "acme__lookup_order", input: { id: "4021" } }]
        : [{ type: "text", text: `It was delivered.` }];

    return new Response(
      JSON.stringify({
        content,
        stop_reason: turn === 1 ? "tool_use" : "end_turn",
        usage: { input_tokens: 5, output_tokens: 5 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  return { fetch: impl, called, sent };
}

const ENV = { ...MODEL_ENV, ACME_TOKEN: "t" };
const roots: string[] = [];
let state: string;

async function project() {
  const root = await makeProject({
    ...TEST_MODELS,
    "tools/acme.ts": `import { tool } from "${FRAMEWORK}";
      export default tool({
        url: "https://mcp.example/mcp",
        credential: "ACME_TOKEN",
        description: "Acme order lookup",
      });`,
    "agents/a.ts": `import { agent } from "${FRAMEWORK}";
      export default agent({ role: "Help.", tools: ["acme"], quality: "fast", memory: false });`,
  });
  roots.push(root);
  return loadProject(root);
}

beforeEach(async () => {
  state = await mkdtemp(join(tmpdir(), "praecise-tools-"));
});

afterEach(async () => {
  await rm(state, { recursive: true, force: true });
  await Promise.all(roots.splice(0).map(cleanup));
});

describe("tool names", () => {
  it("round-trip through the namespaced form a model sees", () => {
    expect(splitToolName(toolName("acme", "lookup_order"))).toEqual({
      service: "acme",
      tool: "lookup_order",
    });
  });

  it("survives a tool name that itself contains an underscore", () => {
    expect(splitToolName(toolName("acme", "get_order_by_id"))?.tool).toBe("get_order_by_id");
  });
});

describe("resolveServices", () => {
  const billing = {
    kind: "tool" as const,
    name: "billing",
    url: "https://mine/mcp",
    credential: "BILLING_TOKEN",
  };

  it("takes the endpoint and credential from the tools/ definition", () => {
    const { services } = resolveServices(["billing"], { billing }, { BILLING_TOKEN: "k" });
    expect(services[0]).toMatchObject({ url: "https://mine/mcp", apiKey: "k" });
  });

  it("names a credential after the file when the tool did not say", () => {
    const { problems } = resolveServices(
      ["billing"],
      { billing: { kind: "tool", name: "billing", url: "https://mine/mcp" } },
      {},
    );
    expect(problems.join(" ")).toContain("BILLING_API_KEY");
  });

  it("keeps an unconfigured service so the dashboard can say so", () => {
    const { services, problems } = resolveServices(["billing"], { billing }, {});
    expect(services[0]?.apiKey).toBeUndefined();
    expect(problems.join(" ")).toContain("BILLING_TOKEN");
  });

  it("tells an unknown name where to declare itself", () => {
    const { services, problems } = resolveServices(["nonesuch"], {}, {});
    expect(services).toEqual([]);
    expect(problems.join(" ")).toContain("tools/nonesuch.ts");
  });
});

describe("collectTools", () => {
  it("namespaces every tool by its service", async () => {
    const loaded = await project();
    const plan = await planAgent(loaded, loaded.agents.a!, { env: ENV });
    const { schemas } = await collectTools(plan.services, stubStack().fetch);
    expect(schemas.map((s) => s.name)).toEqual(["acme__lookup_order"]);
  });

  it("notes an unreachable service instead of failing the request", async () => {
    const loaded = await project();
    const plan = await planAgent(loaded, loaded.agents.a!, { env: ENV });
    const { schemas, notes } = await collectTools(
      plan.services,
      stubStack({ failListing: true }).fetch,
    );
    expect(schemas).toEqual([]);
    expect(notes.join(" ")).toContain("acme");
  });
});

/**
 * The wire that carries its conversation in `contents` used to drop every
 * advertised tool on the floor and report no calls, which is the worst
 * available shape for that failure: an agent configured with tools on this wire
 * answered from memory, said nothing about it, and looked exactly like an agent
 * that had decided it did not need to look anything up. The two sibling wires
 * had carried tools all along, so nothing above here suspected the difference.
 *
 * These test the adapter directly, because the loop above it is wire-agnostic
 * and was already proved on a wire that worked.
 */
describe("the contents wire, carrying tools", () => {
  function stub(payload: unknown) {
    const sent: Record<string, unknown> = {};
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      Object.assign(sent, JSON.parse(String(init?.body ?? "{}")));
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    return { sent, fetchImpl };
  }

  const base = {
    model: "m",
    baseUrl: "https://endpoint",
    apiKey: "k",
    system: "be brief",
    effort: 0,
  };

  it("advertises what it was given, and declares a no-argument tool without a schema", async () => {
    const { sent, fetchImpl } = stub({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });

    await contentsWire({
      ...base,
      messages: [{ role: "user", content: "where is order 4021?" }],
      tools: [
        {
          name: "lookup_order",
          description: "Find an order by id.",
          parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        },
        { name: "now", description: "The current time.", parameters: { type: "object", properties: {} } },
      ],
      fetch: fetchImpl,
    });

    const declared = (sent.tools as { functionDeclarations: Record<string, unknown>[] }[])[0]
      ?.functionDeclarations;
    expect(declared?.map((d) => d.name)).toEqual(["lookup_order", "now"]);
    expect(declared?.[0]?.parameters).toBeTruthy();
    // The endpoint refuses an empty parameter object, so it is left off entirely.
    expect(declared?.[1]).not.toHaveProperty("parameters");
  });

  it("reads a requested call out of the reply", async () => {
    const { fetchImpl } = stub({
      candidates: [
        {
          content: {
            parts: [
              { text: "Let me look." },
              { functionCall: { name: "lookup_order", args: { id: "4021" } } },
            ],
          },
          finishReason: "STOP",
        },
      ],
    });

    const reply = await contentsWire({
      ...base,
      messages: [{ role: "user", content: "where is order 4021?" }],
      fetch: fetchImpl,
    });

    expect(reply.text).toBe("Let me look.");
    expect(reply.toolCalls).toEqual([
      { id: "lookup_order-0", name: "lookup_order", args: { id: "4021" } },
    ]);
  });

  it("sends back a turn that asked for a tool even though it said nothing", async () => {
    const { sent, fetchImpl } = stub({ candidates: [{ content: { parts: [{ text: "Delivered." }] } }] });

    await contentsWire({
      ...base,
      messages: [
        { role: "user", content: "where is order 4021?" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "t1", name: "lookup_order", args: { id: "4021" } }],
        },
        { role: "tool", toolCallId: "t1", name: "lookup_order", content: "order 4021: delivered" },
      ],
      fetch: fetchImpl,
    });

    // Dropping the empty assistant turn would leave a result answering a call
    // the transcript never made, and the endpoint refuses that outright.
    expect(sent.contents).toEqual([
      { role: "user", parts: [{ text: "where is order 4021?" }] },
      { role: "model", parts: [{ functionCall: { name: "lookup_order", args: { id: "4021" } } }] },
      {
        role: "user",
        parts: [
          { functionResponse: { name: "lookup_order", response: { result: "order 4021: delivered" } } },
        ],
      },
    ]);
  });

  it("carries the token attached to a call back onto the part it arrived on", async () => {
    const { fetchImpl: first } = stub({
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: { name: "lookup_order", args: { id: "4021" } },
                thoughtSignature: "opaque-token",
              },
            ],
          },
        },
      ],
    });

    const asked = await contentsWire({
      ...base,
      messages: [{ role: "user", content: "where is order 4021?" }],
      fetch: first,
    });

    expect(asked.toolCalls[0]?.seal).toBe("opaque-token");

    const { sent, fetchImpl } = stub({ candidates: [{ content: { parts: [{ text: "Delivered." }] } }] });
    await contentsWire({
      ...base,
      messages: [
        { role: "user", content: "where is order 4021?" },
        { role: "assistant", content: "", toolCalls: asked.toolCalls },
        { role: "tool", toolCallId: "t1", name: "lookup_order", content: "order 4021: delivered" },
      ],
      fetch: fetchImpl,
    });

    // Losing it costs nothing on the first call and refuses the second, so a
    // seat that looks once passes and a seat that looks twice reads as a model
    // that cannot hold a tool.
    expect((sent.contents as { parts: unknown[] }[])[1]?.parts).toEqual([
      {
        functionCall: { name: "lookup_order", args: { id: "4021" } },
        thoughtSignature: "opaque-token",
      },
    ]);
  });

  it("counts reasoning as the output it is billed as", async () => {
    const { fetchImpl } = stub({
      candidates: [{ content: { parts: [{ text: "Delivered." }] } }],
      usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7, thoughtsTokenCount: 900 },
    });

    const reply = await contentsWire({
      ...base,
      messages: [{ role: "user", content: "where is it?" }],
      fetch: fetchImpl,
    });

    // This wire reports reasoning in its own field; the other two fold it into
    // the output count already. Reading only the candidate count here would
    // price a hard request at under a hundredth of what it cost.
    expect(reply.usage.outputTokens).toBe(907);
  });

  it("reports no calls when none were asked for", async () => {
    const { fetchImpl } = stub({ candidates: [{ content: { parts: [{ text: "Delivered." }] } }] });
    const reply = await contentsWire({
      ...base,
      messages: [{ role: "user", content: "where is it?" }],
      fetch: fetchImpl,
    });
    expect(reply.toolCalls).toEqual([]);
  });
});

describe("the tool loop", () => {
  it("calls a tool and answers from the result", async () => {
    const loaded = await project();
    const plan = await planAgent(loaded, loaded.agents.a!, { env: ENV });
    const stub = stubStack();

    const answer = await new BuiltinHarness({ stateDir: state, fetch: stub.fetch }).ask(
      plan,
      "where is order 4021?",
    );

    expect(stub.called).toEqual([{ tool: "lookup_order", args: { id: "4021" } }]);
    expect(answer.toolCalls.map((c) => c.name)).toEqual(["acme__lookup_order"]);
    expect(answer.text).toBe("It was delivered.");
  });

  it("keeps one chatty tool from spending the whole context", async () => {
    const loaded = await project();
    const plan = await planAgent(loaded, loaded.agents.a!, { env: ENV });
    const stub = stubStack({ toolResult: `${"x".repeat(400_000)}THE-TAIL` });

    await new BuiltinHarness({ stateDir: state, fetch: stub.fetch }).ask(plan, "list everything");

    // The second call is the one carrying the tool result back to the model.
    const carried = JSON.stringify(stub.sent[1]);
    expect(carried.length).toBeLessThan(150_000);
    expect(carried).toContain("characters omitted");
    // The tail survives, because that is where a total or a conclusion sits.
    expect(carried).toContain("THE-TAIL");
  });
});
