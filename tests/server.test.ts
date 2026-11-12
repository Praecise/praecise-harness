import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { serve, type DevServer } from "../src/server/index.js";
import { mcpHeaders, mcpRequest } from "../src/harness/mcp.js";
import { MODEL_ENV, TEST_ENDPOINT, TEST_TOKEN, authed, cleanup, FRAMEWORK, makeProject, stubModel } from "./helpers.js";

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

  server = await serve({ root, port: 0, watch: false, env: MODEL_ENV, fetch: stub.fetch, token: TEST_TOKEN });
});

afterAll(async () => {
  await server?.close();
  await cleanup(root);
});

const get = (path: string) => fetch(`http://127.0.0.1:${server.port}${path}`, { headers: authed() });
const post = (path: string, body: unknown) =>
  fetch(`http://127.0.0.1:${server.port}${path}`, {
    method: "POST",
    headers: authed({ "content-type": "application/json" }),
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

  it("approves only on a literal true, and records who signed and on which channel", async () => {
    const run = await startGated();
    const res = await post(`/api/runs/${run.id}`, { approved: true, approver: "cfo@acme" });
    expect(res.status).toBe(200);
    const approved = (await res.json()) as {
      status: string;
      approvals?: { step: string; approver?: string; signature?: string; unsigned?: boolean; channel?: string }[];
    };
    expect(approved.status).toBe("done");
    expect(approved.approvals?.[0]).toMatchObject({ step: "gate", approver: "cfo@acme" });
    // No signer is wired here, so nothing signature-shaped is invented.
    expect(approved.approvals?.[0]?.signature).toBeUndefined();
    expect(approved.approvals?.[0]?.unsigned).toBe(true);
    // And the record says where the decision came in from.
    expect(approved.approvals?.[0]?.channel).toBe("http");
  });
});

describe("MCP", () => {
  // Sent the way a conforming client sends them — body AND the headers that mirror it.
  // The server compares the two and refuses a disagreement, so a test that posts a bare
  // body is testing a request no real client would make.
  const rpc = (method: string, params?: Record<string, unknown>) =>
    fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: authed(mcpHeaders(method, params)),
      body: JSON.stringify(mcpRequest(method, params)),
    });

  it("answers discovery with the revision it implements", async () => {
    const reply = (await (await rpc("server/discover")).json()) as {
      result: { protocolVersions: string[]; serverInfo: { name: string } };
    };
    expect(reply.result.serverInfo.name).toBe("acme");
    expect(reply.result.protocolVersions).toContain("2026-07-28");
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
    const res = await post("/mcp", { jsonrpc: "2.0", method: "notifications/cancelled", params: {} });
    expect(res.status).toBe(202);
  });

  it("rejects an unknown method", async () => {
    const reply = (await (await rpc("nonsense")).json()) as { error: { code: number } };
    expect(reply.error.code).toBe(-32601);
  });
});

