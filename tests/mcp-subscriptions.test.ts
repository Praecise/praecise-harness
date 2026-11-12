/**
 * Being told, instead of asking.
 *
 * `subscriptions/listen` is the one request in MCP 2026-07-28 whose answer comes late: a
 * stream the server acknowledges and then speaks on only when something changes. It is
 * how a tool list is known to have changed and how a task's state is pushed. Each side
 * has a quiet way to get it wrong: a client that keeps polling a server that pushes, a
 * client that hangs on a server that never acknowledges, a server that promises changes
 * it cannot send, a subscription that outlives the caller who opened it.
 */
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, test } from "vitest";

import { App } from "../src/app.js";
import type { ResolvedService } from "../src/compile/services.js";
import { McpClient, collectTools, mcpRequest, type McpNotification } from "../src/harness/mcp.js";
import { serve, type DevServer } from "../src/server/index.js";
import { handleMcp, type Caller } from "../src/server/mcp.js";
import { serveStdio } from "../src/server/stdio.js";
import { FRAMEWORK, MODEL_ENV, TEST_ENDPOINT, TEST_TOKEN, cleanup, makeProject, stubModel } from "./helpers.js";

const service = (over: Partial<ResolvedService> = {}): ResolvedService =>
  ({ name: "svc", url: "https://example.invalid/mcp", credential: "SVC_KEY", apiKey: "k", auth: "bearer", ...over }) as ResolvedService;

type Body = { id: number; method: string; params: Record<string, any> };
const SUB = "io.modelcontextprotocol/subscriptionId";
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A fake server whose `subscriptions/listen` is a stream the test writes to. Every other
 * request is answered by `reply`.
 */
