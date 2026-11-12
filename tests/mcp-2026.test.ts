/**
 * What `2026-07-28` changed, and the specific ways each change fails quietly if it is
 * only half-implemented.
 *
 * The revision made MCP stateless. That reads like a simplification and is mostly the
 * opposite: everything the `initialize` handshake used to establish once now has to be
 * restated on every single request, a server is required to REFUSE a request that omits
 * it rather than assume, and three new error codes distinguish refusals that used to be
 * one opaque 400. Each test here covers something that would otherwise fail as silence.
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { App } from "../src/app.js";
import { handleMcp, type Caller } from "../src/server/mcp.js";
import { FRAMEWORK, MODEL_ENV, TEST_ENDPOINT, cleanup, makeProject, stubModel } from "./helpers.js";

import {
  InputRequired,
  McpClient,
  decodeHeaderValue,
  explain,
  headerParamsOf,
  headerValue,
  mcpHeaders,
  mcpRequest,
  nameFor,
} from "../src/harness/mcp.js";
import type { ResolvedService } from "../src/compile/services.js";

const service = (over: Partial<ResolvedService> = {}): ResolvedService =>
  ({
    name: "svc",
    url: "https://example.invalid/mcp",
    credential: "SVC_KEY",
    apiKey: "k",
    ...over,
  }) as ResolvedService;

/** A fake endpoint that records what it was sent and answers with what it was given. */
function serving(reply: (body: Record<string, unknown>) => unknown) {
  const seen: { body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    seen.push({ body, headers: init.headers as Record<string, string> });
    const result = reply(body);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { seen, client: new McpClient(service(), fetchImpl) };
}

describe("every request states the protocol, because nothing else does", () => {
  test("the three per-request fields ride on every call", async () => {
    const { seen, client } = serving(() => ({ resultType: "complete", tools: [] }));
    await client.listTools();

    const meta = (seen[0]!.body.params as { _meta: Record<string, unknown> })._meta;
    expect(meta["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
    // The one thing this client implements beyond the base protocol, and nothing else.
    expect(meta["io.modelcontextprotocol/clientCapabilities"]).toEqual({
      extensions: { "io.modelcontextprotocol/tasks": {} },
    });
    expect(meta["io.modelcontextprotocol/clientInfo"]).toEqual({ name: "praecise", version: "0.1.0" });
  });

  test("no handshake is sent before the first real request", async () => {
    // The specific regression this guards: a client that still calls `initialize` first
    // gets a method-not-found from a modern server and never reaches the request it
    // actually came to make.
    const { seen, client } = serving(() => ({ resultType: "complete", tools: [] }));
    await client.listTools();
    expect(seen.map((call) => call.body.method)).toEqual(["tools/list"]);
  });

  test("no session id is minted, kept, or echoed", async () => {
    const { seen, client } = serving(() => ({ resultType: "complete", tools: [] }));
    await client.listTools();
    await client.listTools();
    for (const call of seen) {
      expect(Object.keys(call.headers).map((h) => h.toLowerCase())).not.toContain("mcp-session-id");
    }
  });
});

describe("headers mirror the body, and a server checks that they do", () => {
  test("the required headers are on every request", () => {
    const headers = mcpHeaders("tools/call", { name: "get_weather", arguments: {} });
    expect(headers["mcp-protocol-version"]).toBe("2026-07-28");
    expect(headers["mcp-method"]).toBe("tools/call");
    expect(headers["mcp-name"]).toBe("get_weather");
  });

  test("Mcp-Name is sent only where the body has a name to mirror", () => {
    // Sending it elsewhere is not harmless: the server compares header to body, and a
    // name attached to a request whose body has no such field is a mismatch by
    // construction — a refusal caused entirely by the client being over-helpful.
    expect(mcpHeaders("tools/list", {})["mcp-name"]).toBeUndefined();
    expect(nameFor("resources/read", { uri: "file:///x" })).toBe("file:///x");
    expect(nameFor("prompts/get", { name: "triage" })).toBe("triage");
    expect(nameFor("tools/list", {})).toBeUndefined();
  });

  test("a value a header cannot carry is wrapped rather than mangled", () => {
    // A resource URI with a space or a non-Latin character is ordinary, and putting it
    // raw into a header produces either an invalid header or a splittable one.
    const awkward = "doc://Hello, 世界";
    const encoded = headerValue(awkward);
    expect(encoded.startsWith("=?base64?")).toBe(true);
    expect(decodeHeaderValue(encoded)).toBe(awkward);
  });

  test("a plain value that merely looks like the sentinel is encoded too", () => {
    // Otherwise a server decoding it would produce something the client never sent —
    // and the comparison against the body would fail for a value that was always legal.
    const mimic = "=?base64?literal?=";
    const encoded = headerValue(mimic);
    expect(encoded).not.toBe(mimic);
    expect(decodeHeaderValue(encoded)).toBe(mimic);
  });

  test("ordinary ASCII passes through untouched", () => {
    expect(headerValue("get_weather")).toBe("get_weather");
    expect(decodeHeaderValue("get_weather")).toBe("get_weather");
  });
});

describe("x-mcp-header: tool parameters the server wants in headers", () => {
  const schema = {
    type: "object",
    properties: {
      region: { type: "string", "x-mcp-header": "Region" },
      query: { type: "string" },
    },
  };

  test("an annotated argument is mirrored into its header", () => {
    const headers = mcpHeaders(
      "tools/call",
      { name: "execute_sql", arguments: { region: "us-west1", query: "SELECT 1" } },
      schema,
    );
    expect(headers["mcp-param-region"]).toBe("us-west1");
  });

  test("an argument that was not supplied sends no header at all", () => {
    // The server MUST NOT expect a header for an absent argument, so an empty one is a
    // mismatch rather than a harmless default.
    const headers = mcpHeaders("tools/call", { name: "execute_sql", arguments: { query: "SELECT 1" } }, schema);
    expect(headers["mcp-param-region"]).toBeUndefined();
  });

  test("a tool with an illegal annotation is dropped, not repaired", async () => {
    // The client MUST exclude it. An annotation names what goes into a header an
    // intermediary may route or authorise on; one that cannot be followed exactly must
    // not be followed approximately.
    const { client } = serving(() => ({
      resultType: "complete",
      tools: [
        { name: "fine", description: "", inputSchema: { type: "object", properties: {} } },
        {
          name: "broken",
          description: "",
          inputSchema: {
            type: "object",
            // `number` is excluded by the spec: 42.0 and 42 are one header value and two
            // JSON values, so a server comparing them has no unambiguous rule.
            properties: { size: { type: "number", "x-mcp-header": "Size" } },
          },
        },
      ],
    }));

    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["fine"]);
    // Dropped loudly: one bad definition must not silently shrink the surface.
    expect(client.warnings.join(" ")).toContain("broken");
  });

  test("an annotation nested where no client can read a value is rejected", () => {
    // Inside an array, a `oneOf` branch, or behind a `$ref` there is no single
    // well-defined location to read at call time.
    const { faults } = headerParamsOf({
      type: "object",
      properties: {
        rows: { type: "array", items: { type: "object", properties: { id: { type: "string", "x-mcp-header": "Id" } } } },
      },
    });
    expect(faults.length).toBeGreaterThan(0);
  });

  test("the same header claimed twice is a fault, not a last-one-wins", () => {
    const { faults } = headerParamsOf({
      type: "object",
      properties: {
        a: { type: "string", "x-mcp-header": "Tenant" },
        b: { type: "string", "x-mcp-header": "tenant" },
      },
    });
    expect(faults.join(" ")).toContain("more than once");
  });
});

describe("results say what kind of result they are", () => {
  test("an interim result is not read as an answer", async () => {
    // This is the failure the field exists to prevent: `input_required` is close enough
    // in shape to a real result that treating it as final yields an empty answer and no
    // error at all.
    const { client } = serving(() => ({
      resultType: "input_required",
      inputRequests: { github_login: { method: "elicitation/create" } },
    }));

    await expect(client.call("anything", {})).rejects.toBeInstanceOf(InputRequired);
    await expect(client.call("anything", {})).rejects.toThrow("github_login");
  });

  test("an unrecognised result type is refused rather than assumed complete", async () => {
    const { client } = serving(() => ({ resultType: "something_later", tools: [] }));
    await expect(client.listTools()).rejects.toThrow("does not recognise");
  });

  test("a complete result passes through", async () => {
    const { client } = serving(() => ({
      resultType: "complete",
      content: [{ type: "text", text: "done" }],
    }));
    expect(await client.call("t", {})).toBe("done");
  });
});

describe("the three refusals this revision defines are told apart", () => {
  test("an old server is named as an old server", () => {
    const error = explain("svc", "tools/list", {
      code: -32022,
      message: "Unsupported protocol version",
      data: { supported: ["2025-11-25", "2025-06-18"], requested: "2026-07-28" },
    });
    // The remedy is the point: "upgrade the server" rather than "MCP request failed".
    expect(error.message).toContain("2025-11-25");
    expect(error.message).toContain("upgrading");
  });

  test("a capability this client lacks is named as such", () => {
    const error = explain("svc", "tools/call", {
      code: -32021,
      message: "missing capability",
      data: { requiredCapabilities: ["sampling"] },
    });
    expect(error.message).toContain("sampling");
  });

  test("a capability named in the shape it is declared in is still named", () => {
    const error = explain("svc", "tasks/get", {
      code: -32021,
      message: "missing capability",
      data: { requiredCapabilities: { extensions: { "io.modelcontextprotocol/tasks": {} } } },
    });
    expect(error.message).toContain("io.modelcontextprotocol/tasks");
  });

  test("a header disagreement points at the schema that moved", () => {
    const error = explain("svc", "tools/call", { code: -32020, message: "Mcp-Param-Region" });
    expect(error.message).toContain("x-mcp-header");
  });

  test("a refusal carried in a 400 body is read rather than stringified", async () => {
    // A conforming server puts a NAMED refusal in the body of a 400. Reading it is the
    // difference between an actionable message and "MCP request failed (400)".
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32022, message: "Unsupported protocol version", data: { supported: ["2025-11-25"] } },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    const client = new McpClient(service(), fetchImpl);
    await expect(client.listTools()).rejects.toThrow("2025-11-25");
  });
});

describe("mcpRequest builds what a server will accept", () => {
  test("it carries the metadata a hand-built request forgets", () => {
    const request = mcpRequest("tools/list") as { params: { _meta: Record<string, unknown> } };
    expect(request.params._meta["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
    expect(request.params._meta["io.modelcontextprotocol/clientCapabilities"]).toEqual({
      extensions: { "io.modelcontextprotocol/tasks": {} },
    });
  });

  test("caller-supplied _meta survives rather than being overwritten", () => {
    const request = mcpRequest("tools/call", {
      name: "x",
      _meta: { traceparent: "00-abc-def-01" },
    }) as { params: { _meta: Record<string, unknown> } };
    expect(request.params._meta.traceparent).toBe("00-abc-def-01");
    expect(request.params._meta["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
  });
});

// ── Tasks ──────────────────────────────────────────────────────────────────────
//
// The only way work outlives a connection in this revision. Each half fails quietly if
// it is half-built: a server that hands a task to a client that cannot follow one has
// answered with something that reads as an empty result, and a client that stops
// following without saying so leaves the work running for nobody.

const TASKS = { extensions: { "io.modelcontextprotocol/tasks": {} } };

describe("a client follows a task to the result the call would have returned", () => {
  type Sent = { method: string; params: { taskId?: string } };
  const task = (over: Record<string, unknown> = {}) => ({
    resultType: "task",
    taskId: "task-1",
    status: "working",
    createdAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    ttlMs: 60_000,
    pollIntervalMs: 1,
    ...over,
  });
  const got = (over: Record<string, unknown>) => ({ ...task(over), resultType: "complete" });

  /** A server that answers `tools/call` with a task and each `tasks/get` with the next state. */
  function tasked(states: Record<string, unknown>[], created: Record<string, unknown> = {}) {
    let looked = 0;
    const { seen, client } = serving((body) => {
      if (body.method === "tools/call") return task(created);
      if (body.method === "tasks/get") return got(states[Math.min(looked++, states.length - 1)]!);
      return { resultType: "complete" };
    });
    const sent = (): Sent[] => seen.map((call) => call.body as unknown as Sent);
    return { client, sent };
  }

  test("it polls until the task completes, and reads the result as it reads any other", async () => {
    const { client, sent } = tasked([
      { status: "working", statusMessage: "drafting" },
      {
        status: "completed",
        result: {
          content: [
            { type: "text", text: "done" },
            { type: "image", data: "AAAA", mimeType: "image/png" },
          ],
          isError: false,
        },
      },
    ]);
    const progress: string[] = [];
    const media: string[] = [];

    const text = await client.call("slow", {}, {
      onProgress: (event) => progress.push(event.message ?? ""),
      media: (attachment) => media.push(attachment.mime),
    });

    expect(text).toBe("done\n[attached: image/png]");
    expect(media).toEqual(["image/png"]);
    expect(progress).toContain("drafting");
    expect(sent().map((call) => call.method)).toEqual(["tools/call", "tasks/get", "tasks/get"]);
    expect(sent()[1]!.params.taskId).toBe("task-1");
  });

  test("structured content survives the detour through a task", async () => {
    const { client } = tasked([
      { status: "completed", result: { content: [{ type: "text", text: "n is 1" }], structuredContent: { n: 1 } } },
    ]);
    expect(await client.call("slow", {})).toBe('{"n":1}');
  });

  test("a caller that stops waiting cancels the task, since closing a connection stops nothing", async () => {
    const { client, sent } = tasked([{ status: "working" }], { pollIntervalMs: 5 });
    const stop = new AbortController();
    setTimeout(() => stop.abort(new Error("the user left")), 30);

    await expect(client.call("slow", {}, { signal: stop.signal })).rejects.toThrow(/cancelled: the user left/);

    const cancel = sent().find((call) => call.method === "tasks/cancel");
    expect(cancel?.params.taskId).toBe("task-1");
    // Never the notification: that one is for a request, and a task is not a request.
    expect(sent().map((call) => call.method)).not.toContain("notifications/cancelled");
  });

  test("a failed task throws what the server said went wrong", async () => {
    const { client } = tasked([{ status: "failed", statusMessage: "it broke", error: { code: -32603, message: "the ledger was closed" } }]);
    await expect(client.call("slow", {})).rejects.toThrow("the ledger was closed");
  });

  test("a task the server cancelled is not read as an empty answer", async () => {
    const { client } = tasked([{ status: "cancelled", statusMessage: "shutting down" }]);
    await expect(client.call("slow", {})).rejects.toThrow(/cancelled the task.*shutting down/);
  });

  test("it stops at the task's lifetime, because the server has discarded it by then", async () => {
    const { client, sent } = tasked([{ status: "working" }], { ttlMs: 40, pollIntervalMs: 5 });
    const began = Date.now();

    await expect(client.call("slow", {})).rejects.toThrow(/lifetime ended \(ttlMs 40\)/);

    expect(Date.now() - began).toBeLessThan(2_000);
    expect(sent().some((call) => call.method === "tasks/get")).toBe(true);
  });

  test("a task with no lifetime is followed for as long as it takes", async () => {
    const { client } = tasked(
      [{ status: "working" }, { status: "working" }, { status: "completed", result: { content: [{ type: "text", text: "late" }] } }],
      { ttlMs: null },
    );
    expect(await client.call("slow", {})).toBe("late");
  });

  test("a task that asks for input is cancelled and refused, naming what was asked", async () => {
    const { client, sent } = tasked([
      { status: "input_required", statusMessage: "a person has to approve it", inputRequests: {} },
    ]);

    const failure = await client.call("slow", {}).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(InputRequired);
    expect((failure as Error).message).toContain("a person has to approve it");
    expect(sent().map((call) => call.method)).toEqual(["tools/call", "tasks/get", "tasks/cancel"]);
  });

  test("a task is an answer to a tool call and to nothing else", async () => {
    const { client } = serving(() => task());
    await expect(client.listTools()).rejects.toThrow("does not recognise");
  });
});

describe("a server answers a workflow with a task, for a client that can follow one", () => {
  const roots: string[] = [];
  const stub = stubModel(Array.from({ length: 40 }, () => ({ text: "an answer" })));

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(cleanup));
  });

  async function load(files: Record<string, string>, fetchImpl: typeof fetch = stub.fetch): Promise<App> {
    const root = await makeProject({
      "praecise.config.ts": `import { defineConfig } from "${FRAMEWORK}";
        export default defineConfig({ name: "acme", version: "2.1.0", ${TEST_ENDPOINT} });`,
      "agents/support.ts": `import { agent } from "${FRAMEWORK}";
        export default agent({ role: "Help.", description: "Answers questions.", effect: "read" });`,
      ...files,
    });
    roots.push(root);
    return App.load({ root, env: MODEL_ENV, fetch: fetchImpl });
  }

  const DRAFT = {
    "workflows/draft.ts": `import { workflow } from "${FRAMEWORK}";
      export default workflow({
        description: "Draft something.",
        input: { input: "what to draft" },
        steps: [{ id: "write", ask: "draft {{input}}" }],
      });`,
  };
  const SHIP = {
    "workflows/ship.ts": `import { workflow } from "${FRAMEWORK}";
      export default workflow({
        description: "Ship something, once a person says so.",
        input: { input: "what to ship" },
        steps: [{ id: "gate", approve: "Ship {{input}}?" }, { id: "after", ask: "confirm the shipment" }],
      });`,
  };
  const AUDIT = {
    "workflows/audit.ts": `import { workflow } from "${FRAMEWORK}";
      export default workflow({
        description: "Audit something.",
        access: "gated",
        input: { input: "what to audit" },
        steps: [{ id: "look", ask: "audit {{input}}" }],
      });`,
  };

  /** A model that does not answer until it is let go, so a task can be caught mid-work. */
  function heldModel() {
    let release!: () => void;
    const open = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      await open;
      return stub.fetch(input, init);
    }) as typeof fetch;
    return { fetchImpl, release };
  }

  type Answer = { result: Record<string, any>; error?: undefined };
  type Refusal = { error: { code: number; message: string; data?: unknown }; result?: undefined };

  /** One request, from a client that declared `capabilities`. */
  async function rpc(
    app: App,
    method: string,
    params: Record<string, unknown>,
    capabilities: Record<string, unknown> = TASKS,
    caller: Caller = { identified: true },
  ): Promise<Answer | Refusal> {
    const request = mcpRequest(method, params) as { params: { _meta: Record<string, unknown> } };
    request.params._meta["io.modelcontextprotocol/clientCapabilities"] = capabilities;
    return (await handleMcp(app, request, caller)) as Answer | Refusal;
  }

  const get = async (app: App, taskId: string, caller?: Caller): Promise<Record<string, any>> =>
    (await rpc(app, "tasks/get", { taskId }, TASKS, caller)).result as Record<string, any>;

  /** Ask until the task is in `status`. */
  async function until(app: App, taskId: string, status: string): Promise<Record<string, any>> {
    let state = await get(app, taskId);
    for (let tries = 0; tries < 400 && state.status !== status; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      state = await get(app, taskId);
    }
    expect(state.status).toBe(status);
    return state;
  }

  test("server/discover declares the extension, and not the push channel it does not have", async () => {
    const app = await load(DRAFT);
    const reply = (await handleMcp(app, { jsonrpc: "2.0", id: 1, method: "server/discover" })) as Answer;
    expect(reply.result.capabilities.extensions).toEqual({ "io.modelcontextprotocol/tasks": {} });
  });

  test("a client that did not declare the extension is never sent a task", async () => {
    const app = await load(DRAFT);
    const reply = await rpc(app, "tools/call", { name: "draft", arguments: { input: "a memo" } }, {});

    expect(reply.result!.resultType).toBe("complete");
    expect(reply.result!.content).toEqual([{ type: "text", text: "an answer" }]);
    expect(reply.result!.taskId).toBeUndefined();
  });

  test("a client that declared it gets a task at once, recorded before it is answered", async () => {
    const held = heldModel();
    const app = await load(DRAFT, held.fetchImpl);

    const reply = await rpc(app, "tools/call", { name: "draft", arguments: { input: "a memo" } });
    const created = reply.result!;

    expect(created.resultType).toBe("task");
    expect(created.status).toBe("working");
    expect(created.taskId).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(new Date(created.createdAt).toISOString()).toBe(created.createdAt);
    expect(typeof created.ttlMs).toBe("number");
    expect(typeof created.pollIntervalMs).toBe("number");
    // On disk, so a server that restarts still knows what the id stands for.
    expect(await readdir(join(app.stateDir, "mcp-tasks"))).toEqual([`${created.taskId}.json`]);

    const working = await get(app, created.taskId);
    expect(working.resultType).toBe("complete");
    expect(working.status).toBe("working");
    expect(working.result).toBeUndefined();

    held.release();
    const done = await until(app, created.taskId, "completed");

    // Exactly what the blocking call returns for the same workflow.
    const blocking = await rpc(app, "tools/call", { name: "draft", arguments: { input: "a memo" } }, {});
    expect(done.result).toEqual({ content: blocking.result!.content, isError: blocking.result!.isError });
    expect(done.createdAt).toBe(created.createdAt);
  });

  test("the task id is not the run id, which anyone who knows when a run began could guess", async () => {
    const app = await load(DRAFT);
    const { taskId } = (await rpc(app, "tools/call", { name: "draft", arguments: { input: "a memo" } })).result!;
    await until(app, taskId, "completed");

    const [run] = await app.runs.list();
    expect(run!.id).not.toContain(taskId);
    expect(taskId).not.toContain("draft");
  });

  test("an agent stays inside its request, whatever the client declared", async () => {
    const app = await load(DRAFT);
    const reply = await rpc(app, "tools/call", { name: "support", arguments: { input: "hello" } });
    expect(reply.result!.resultType).toBe("complete");
    expect(reply.result!.content).toEqual([{ type: "text", text: "an answer" }]);
  });

  test("a run stopped at a gate is input_required, and says a person decides and where", async () => {
    const app = await load(SHIP);
    const { taskId } = (await rpc(app, "tools/call", { name: "ship", arguments: { input: "the release" } })).result!;

    const waiting = await until(app, taskId, "input_required");
    expect(waiting.statusMessage).toContain('approve step "gate"');
    expect(waiting.statusMessage).toContain("Ship the release?");
    expect(waiting.inputRequests).toEqual({});
    const run = /\/api\/runs\/([\w-]+)/.exec(waiting.statusMessage)![1]!;

    // A peer's message is never what approves a gate, however it is worded.
    const update = await rpc(app, "tasks/update", { taskId, inputResponses: { gate: { approved: true } } });
    expect(update.error!.code).toBe(-32602);
    expect(update.error!.message).toContain("cannot be approved over MCP");
    expect((await app.runs.load(run))!.status).toBe("waiting");

    // The gate is answered where gates are answered, and the task follows.
    await app.resumeWorkflow(run, { approved: true });
    const done = await until(app, taskId, "completed");
    expect(done.result.content[0].text).toBe("an answer");
  });

  test("tasks/update on a task that asked for nothing says there is nothing to answer", async () => {
    const app = await load(DRAFT);
    const { taskId } = (await rpc(app, "tools/call", { name: "draft", arguments: { input: "a memo" } })).result!;
    await until(app, taskId, "completed");

    const update = await rpc(app, "tasks/update", { taskId, inputResponses: {} });
    expect(update.error!.code).toBe(-32602);
    expect(update.error!.message).toContain("asked for no input");
  });

  test("cancelling a task stops its run, and the task stays cancelled", async () => {
    const held = heldModel();
    const app = await load(DRAFT, held.fetchImpl);
    const { taskId } = (await rpc(app, "tools/call", { name: "draft", arguments: { input: "a memo" } })).result!;

    const cancel = await rpc(app, "tasks/cancel", { taskId });
    expect(cancel.error).toBeUndefined();
    expect((await get(app, taskId)).status).toBe("cancelled");

    // The run was interrupted while its model call was still held, not left to finish.
    const [run] = await app.runs.list();
    expect(run?.status).toBe("cancelled");
    expect(run?.outputs).toEqual({});

    held.release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await app.runs.load(run!.id))!.status).toBe("cancelled");
    const after = await get(app, taskId);
    expect(after.status).toBe("cancelled");
    expect(after.result).toBeUndefined();
  });

  test("cancelling a task that already finished leaves it as it finished", async () => {
    const app = await load(DRAFT);
    const { taskId } = (await rpc(app, "tools/call", { name: "draft", arguments: { input: "a memo" } })).result!;
    await until(app, taskId, "completed");

    expect((await rpc(app, "tasks/cancel", { taskId })).error).toBeUndefined();
    expect((await get(app, taskId)).status).toBe("completed");
  });

  test("an id that was never issued is an invalid parameter, whatever it looks like", async () => {
    const app = await load(DRAFT);
    for (const taskId of ["A".repeat(32), "../runs/draft", ""]) {
      for (const method of ["tasks/get", "tasks/update", "tasks/cancel"]) {
        const reply = await rpc(app, method, { taskId });
        expect(reply.error!.code).toBe(-32602);
      }
    }
    expect((await rpc(app, "tasks/get", {})).error!.code).toBe(-32602);
  });

  test("a task whose time is up is gone, counted from when it was created", async () => {
    const app = await load(DRAFT);
    const { taskId } = (await rpc(app, "tools/call", { name: "draft", arguments: { input: "a memo" } })).result!;
    await until(app, taskId, "completed");

    const file = join(app.stateDir, "mcp-tasks", `${taskId}.json`);
    const record = JSON.parse(await readFile(file, "utf8")) as { createdAt: number; ttlMs: number };
    await writeFile(file, JSON.stringify({ ...record, createdAt: Date.now() - record.ttlMs - 1 }));

    const reply = await rpc(app, "tasks/get", { taskId });
    expect(reply.error!.code).toBe(-32602);
    expect(reply.error!.message).toContain("its time is up");
  });

  test("a task is visible only to a caller who may call the tool that created it", async () => {
    const app = await load(AUDIT);
    const { taskId } = (await rpc(app, "tools/call", { name: "audit", arguments: { input: "the books" } })).result!;
    await until(app, taskId, "completed");

    // Refused in the words an unknown id is refused in, so the refusal confirms nothing.
    const stranger = await rpc(app, "tasks/get", { taskId }, TASKS, {});
    const unknown = await rpc(app, "tasks/get", { taskId: "B".repeat(32) }, TASKS, {});
    expect(stranger.error!.code).toBe(-32602);
    expect(stranger.error!.message.replace(taskId, "")).toBe(unknown.error!.message.replace("B".repeat(32), ""));
    expect((await rpc(app, "tasks/cancel", { taskId }, TASKS, {})).error!.code).toBe(-32602);

    // And a caller who may not call it is not handed a task for it in the first place.
    const refused = await rpc(app, "tools/call", { name: "audit", arguments: { input: "the books" } }, TASKS, {});
    expect(refused.result!.resultType).toBe("complete");
    expect(refused.result!.isError).toBe(true);
  });

  test("a task method from a client that did not declare the extension is a missing capability", async () => {
    const app = await load(DRAFT);
    const reply = await rpc(app, "tasks/get", { taskId: "A".repeat(32) }, {});
    expect(reply.error!.code).toBe(-32021);
    expect(reply.error!.message).toContain("io.modelcontextprotocol/tasks");
  });

  test("methods the extension does not have are refused by name", async () => {
    const app = await load(DRAFT);
    for (const method of ["tasks/list", "tasks/result", "subscriptions/listen"]) {
      const reply = await rpc(app, method, {});
      expect(reply.error!.code).toBe(-32601);
      expect(reply.error!.message).toContain(method);
    }
  });

  test("a workflow that cannot start fails its task with the reason", async () => {
    const app = await load({
      "workflows/broken.ts": `import { workflow } from "${FRAMEWORK}";
        export default workflow({ description: "Broken.", steps: [{ id: "a", ask: "x", agent: "nobody" }] });`,
    });
    const { taskId } = (await rpc(app, "tools/call", { name: "broken", arguments: {} })).result!;
    const failed = await until(app, taskId, "failed");
    expect(failed.error.message).toBe(failed.statusMessage);
    expect(failed.statusMessage).toContain("nobody");
  });

  test("this framework's own client, pointed at this server, gets the answer a blocking call gives", async () => {
    const app = await load(DRAFT);
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const reply = await handleMcp(app, JSON.parse(String(init.body)), {
        identified: true,
        headers: init.headers as Record<string, string>,
      });
      return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const client = new McpClient(service(), fetchImpl);

    expect(await client.call("draft", { input: "a memo" })).toBe("an answer");
    // It went by way of a task: one was recorded.
    expect(await readdir(join(app.stateDir, "mcp-tasks"))).toHaveLength(1);
  });
});