describe("A2A", () => {
  it("serves the agent card at the well-known path, without a credential", async () => {
    // Discovery is how a peer learns which credential to present, so gating the card
    // behind that credential is a loop nobody can enter. This is the protocol's own
    // asymmetry, and the reason the card's skill list is filtered instead.
    const res = await fetch(`http://127.0.0.1:${server.port}/.well-known/agent-card.json`);
    expect(res.status).toBe(200);

    const card = (await res.json()) as {
      supportedInterfaces: { url: string; protocolBinding: string; protocolVersion: string }[];
      skills: unknown[];
    };
    // JSON-RPC in both versions, and HTTP+JSON in the current one, all at one address.
    expect(card.supportedInterfaces.map((entry) => `${entry.protocolBinding} ${entry.protocolVersion}`)).toEqual([
      "JSONRPC 1.0",
      "HTTP+JSON 1.0",
      "JSONRPC 0.3",
    ]);
    expect(new Set(card.supportedInterfaces.map((entry) => entry.url)).size).toBe(1);
    expect(card.supportedInterfaces[0]?.url).toBe(`http://127.0.0.1:${server.port}/a2a`);
    expect(Array.isArray(card.skills)).toBe(true);
  });

  it("serves the card so that a client can keep it and ask whether it is still good", async () => {
    const at = `http://127.0.0.1:${server.port}/.well-known/agent-card.json`;
    const res = await fetch(at);
    const etag = res.headers.get("etag");

    expect(etag).toMatch(/^"[\w-]+"$/);
    // Anyone may hold the anonymous card; it says nothing a stranger could not fetch.
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(res.headers.get("vary")).toContain("A2A-Version");

    const again = await fetch(at, { headers: { "if-none-match": etag! } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    expect(again.headers.get("etag")).toBe(etag);

    // What a caller with the credential sees may list more, so it is theirs alone to keep.
    const known = await fetch(at, { headers: authed() });
    expect(known.headers.get("cache-control")).toBe("private, max-age=300");
  });

  it("gives a client that says it speaks 0.3 the card 0.3 reads", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/.well-known/agent-card.json`, {
      headers: { "a2a-version": "0.3" },
    });
    const card = (await res.json()) as { protocolVersion: string; url: string; preferredTransport: string };
    expect(card.protocolVersion).toBe("0.3.0");
    expect(card.url).toBe(`http://127.0.0.1:${server.port}/a2a`);
    expect(card.preferredTransport).toBe("JSONRPC");
  });

  it("still gates the endpoint the card points at", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/a2a`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tasks/list", params: {} }),
    });
    expect(res.status).toBe(401);
  });

  const a2a = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${server.port}/a2a`, {
      method: "POST",
      headers: authed({ "content-type": "application/json", ...headers }),
      body: JSON.stringify(body),
    });
  const hello = { messageId: "m-1", role: "ROLE_USER", parts: [{ text: "hello" }], metadata: { skillId: "support" } };

  it("runs a published skill through SendMessage", async () => {
    const res = await a2a({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: hello } }, { "a2a-version": "1.0" });
    expect(res.status).toBe(200);

    const reply = (await res.json()) as {
      result: { task: { status: { state: string; message: { parts: { text: string }[] } } } };
    };
    expect(reply.result.task.status.state).toBe("TASK_STATE_COMPLETED");
    expect(reply.result.task.status.message.parts[0]?.text).toBeTruthy();
  });

  it("takes and answers in A2A's own media type, and in plain JSON for a caller that sent that", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ListTasks", params: {} });
    const own = await fetch(`http://127.0.0.1:${server.port}/a2a`, {
      method: "POST",
      headers: authed({ "content-type": "application/a2a+json" }),
      body,
    });
    expect(own.status).toBe(200);
    expect(own.headers.get("content-type")).toBe("application/a2a+json");

    const plain = await a2a({ jsonrpc: "2.0", id: 1, method: "ListTasks", params: {} });
    expect(plain.headers.get("content-type")).toBe("application/json");

    // The rule the content type exists for is unchanged: a type a browser can send
    // across origins without a preflight is still refused.
    const simple = await fetch(`http://127.0.0.1:${server.port}/a2a`, {
      method: "POST",
      headers: authed({ "content-type": "text/plain" }),
      body,
    });
    expect(simple.status).toBe(415);
  });

  it("refuses a version it does not speak, read from the request's header", async () => {
    const res = await a2a({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: hello } }, { "a2a-version": "2.0" });
    const reply = (await res.json()) as { error: { code: number } };
    expect(reply.error.code).toBe(-32009);
  });

  it("still answers a 0.3 caller, which sends no version and the old method name", async () => {
    const res = await a2a({
      jsonrpc: "2.0",
      id: 1,
      method: "message/send",
      params: {
        message: {
          kind: "message",
          messageId: "m-1",
          role: "user",
          parts: [{ kind: "text", text: "hello" }],
          metadata: { skillId: "support" },
        },
      },
    });
    const reply = (await res.json()) as {
      result: { kind: string; status: { state: string; message: { parts: { kind: string; text: string }[] } } };
    };
    expect(reply.result.kind).toBe("task");
    expect(reply.result.status.state).toBe("completed");
    expect(reply.result.status.message.parts[0]?.kind).toBe("text");
  });

  it("finds the task again on a later request, which is what a task is for", async () => {
    // Two separate HTTP requests: this is the check that the store outlives the request
    // that created it, rather than being rebuilt per call.
    const made = (await (
      await a2a({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: { ...hello, messageId: "m-2" } } })
    ).json()) as { result: { task: { id: string } } };

    const found = (await (
      await a2a({ jsonrpc: "2.0", id: 2, method: "GetTask", params: { id: made.result.task.id } })
    ).json()) as { result: { id: string } };

    expect(found.result.id).toBe(made.result.task.id);
  });

  it("answers SendStreamingMessage as server-sent events, one JSON-RPC response each", async () => {
    const res = await a2a({ jsonrpc: "2.0", id: 7, method: "SendStreamingMessage", params: { message: hello } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const frames = (await res.text())
      .split("\n\n")
      .filter((frame) => frame.startsWith("data: "))
      .map((frame) => JSON.parse(frame.slice("data: ".length)) as { jsonrpc: string; id: number; result: Record<string, any> });

    expect(frames.every((frame) => frame.jsonrpc === "2.0" && frame.id === 7)).toBe(true);
    expect(frames[0]?.result.task.status.state).toBe("TASK_STATE_WORKING");
    expect(frames.some((frame) => frame.result.artifactUpdate)).toBe(true);
    expect(frames.at(-1)?.result.statusUpdate.status.state).toBe("TASK_STATE_COMPLETED");
  });

  it("answers a stream it refuses as an ordinary reply, not as a stream of one error", async () => {
    const res = await a2a({ jsonrpc: "2.0", id: 1, method: "SubscribeToTask", params: { id: "task-nope" } });
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32001);
  });
});