function streaming(reply: (body: Body) => unknown, opts: { listen?: "stream" | "refuse" } = {}) {
  const seen: Body[] = [];
  const streams: { id: number; push: (message: unknown) => void; end: () => void; cancelled: boolean }[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Body;
    seen.push(body);
    if (body.method === "subscriptions/listen" && opts.listen !== "refuse") {
      const encoder = new TextEncoder();
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const entry = {
        id: body.id,
        cancelled: false,
        push: (message: unknown) => controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`)),
        end: () => controller.close(),
      };
      const stream = new ReadableStream<Uint8Array>({
        start: (made) => {
          controller = made;
        },
        cancel: () => {
          entry.cancelled = true;
        },
      });
      init.signal?.addEventListener("abort", () => (entry.cancelled = true));
      streams.push(entry);
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (body.method === "subscriptions/listen") {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "unknown method: subscriptions/listen" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: reply(body) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const ack = (index: number, notifications: Record<string, unknown>) =>
    streams[index]!.push({
      jsonrpc: "2.0",
      method: "notifications/subscriptions/acknowledged",
      params: { _meta: { [SUB]: streams[index]!.id }, notifications },
    });
  const waitFor = async (count: number) => {
    for (let tries = 0; tries < 400 && streams.length < count; tries += 1) await tick();
    expect(streams.length).toBeGreaterThanOrEqual(count);
  };
  return { seen, streams, fetchImpl, ack, waitFor, client: new McpClient(service(), fetchImpl) };
}

describe("a client listens on a stream the server speaks on", () => {
  test("it asks for what it wants, resolves on the acknowledgement, and hears what follows", async () => {
    const { seen, streams, ack, waitFor, client } = streaming(() => ({}));
    const heard: McpNotification[] = [];

    const opening = client.listen({ toolsListChanged: true, resourceSubscriptions: ["file:///a"] }, (note) => heard.push(note));
    await waitFor(1);
    // The server agrees to less than was asked.
    ack(0, { toolsListChanged: true });
    const subscription = await opening;

    expect(seen[0]!.params.notifications).toEqual({ toolsListChanged: true, resourceSubscriptions: ["file:///a"] });
    expect(seen[0]!.params._meta["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
    expect(subscription.acknowledged).toEqual({ toolsListChanged: true });

    streams[0]!.push({ jsonrpc: "2.0", method: "notifications/tools/list_changed", params: { _meta: { [SUB]: streams[0]!.id } } });
    // One that names another subscription is not this one's to hear.
    streams[0]!.push({ jsonrpc: "2.0", method: "notifications/tools/list_changed", params: { _meta: { [SUB]: 999 } } });
    await tick(20);
    expect(heard.map((note) => note.method)).toEqual(["notifications/tools/list_changed"]);

    // The reply to the request is the server saying it is over, on purpose.
    streams[0]!.push({ jsonrpc: "2.0", id: streams[0]!.id, result: { resultType: "complete", _meta: { [SUB]: streams[0]!.id } } });
    expect(await subscription.closed).toBe("graceful");
  });

  test("a stream that just stops was dropped, and one this side closes was cancelled", async () => {
    const dropped = streaming(() => ({}));
    const first = dropped.client.listen({ toolsListChanged: true }, () => undefined);
    await dropped.waitFor(1);
    dropped.ack(0, { toolsListChanged: true });
    const subscription = await first;
    dropped.streams[0]!.end();
    expect(await subscription.closed).toBe("dropped");

    const closed = streaming(() => ({}));
    const second = closed.client.listen({ toolsListChanged: true }, () => undefined);
    await closed.waitFor(1);
    closed.ack(0, { toolsListChanged: true });
    const open = await second;
    open.close();
    expect(await open.closed).toBe("cancelled");
    expect(closed.streams[0]!.cancelled).toBe(true);
  });

  test("a server that does not do this refuses, and the refusal is what is thrown", async () => {
    const { client } = streaming(() => ({}), { listen: "refuse" });
    const failure = await client.listen({ toolsListChanged: true }, () => undefined).catch((err: unknown) => err);
    expect((failure as Error).message).toContain("subscriptions/listen");
    expect((failure as { code?: number }).code).toBe(-32601);
  });

  test("closing the client ends what it was listening to", async () => {
    const { streams, ack, waitFor, client } = streaming(() => ({}));
    const opening = client.listen({ toolsListChanged: true }, () => undefined);
    await waitFor(1);
    ack(0, { toolsListChanged: true });
    const subscription = await opening;
    client.close();
    expect(await subscription.closed).toBe("cancelled");
    expect(streams[0]!.cancelled).toBe(true);
  });
});

describe("a watched service's tools are listed again when it says they changed", () => {
  const tools = (names: string[]) => ({
    resultType: "complete",
    tools: names.map((name) => ({ name, description: name, inputSchema: { type: "object", properties: {} } })),
    ttlMs: 1000,
    cacheScope: "private",
  });

  test("only a service marked watch is listened to, and a change reaches whoever collected", async () => {
    let offered = ["one"];
    const { seen, streams, fetchImpl, ack, waitFor } = streaming(() => tools(offered));
    const changed: string[] = [];

    const collecting = collectTools([service({ watch: true })], fetchImpl, { changed: (name) => changed.push(name) });
    await waitFor(1);
    ack(0, { toolsListChanged: true });
    const first = await collecting;
    expect(first.schemas.map((tool) => tool.name)).toEqual(["svc__one"]);
    expect(first.notes).toEqual([]);

    offered = ["one", "two"];
    streams[0]!.push({ jsonrpc: "2.0", method: "notifications/tools/list_changed", params: { _meta: { [SUB]: streams[0]!.id } } });
    await tick(20);
    expect(changed).toEqual(["svc"]);

    // Listed again on the client that is already open: nothing is opened twice.
    const again = await collectTools([service({ watch: true })], fetchImpl, { changed: () => undefined, reuse: first.clients });
    expect(again.schemas.map((tool) => tool.name)).toEqual(["svc__one", "svc__two"]);
    expect(again.clients.get("svc")).toBe(first.clients.get("svc"));
    expect(seen.filter((body) => body.method === "subscriptions/listen")).toHaveLength(1);
    first.clients.get("svc")!.close();

    const unwatched = streaming(() => tools(["one"]));
    await collectTools([service()], unwatched.fetchImpl, { changed: () => undefined });
    expect(unwatched.seen.map((body) => body.method)).toEqual(["tools/list"]);
  });

  test("a watched server that sends no such changes is listed once, and a note says so", async () => {
    const { fetchImpl } = streaming(() => tools(["one"]), { listen: "refuse" });
    const found = await collectTools([service({ watch: true })], fetchImpl, { changed: () => undefined });
    expect(found.schemas).toHaveLength(1);
    expect(found.notes.join("\n")).toContain("does not send tool-list changes");
  });

  test("a stream lost without a word counts as a change, since one may have gone unheard", async () => {
    const { streams, fetchImpl, ack, waitFor } = streaming(() => tools(["one"]));
    const changed: string[] = [];
    const collecting = collectTools([service({ watch: true })], fetchImpl, { changed: (name) => changed.push(name) });
    await waitFor(1);
    ack(0, { toolsListChanged: true });
    await collecting;
    streams[0]!.end();
    await tick(20);
    expect(changed).toEqual(["svc"]);
  });
});

describe("a client stops polling a task whose server pushes", () => {
  const task = (over: Record<string, unknown> = {}) => ({
    taskId: "task-1",
    status: "working",
    createdAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    ttlMs: 60_000,
    pollIntervalMs: 1,
    ...over,
  });

  test("one look when the subscription opens, then nothing until the server speaks", async () => {
    const { seen, streams, ack, waitFor, client } = streaming((body) =>
      body.method === "tools/call" ? { ...task(), resultType: "task" } : { ...task(), resultType: "complete" },
    );
    const progress: string[] = [];
    const calling = client.call("slow", {}, { onProgress: (event) => progress.push(event.message ?? "") });
    await waitFor(1);
    expect(seen[1]!.params.notifications).toEqual({ taskIds: ["task-1"] });
    ack(0, { taskIds: ["task-1"] });

    // Long enough for dozens of polls at the 1ms the server suggested.
    await tick(80);
    expect(seen.filter((body) => body.method === "tasks/get")).toHaveLength(1);

    const pushed = (state: Record<string, unknown>) =>
      streams[0]!.push({ jsonrpc: "2.0", method: "notifications/tasks", params: { ...task(state), _meta: { [SUB]: streams[0]!.id } } });
    pushed({ status: "working", statusMessage: "half way" });
    pushed({ status: "completed", result: { content: [{ type: "text", text: "pushed result" }] } });

    expect(await calling).toBe("pushed result");
    expect(progress).toContain("half way");
    // The result came on the stream: no second look was needed to read it.
    expect(seen.filter((body) => body.method === "tasks/get")).toHaveLength(1);
    // And the subscription is closed with the task.
    await tick(10);
    expect(streams[0]!.cancelled).toBe(true);
  });

  test("a stream that ends before the task does is polled from there", async () => {
    let looked = 0;
    const { streams, ack, waitFor, client } = streaming((body) => {
      if (body.method === "tools/call") return { ...task(), resultType: "task" };
      looked += 1;
      return looked < 3
        ? { ...task(), resultType: "complete" }
        : { ...task({ status: "completed", result: { content: [{ type: "text", text: "polled result" }] } }), resultType: "complete" };
    });
    const calling = client.call("slow", {});
    await waitFor(1);
    ack(0, { taskIds: ["task-1"] });
    await tick(20);
    streams[0]!.end();
    expect(await calling).toBe("polled result");
    expect(looked).toBe(3);
  });

  test("a server that will not follow this task is polled", async () => {
    let looked = 0;
    const { ack, waitFor, client } = streaming((body) => {
      if (body.method === "tools/call") return { ...task(), resultType: "task" };
      looked += 1;
      return { ...task({ status: "completed", result: { content: [{ type: "text", text: "ok" }] } }), resultType: "complete" };
    });
    const calling = client.call("slow", {});
    await waitFor(1);
    // Acknowledged, but not for this task.
    ack(0, {});
    expect(await calling).toBe("ok");
    expect(looked).toBe(1);
  });

  test("a server that refuses subscriptions is asked once, not once per task", async () => {
    const { seen, client } = streaming(
      (body) =>
        body.method === "tools/call"
          ? { ...task(), resultType: "task" }
          : { ...task({ status: "completed", result: { content: [{ type: "text", text: "ok" }] } }), resultType: "complete" },
      { listen: "refuse" },
    );
    await client.call("slow", {});
    await client.call("slow", {});
    expect(seen.filter((body) => body.method === "subscriptions/listen")).toHaveLength(1);
  });

  test("a caller who stops waiting cancels the task and the subscription with it", async () => {
    const { seen, streams, ack, waitFor, client } = streaming((body) =>
      body.method === "tools/call" ? { ...task(), resultType: "task" } : { ...task(), resultType: "complete" },
    );
    const stop = new AbortController();
    const calling = client.call("slow", {}, { signal: stop.signal });
    await waitFor(1);
    ack(0, { taskIds: ["task-1"] });
    await tick(20);
    stop.abort(new Error("the user left"));
    await expect(calling).rejects.toThrow(/cancelled: the user left/);
    expect(seen.some((body) => body.method === "tasks/cancel")).toBe(true);
    expect(streams[0]!.cancelled).toBe(true);
  });
});

// ── The server ────────────────────────────────────────────────────────────────

const TASKS = { extensions: { "io.modelcontextprotocol/tasks": {} } };

describe("a server pushes the state of the tasks it was asked about", () => {
  const roots: string[] = [];
  const servers: DevServer[] = [];
  const stub = stubModel(Array.from({ length: 40 }, () => ({ text: "an answer" })));

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await Promise.all(roots.splice(0).map((root) => cleanup(root).catch(() => undefined)));
  });

  const FILES = {
    "praecise.config.ts": `import { defineConfig } from "${FRAMEWORK}";
      export default defineConfig({ name: "acme", version: "2.1.0", ${TEST_ENDPOINT} });`,
    "workflows/draft.ts": `import { workflow } from "${FRAMEWORK}";
      export default workflow({ description: "Draft.", input: { input: "what" }, steps: [{ id: "write", ask: "draft {{input}}" }] });`,
    "workflows/ship.ts": `import { workflow } from "${FRAMEWORK}";
      export default workflow({
        description: "Ship, once a person says so.",
        input: { input: "what" },
        steps: [{ id: "gate", approve: "Ship {{input}}?" }, { id: "after", ask: "confirm" }],
      });`,
    "workflows/audit.ts": `import { workflow } from "${FRAMEWORK}";
      export default workflow({ description: "Audit.", access: "gated", input: { input: "what" }, steps: [{ id: "a", ask: "audit {{input}}" }] });`,
  };

  /** A model that answers only once it is let go, so a run can be caught mid-flight. */
  function held() {
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

  async function load(fetchImpl: typeof fetch = stub.fetch): Promise<App> {
    const root = await makeProject(FILES);
    roots.push(root);
    return App.load({ root, env: MODEL_ENV, fetch: fetchImpl });
  }

  const request = (method: string, params: Record<string, unknown>, id: number, capabilities: Record<string, unknown> = TASKS) => {
    const made = mcpRequest(method, params, id) as { params: { _meta: Record<string, unknown> } };
    made.params._meta["io.modelcontextprotocol/clientCapabilities"] = capabilities;
    return made;
  };
  const start = async (app: App, name: string, caller: Caller = { identified: true }): Promise<string> => {
    const reply = (await handleMcp(app, request("tools/call", { name, arguments: { input: "x" } }, 1), caller)) as {
      result: { taskId: string };
    };
    return reply.result.taskId;
  };
  /** Open a subscription against `handleMcp` and collect what it sends. */
  function listen(app: App, taskIds: string[], caller: Caller = { identified: true }, capabilities = TASKS) {
    const sent: { method?: string; params?: Record<string, any> }[] = [];
    const ending = new AbortController();
    const reply = handleMcp(app, request("subscriptions/listen", { notifications: { taskIds, toolsListChanged: true } }, 7, capabilities), caller, {
      send: (message) => sent.push(message as never),
      signal: ending.signal,
    });
    return { sent, reply, end: () => ending.abort() };
  }

  test("it acknowledges the tasks and nothing else, sends each change whole, and closes when the last is done", async () => {
    const model = held();
    const app = await load(model.fetchImpl);
    const taskId = await start(app, "draft");
    const { sent, reply } = listen(app, [taskId]);
    await tick(30);

    // List changes were asked for too. This server cannot send them, so it does not say it will.
    expect(sent[0]).toEqual({
      jsonrpc: "2.0",
      method: "notifications/subscriptions/acknowledged",
      params: { _meta: { [SUB]: 7 }, notifications: { taskIds: [taskId] } },
    });
    // Still working: there is nothing to say yet.
    expect(sent).toHaveLength(1);

    model.release();
    const closing = (await reply) as { id: number; result: Record<string, any> };

    const last = sent.at(-1)!;
    expect(last.method).toBe("notifications/tasks");
    expect(last.params).toMatchObject({ taskId, status: "completed", _meta: { [SUB]: 7 } });
    // The result is on the notification: a client needs no tasks/get to read it.
    expect(last.params!.result.content[0].text).toBe("an answer");
    // And the stream is ended on purpose, with the reply to the request that opened it.
    expect(closing.id).toBe(7);
    expect(closing.result).toMatchObject({ resultType: "complete", _meta: { [SUB]: 7 } });
  });

  test("a task that already moved is reported on the first look, not lost", async () => {
    const app = await load();
    const taskId = await start(app, "draft");
    for (let tries = 0; tries < 400; tries += 1) {
      const state = (await handleMcp(app, request("tasks/get", { taskId }, 2), { identified: true })) as { result: { status: string } };
      if (state.result.status === "completed") break;
      await tick();
    }
    const { sent, reply } = listen(app, [taskId]);
    await reply;
    expect(sent.map((message) => message.method)).toEqual(["notifications/subscriptions/acknowledged", "notifications/tasks"]);
    expect(sent[1]!.params!.status).toBe("completed");
  });

  test("a gate is pushed as input_required, and the task is followed past it once a person answers", async () => {
    const app = await load();
    const taskId = await start(app, "ship");
    const { sent, reply } = listen(app, [taskId]);

    let waiting: Record<string, any> | undefined;
    for (let tries = 0; tries < 400 && !waiting; tries += 1) {
      waiting = sent.find((message) => message.params?.status === "input_required")?.params;
      await tick();
    }
    expect(waiting!.statusMessage).toContain("It cannot be approved over MCP");
    const run = /\/api\/runs\/([\w-]+)/.exec(waiting!.statusMessage)![1]!;

    await app.resumeWorkflow(run, { approved: true });
    await reply;
    expect(sent.at(-1)!.params).toMatchObject({ status: "completed" });
  });

  test("a task this caller may not see is left out, exactly as one that does not exist is", async () => {
    const app = await load();
    const taskId = await start(app, "audit");
    const stranger = listen(app, [taskId, "B".repeat(32)], {});
    const closing = (await stranger.reply) as { result: Record<string, unknown> };
    expect(stranger.sent).toHaveLength(1);
    expect(stranger.sent[0]!.params!.notifications).toEqual({});
    // Nothing to follow, so it is closed at once instead of held open for nothing.
    expect(closing.result.resultType).toBe("complete");
  });

  test("task notifications are the extension's, and a client that did not declare it is told so", async () => {
    const app = await load();
    const taskId = await start(app, "draft");
    const { reply } = listen(app, [taskId], { identified: true }, {});
    const refused = (await reply) as { error: { code: number; data: unknown } };
    expect(refused.error.code).toBe(-32021);
    expect(refused.error.data).toEqual({ requiredCapabilities: TASKS });
  });

  test("a caller who goes away is not replied to, and nothing more is sent", async () => {
    const model = held();
    const app = await load(model.fetchImpl);
    const taskId = await start(app, "draft");
    const { sent, reply, end } = listen(app, [taskId]);
    await tick(20);
    end();
    expect(await reply).toBeUndefined();
    const before = sent.length;
    model.release();
    await tick(60);
    expect(sent).toHaveLength(before);
  });

  test("over a pipe the subscription does not block the line, and a cancellation ends it", async () => {
    const model = held();
    const app = await load(model.fetchImpl);
    const taskId = await start(app, "draft");
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: Record<string, any>[] = [];
    let buffered = "";
    output.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      const parts = buffered.split("\n");
      buffered = parts.pop() ?? "";
      for (const line of parts) if (line.trim()) lines.push(JSON.parse(line));
    });
    const server = serveStdio({ app, input, output });

    input.write(`${JSON.stringify(request("subscriptions/listen", { notifications: { taskIds: [taskId] } }, 7))}\n`);
    // A request made while the subscription is open is still answered.
    input.write(`${JSON.stringify(request("tasks/get", { taskId }, 8))}\n`);
    const acknowledged = () => lines.some((line) => line.method === "notifications/subscriptions/acknowledged");
    for (let tries = 0; tries < 400 && !(lines.some((line) => line.id === 8) && acknowledged()); tries += 1) await tick();
    expect(lines.find((line) => line.id === 8)!.result.status).toBe("working");
    expect(acknowledged()).toBe(true);

    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } })}\n`);
    await tick(30);
    const before = lines.length;
    model.release();
    await tick(80);
    // Cancelled: no task notification, and no reply to the request that was cancelled.
    expect(lines.slice(before).some((line) => line.method === "notifications/tasks" || line.id === 7)).toBe(false);
    server.close();
    input.end();
  });

  test("this framework's own client, over HTTP to this server, is pushed the result and polls once", async () => {
    const model = held();
    const root = await makeProject(FILES);
    roots.push(root);
    const server = await serve({ root, port: 0, watch: false, env: MODEL_ENV, fetch: model.fetchImpl, token: TEST_TOKEN });
    servers.push(server);

    const methods: string[] = [];
    const counting = (async (input: RequestInfo | URL, init?: RequestInit) => {
      methods.push((JSON.parse(String(init?.body)) as { method: string }).method);
      return fetch(input, init);
    }) as typeof fetch;
    const client = new McpClient(service({ url: `http://127.0.0.1:${server.port}/mcp`, apiKey: TEST_TOKEN }), counting);

    const calling = client.call("draft", { input: "a memo" });
    for (let tries = 0; tries < 400 && !methods.includes("tasks/get"); tries += 1) await tick();
    await tick(50);
    model.release();

    expect(await calling).toBe("an answer");
    expect(methods).toEqual(["tools/call", "subscriptions/listen", "tasks/get"]);
    client.close();
  });
});
