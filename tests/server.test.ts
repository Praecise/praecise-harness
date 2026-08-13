import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { serve, type DevServer } from "../src/server/index.js";
import { MODEL_ENV, TEST_ENDPOINT, cleanup, FRAMEWORK, makeProject, stubModel } from "./helpers.js";

let server: DevServer;
let root: string;

const stub = stubModel(
  Array.from({ length: 20 }, () => ({ text: `a stub answer` })),
);

beforeAll(async () => {
  root = await makeProject({
    "praecise.config.ts": `import { defineConfig } from "${FRAMEWORK}";
      export default defineConfig({ name: "acme", quality: "fast", ${TEST_ENDPOINT} });`,
    "agents/support.ts": `import { agent } from "${FRAMEWORK}";
      export default agent({ role: "Support for Acme.", description: "Answers customer questions." });`,
    "workflows/greet.ts": `import { workflow } from "${FRAMEWORK}";
      export default workflow({
        description: "Greet someone.",
        input: { who: "who to greet" },
        steps: [{ id: "hello", ask: "Say hello to {{who}}" }],
      });`,
    "workflows/ship.ts": `import { workflow } from "${FRAMEWORK}";
      export default workflow({
        description: "Ship something, once a person says so.",
        input: { what: "what to ship" },
        steps: [{ id: "gate", approve: "Ship {{what}}?" }, { id: "after", ask: "confirm the shipment" }],
      });`,
    "memory/faq.md": "Refunds take five business days.",
  });

  server = await serve({ root, port: 0, watch: false, env: MODEL_ENV, fetch: stub.fetch });
});

afterAll(async () => {
  await server?.close();
  await cleanup(root);
});

