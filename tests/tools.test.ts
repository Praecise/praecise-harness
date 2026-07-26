import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveServices } from "../src/compile/services.js";
import { planAgent } from "../src/compile/plan.js";
import { BuiltinHarness } from "../src/harness/builtin.js";
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
        : [{ type: "text", text: `{"answer":"It was delivered.","confidence":0.98}` }];

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