describe("AG-UI streaming", () => {
  const stream = async (query: string) => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/agents/support${query}`, {
      method: "POST",
      headers: authed({ "content-type": "application/json", accept: "text/event-stream" }),
      body: JSON.stringify({ input: "hello" }),
    });
    return { status: res.status, body: await res.text() };
  };

  it("speaks praecise's own events by default, so nothing that worked stops working", async () => {
    const { body } = await stream("");
    // No named SSE events: a browser `EventSource` on `onmessage` still receives these.
    expect(body).not.toContain("event: ");
    expect(body).toContain("data: ");
  });

  it("speaks AG-UI when asked, with named frames a client dispatches on", async () => {
    const { status, body } = await stream("?protocol=ag-ui");
    expect(status).toBe(200);
    expect(body).toContain("event: RUN_STARTED");
    // A message is bracketed, so a renderer knows where the bubble opens and closes.
    expect(body).toContain("event: TEXT_MESSAGE_START");
    expect(body).toContain("event: TEXT_MESSAGE_END");
    expect(body).toContain("event: RUN_FINISHED");
  });

  it("filters to the modes the caller asked for", async () => {
    const { body } = await stream("?protocol=ag-ui&stream=messages");
    expect(body).toContain("event: TEXT_MESSAGE_CONTENT");
    // `updates` was not asked for, so how the answer was routed does not appear.
    expect(body).not.toContain("event: STEP_STARTED");
  });
});

describe("AG-UI interrupts", () => {
  type Frame = { type: string; [field: string]: unknown };
  type Interrupt = { id: string; reason: string; message: string; responseSchema: { required: string[] } };

  /** POST a workflow as an AG-UI stream, and read the frames back. */
  const run = async (name: string, body: unknown, on: DevServer = server) => {
    const res = await fetch(`http://127.0.0.1:${on.port}/api/workflows/${name}?protocol=ag-ui`, {
      method: "POST",
      headers: authed({ "content-type": "application/json", accept: "text/event-stream" }),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const frames = text
      .split("\n\n")
      .filter((frame) => frame.includes("data: "))
      .map((frame) => JSON.parse(frame.slice(frame.indexOf("data: ") + 6)) as Frame);
    return { status: res.status, text, frames, last: frames.at(-1) };
  };

  /** Start `ship` and return the interrupt it stopped at. */
  const stopped = async (on: DevServer = server) => {
    const { last } = await run("ship", { input: { what: "the release" } }, on);
    return (last!.outcome as { interrupts: Interrupt[] }).interrupts[0]!;
  };

  const record = async (interruptId: string, on: DevServer = server) => {
    const id = interruptId.slice(0, interruptId.lastIndexOf(":"));
    const all = (await (
      await fetch(`http://127.0.0.1:${on.port}/api/runs`, { headers: authed() })
    ).json()) as {
      id: string;
      status: string;
      result?: unknown;
      approvals?: { step: string; approved?: boolean; approver?: string; channel?: string; subject?: string }[];
    }[];
    return all.find((entry) => entry.id === id)!;
  };

  it("ends a run that stops at a gate with RUN_FINISHED carrying the interrupt", async () => {
    const { status, frames, last } = await run("ship", { input: { what: "the release" }, threadId: "thread-7" });
    expect(status).toBe(200);
    expect(frames[0]).toMatchObject({ type: "RUN_STARTED", threadId: "thread-7" });
    expect(last).toMatchObject({ type: "RUN_FINISHED", threadId: "thread-7", runId: frames[0]!.runId });

    const outcome = last!.outcome as { type: string; interrupts: Interrupt[] };
    expect(outcome.type).toBe("interrupt");
    expect(outcome.interrupts).toHaveLength(1);
    const interrupt = outcome.interrupts[0]!;
    // The run and the gate together: the id is what the answer comes back under.
    expect(interrupt.id).toBe(`${frames[0]!.runId}:gate`);
    expect(interrupt.reason).toBe("approval");
    expect(interrupt.message).toBe("Ship the release?");
    expect(interrupt.responseSchema.required).toEqual(["approved"]);
    expect((await record(interrupt.id)).status).toBe("waiting");
  });

  it("ends a run with no gate in it with success, as before", async () => {
    const { last, text } = await run("greet", { input: { who: "Ada" } });
    expect(last).toMatchObject({ type: "RUN_FINISHED", outcome: { type: "success" } });
    expect(text).toContain("event: STEP_FINISHED");
  });

  it("carries the run on when the interrupt is resolved with an approval, recorded as arriving on ag-ui", async () => {
    const interrupt = await stopped();
    const { frames, last } = await run("ship", {
      resume: [{ interruptId: interrupt.id, status: "resolved", payload: { approved: true, approver: "cfo@acme" } }],
    });

    expect(frames[0]!.type).toBe("RUN_STARTED");
    // Only this stretch: the steps before the gate were the last stream's to report.
    expect(frames.filter((frame) => frame.type === "STEP_STARTED").map((frame) => frame.stepName)).toEqual(["after"]);
    expect(last).toMatchObject({ type: "RUN_FINISHED", outcome: { type: "success" } });

    const after = await record(interrupt.id);
    expect(after.status).toBe("done");
    expect(after.approvals?.[0]).toMatchObject({ step: "gate", approver: "cfo@acme", approved: true, channel: "ag-ui" });
  });

  it("ends the run as refused when the interrupt is cancelled, even if the payload says approved", async () => {
    const interrupt = await stopped();
    const { last } = await run("ship", {
      resume: [{ interruptId: interrupt.id, status: "cancelled", payload: { approved: true, note: "not today" } }],
    });
    expect(last).toMatchObject({ type: "RUN_FINISHED", outcome: { type: "success" } });

    const after = await record(interrupt.id);
    expect(after.status).toBe("done");
    expect(after.result).toMatchObject({ approved: false, note: "not today" });
    expect(after.approvals?.[0]).toMatchObject({ step: "gate", approved: false, channel: "ag-ui" });
  });

  it("refuses a resolved interrupt that does not say true or false, exactly as the approval endpoint does", async () => {
    const interrupt = await stopped();
    for (const payload of [{}, { approved: "yes" }, { approved: 1 }, { note: "lgtm" }]) {
      const { status, text } = await run("ship", {
        resume: [{ interruptId: interrupt.id, status: "resolved", payload }],
      });
      expect(status).toBe(400);
      expect(text).toContain("approved must be true or false");
    }
    expect((await record(interrupt.id)).status).toBe("waiting");
  });

  it("refuses an answer to an interrupt that is no longer open", async () => {
    const interrupt = await stopped();
    const answer = { resume: [{ interruptId: interrupt.id, status: "resolved", payload: { approved: true } }] };
    expect((await run("ship", answer)).status).toBe(200);

    const again = await run("ship", answer);
    expect(again.status).toBe(400);
    expect(again.text).toContain("no open interrupt");
  });

  describe("on an app that has said where its gates answer", () => {
    let strict: DevServer;
    let strictRoot: string;

    beforeAll(async () => {
      strictRoot = await makeProject({
        "praecise.config.ts": `import { defineConfig } from "${FRAMEWORK}";
          export default defineConfig({ name: "acme", quality: "fast", ${TEST_ENDPOINT} });`,
        "workflows/ship.ts": `import { workflow } from "${FRAMEWORK}";
          export default workflow({
            description: "Ship something, once two people say so.",
            input: { what: "what to ship" },
            steps: [{ id: "gate", approve: "Ship {{what}}?", requires: { quorum: 2 } }],
          });`,
      });
      strict = await serve({
        root: strictRoot,
        port: 0,
        watch: false,
        env: MODEL_ENV,
        fetch: stub.fetch,
        token: TEST_TOKEN,
        approvals: {
          // A signature is good when it is the approver's name backwards. Enough to tell
          // a checked identity from a typed one.
          verify: async (claim, signature) =>
            signature === [...(claim.approver ?? "")].reverse().join("") ? claim.approver : undefined,
          channels: ["ag-ui"],
        },
      });
    });

    afterAll(async () => {
      await strict?.close();
      await cleanup(strictRoot);
    });

    const answer = (interruptId: string, payload: Record<string, unknown>) =>
      run("ship", { resume: [{ interruptId, status: "resolved", payload }] }, strict);

    it("holds an AG-UI answer to the same signature and identity rules as any other", async () => {
      const interrupt = await stopped(strict);
      const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        // A name nobody proved does not count toward a quorum.
        const unsigned = await answer(interrupt.id, { approved: true, approver: "ada" });
        expect(unsigned.last).toMatchObject({ type: "RUN_ERROR" });
        expect(String(unsigned.last!.message)).toContain("signature");

        // Nor does a signature that does not verify.
        const forged = await answer(interrupt.id, { approved: true, approver: "ada", signature: "nope", at: 1 });
        expect(forged.last).toMatchObject({ type: "RUN_ERROR" });
        expect((await record(interrupt.id, strict)).status).toBe("waiting");
      } finally {
        quiet.mockRestore();
      }

      // One proved approver of two: still waiting, and the stream says so as an interrupt.
      const first = await answer(interrupt.id, { approved: true, approver: "ada", signature: "ada", at: 1 });
      expect(first.last).toMatchObject({
        type: "RUN_FINISHED",
        outcome: { type: "interrupt", interrupts: [{ id: interrupt.id }] },
      });

      const second = await answer(interrupt.id, { approved: true, approver: "bob", signature: "bob", at: 2 });
      expect(second.last).toMatchObject({ type: "RUN_FINISHED", outcome: { type: "success" } });
      const after = await record(interrupt.id, strict);
      expect(after.status).toBe("done");
      expect(after.approvals?.map((entry) => [entry.subject, entry.channel])).toEqual([
        ["ada", "ag-ui"],
        ["bob", "ag-ui"],
      ]);
    });

    it("lets an app keep its gates off AG-UI, as it can off http", async () => {
      // The same project as the rest of this file, served by an app whose gates answer
      // only on a channel no request can arrive on.
      const elsewhere = await serve({
        root,
        port: 0,
        watch: false,
        env: MODEL_ENV,
        fetch: stub.fetch,
        token: TEST_TOKEN,
        approvals: { channels: ["cli"] },
      });
      const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const interrupt = await stopped(elsewhere);
        const refused = await run(
          "ship",
          { resume: [{ interruptId: interrupt.id, status: "resolved", payload: { approved: true } }] },
          elsewhere,
        );
        expect(refused.last).toMatchObject({ type: "RUN_ERROR" });
        expect(String(refused.last!.message)).toContain('this one arrived on "ag-ui"');
        // Refused, not consumed: the gate is still there for whoever may answer it.
        expect((await record(interrupt.id, elsewhere)).status).toBe("waiting");
      } finally {
        quiet.mockRestore();
        await elsewhere.close();
      }
    });
  });
});