const get = (path: string) => fetch(`http://127.0.0.1:${server.port}${path}`);
const post = (path: string, body: unknown) =>
  fetch(`http://127.0.0.1:${server.port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("pages", () => {
  it("serves a dashboard listing the agents and workflows", async () => {
    const html = await (await get("/")).text();
    expect(html).toContain("acme");
    expect(html).toContain("Answers customer questions.");
    expect(html).toContain("/w/greet");
  });

  it("serves a chat page per agent", async () => {
    const res = await get("/support");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("/api/agents/");
  });

  it("serves a run page per workflow", async () => {
    const html = await (await get("/w/greet")).text();
    expect(html).toContain("who to greet");
  });

  it("404s an unknown agent without crashing", async () => {
    expect((await get("/nope")).status).toBe(404);
  });
});

describe("REST", () => {
  it("answers an agent", async () => {
    const res = await post("/api/agents/support", { input: "how long do refunds take?" });
    expect(res.status).toBe(200);
    const answer = (await res.json()) as { text: string; path: string[] };
    expect(answer.text).toBe("a stub answer");
    expect(answer.path[0]).toBe("house/small");
  });

  it("rejects an empty input", async () => {
    expect((await post("/api/agents/support", {})).status).toBe(400);
  });

  it("reports an unknown agent as nothing at that address", async () => {
    const res = await post("/api/agents/ghost", { input: "hi" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toMatch(/no agent/);
  });

  it("runs a workflow and returns the run", async () => {
    const res = await post("/api/workflows/greet", { input: { who: "Ada" } });
    const run = (await res.json()) as { status: string; result: unknown };
    expect(run.status).toBe("done");
    expect(run.result).toBe("a stub answer");
  });

  it("lists runs", async () => {
    // Makes its own run: listing must not depend on another test having gone first.
    await post("/api/workflows/greet", { input: { who: "Grace" } });
    const runs = (await (await get("/api/runs")).json()) as unknown[];
    expect(runs.length).toBeGreaterThan(0);
  });

  it("reports what the app contains", async () => {
    const health = (await (await get("/health")).json()) as {
      agents: string[];
      workflows: string[];
    };
    expect(health.agents).toEqual(["support"]);
    expect(health.workflows).toEqual(["greet", "ship"]);
  });
});

describe("approval over HTTP", () => {
  const startGated = async () => {
    const res = await post("/api/workflows/ship", { input: { what: "v2" } });
    return (await res.json()) as { id: string; status: string };
  };

  it("refuses a body that does not say true or false — an empty POST must not approve the gate", async () => {
    const run = await startGated();
    expect(run.status).toBe("waiting");

    for (const body of [{}, { approved: "yes" }, { approved: 1 }, { note: "lgtm" }]) {
      const res = await post(`/api/runs/${run.id}`, body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/true or false/);
    }

    // The gate still stands: nothing above was an approval.
    const runs = (await (await get("/api/runs")).json()) as { id: string; status: string }[];
    expect(runs.find((r) => r.id === run.id)?.status).toBe("waiting");
  });

  it("carries the approver through to the ledger on an explicit decision", async () => {
    const run = await startGated();
    const res = await post(`/api/runs/${run.id}`, { approved: false, approver: "sec@acme", note: "hold" });
    expect(res.status).toBe(200);
    const rejected = (await res.json()) as {
      status: string;
      result: unknown;
      approvals?: { step: string; approver?: string; approved?: boolean }[];
    };
    expect(rejected.status).toBe("done");
    expect(rejected.result).toMatchObject({ approved: false });
    expect(rejected.approvals?.[0]).toMatchObject({ step: "gate", approver: "sec@acme", approved: false });
  });

  it("approves only on a literal true, and records who signed", async () => {
    const run = await startGated();
    const res = await post(`/api/runs/${run.id}`, { approved: true, approver: "cfo@acme" });
    expect(res.status).toBe(200);
    const approved = (await res.json()) as {
      status: string;
      approvals?: { step: string; approver?: string; signature?: string }[];
    };
    expect(approved.status).toBe("done");
    expect(approved.approvals?.[0]).toMatchObject({ step: "gate", approver: "cfo@acme" });
    expect(approved.approvals?.[0]?.signature).toMatch(/^sig-stub:/);
  });
});

describe("MCP", () => {
  const rpc = (method: string, params?: unknown) =>
    post("/mcp", { jsonrpc: "2.0", id: 1, method, params });

  it("completes the handshake", async () => {
    const reply = (await (await rpc("initialize")).json()) as {
      result: { protocolVersion: string; serverInfo: { name: string } };
    };
    expect(reply.result.serverInfo.name).toBe("acme");
    expect(reply.result.protocolVersion).toBeTruthy();
  });

  it("publishes every agent and workflow as a tool", async () => {
    const reply = (await (await rpc("tools/list")).json()) as {
      result: { tools: { name: string; inputSchema: { required?: string[] } }[] };
    };
    const names = reply.result.tools.map((tool) => tool.name);
    expect(names).toContain("support");
    expect(names).toContain("greet");
    expect(reply.result.tools.find((t) => t.name === "greet")?.inputSchema.required).toEqual(["who"]);
  });

  it("calls an agent through tools/call", async () => {
    const reply = (await (
      await rpc("tools/call", { name: "support", arguments: { input: "hi" } })
    ).json()) as { result: { content: { text: string }[]; isError: boolean } };
    expect(reply.result.isError).toBe(false);
    expect(reply.result.content[0]?.text).toBe("a stub answer");
  });

  it("reports an unknown tool as a tool error, not a protocol error", async () => {
    const reply = (await (await rpc("tools/call", { name: "ghost" })).json()) as {
      result: { isError: boolean };
    };
    expect(reply.result.isError).toBe(true);
  });

  it("takes a notification with no reply body", async () => {
    const res = await post("/mcp", { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
  });

  it("rejects an unknown method", async () => {
    const reply = (await (await rpc("nonsense")).json()) as { error: { code: number } };
    expect(reply.error.code).toBe(-32601);
  });
});