describe("the traces view", () => {
  it("shows nothing before anything has run, without pretending otherwise", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/traces`, { headers: authed() });
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  it("records the spans a request produced, with tokens and timing", async () => {
    // The gap this closes: praecise emitted OpenTelemetry spans into a tracer nobody in
    // development had configured, so the data existed and nothing rendered it.
    await post("/api/agents/support", { input: "hello" });

    const traces = (await (await fetch(`http://127.0.0.1:${server.port}/api/traces`, { headers: authed() })).json()) as {
      traceId: string;
      spans: { name: string; attributes: Record<string, unknown> }[];
      outputTokens: number;
      duration: number;
    }[];

    expect(traces.length).toBeGreaterThan(0);
    const chat = traces[0]!.spans.find((span) => span.name.startsWith("chat "));
    expect(chat).toBeDefined();
    // The convention's own attribute names, so a collector understands them unchanged.
    expect(chat?.attributes["gen_ai.operation.name"]).toBe("chat");
    expect(chat?.attributes["gen_ai.provider.name"]).toBeTruthy();
    expect(traces[0]!.outputTokens).toBeGreaterThan(0);
    expect(traces[0]!.duration).toBeGreaterThanOrEqual(0);
  });

  it("renders a timeline a person can look at", async () => {
    await post("/api/agents/support", { input: "hello again" });
    const html = await (await fetch(`http://127.0.0.1:${server.port}/traces`, { headers: authed() })).text();

    expect(html).toContain("Traces");
    // A bar per span, positioned within its own trace's width.
    expect(html).toMatch(/left:\d+\.\d+%/);
    expect(html).toContain("tok");
  });

  it("is behind the same credential as everything else", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/traces`);
    expect(res.status).toBe(401);
  });
});

describe("trace context on the way in", () => {
  it("joins the trace a caller arrived inside, rather than starting a new one", async () => {
    // praecise propagated trace context outbound from the day it emitted spans and
    // ignored it inbound, so a request that was already half of somebody's trace started
    // a fresh one here — and the two halves sat in a collector as unrelated records of
    // the same work, which is the failure distributed tracing exists to prevent.
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    await fetch(`http://127.0.0.1:${server.port}/api/agents/support`, {
      method: "POST",
      headers: authed({
        "content-type": "application/json",
        traceparent: `00-${traceId}-00f067aa0ba902b7-01`,
      }),
      body: JSON.stringify({ input: "hello" }),
    });

    const traces = (await (
      await fetch(`http://127.0.0.1:${server.port}/api/traces`, { headers: authed() })
    ).json()) as { traceId: string; spans: { parentSpanId?: string }[] }[];

    const joined = traces.find((trace) => trace.traceId === traceId);
    expect(joined).toBeDefined();
    // And the work sits UNDER the caller's span rather than beside it.
    expect(joined?.spans.some((span) => span.parentSpanId === "00f067aa0ba902b7")).toBe(true);
  });

  it("starts its own trace when the header is malformed rather than inventing one", async () => {
    // A trace that looks joined and is not is worse than an obviously separate one,
    // because nobody investigates it.
    const before = (await (
      await fetch(`http://127.0.0.1:${server.port}/api/traces`, { headers: authed() })
    ).json()) as unknown[];

    await fetch(`http://127.0.0.1:${server.port}/api/agents/support`, {
      method: "POST",
      headers: authed({ "content-type": "application/json", traceparent: "garbage" }),
      body: JSON.stringify({ input: "hello" }),
    });

    const after = (await (
      await fetch(`http://127.0.0.1:${server.port}/api/traces`, { headers: authed() })
    ).json()) as unknown[];

    expect(after.length).toBeGreaterThan(before.length);
  });
});
