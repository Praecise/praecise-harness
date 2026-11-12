/**
 * A2A 1.0: push notifications, and the HTTP+JSON binding beside JSON-RPC.
 *
 * Two things are held here. Push: a caller registers a webhook, and the task's changes
 * arrive there authenticated the way the caller asked, in the order they happened, and
 * never at an address inside this machine's own network. REST: every operation is
 * reachable by a verb and a path, and gives the same answer JSON-RPC does, because it is
 * the same code.
 */

import { afterEach, describe, expect, it } from "vitest";

import { App } from "../src/app.js";
import { TaskStore, agentCard, handleA2A, restA2A, type Task } from "../src/server/a2a.js";
import { outboundFault, privateAddress } from "../src/outbound.js";
import { MODEL_ENV, TEST_ENDPOINT, TEST_TOKEN, authed, cleanup, FRAMEWORK, makeProject, stubModel } from "./helpers.js";
import { serve, type DevServer } from "../src/server/index.js";

const roots: string[] = [];
const servers: DevServer[] = [];

const ONE = {
  "agents/support.ts": `import { agent } from "${FRAMEWORK}";
    export default agent({ role: "Help.", description: "Answers questions.", effect: "read" });`,
};

async function load(files: Record<string, string> = ONE) {
  const root = await makeProject({
    "praecise.config.ts": `import { defineConfig } from "${FRAMEWORK}";
      export default defineConfig({ name: "acme", version: "2.1.0", ${TEST_ENDPOINT} });`,
    ...files,
  });
  roots.push(root);
  const stub = stubModel(Array.from({ length: 40 }, () => ({ text: "an answer" })));
  return { root, app: await App.load({ root, env: MODEL_ENV, fetch: stub.fetch }), stub };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map(cleanup));
});

/** A webhook receiver that writes down what it was sent. */
function receiver(answers: number[] = []) {
  const got: { url: string; headers: Record<string, string>; body: Record<string, any> }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    got.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body)),
    });
    return new Response("", { status: answers.shift() ?? 200 });
  }) as typeof fetch;
  return { got, fetchImpl };
}

/** A store whose webhooks go to `fetchImpl`, with a resolver that says every name is public. */
function storeWith(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return new TaskStore(1_000, {
    push: { fetch: fetchImpl, resolve: async () => ["93.184.216.34"], sleep: async () => undefined, ...extra },
  });
}

const rpc = (method: string, params: Record<string, unknown> = {}, id: number | string = 1) => ({ jsonrpc: "2.0", id, method, params });
const ask = (text: string) => ({ messageId: "m-1", role: "ROLE_USER", parts: [{ text }] });

type Sent = { result: { task: Task } };
type Failed = { error: { code: number; message: string; data?: { reason: string }[] } };

describe("push notifications", () => {
  it("sends a task's changes to the webhook given with the message, authenticated as asked", async () => {
    const { app } = await load();
    const hook = receiver();
    const tasks = storeWith(hook.fetchImpl);

    const sent = (await handleA2A(
      app,
      rpc("SendMessage", {
        message: ask("hi"),
        configuration: {
          taskPushNotificationConfig: {
            url: "https://client.example/hook",
            token: "task-7",
            authentication: { scheme: "Bearer", credentials: "secret-for-this-task" },
          },
        },
      }),
      {},
      tasks,
    )) as Sent;
    await tasks.pushed();

    const id = sent.result.task.id;
    expect(hook.got.length).toBeGreaterThanOrEqual(2);
    for (const call of hook.got) {
      expect(call.url).toBe("https://client.example/hook");
      expect(call.headers.authorization).toBe("Bearer secret-for-this-task");
      expect(call.headers["content-type"]).toBe("application/a2a+json");
      expect(call.headers["x-a2a-notification-token"]).toBe("task-7");
    }
    // Each body is a StreamResponse: exactly one of the four, and about this task.
    for (const { body } of hook.got) {
      expect(Object.keys(body)).toHaveLength(1);
      expect(["task", "statusUpdate", "artifactUpdate", "message"]).toContain(Object.keys(body)[0]);
    }
    // The completion is told as it happened, and the task itself follows it.
    const states = hook.got.filter((call) => call.body.statusUpdate).map((call) => call.body.statusUpdate.status.state);
    expect(states.at(-1)).toBe("TASK_STATE_COMPLETED");
    const last = hook.got.at(-1)!.body;
    expect(last.task.id).toBe(id);
    expect(last.task.status.state).toBe("TASK_STATE_COMPLETED");
    expect(last.task.artifacts[0].parts[0].text).toBe("an answer");
  });

  it("creates, reads, lists and deletes a config for a task", async () => {
    const { app } = await load();
    const hook = receiver();
    const tasks = storeWith(hook.fetchImpl);
    const { result } = (await handleA2A(app, rpc("SendMessage", { message: ask("hi") }), {}, tasks)) as Sent;
    const taskId = result.task.id;

    const created = (await handleA2A(
      app,
      rpc("CreateTaskPushNotificationConfig", { taskId, url: "https://client.example/hook", authentication: { scheme: "Bearer", credentials: "t" } }),
      {},
      tasks,
    )) as { result: { id: string; taskId: string; url: string } };
    expect(created.result).toMatchObject({ taskId, url: "https://client.example/hook" });
    expect(created.result.id).toBeTruthy();

    const got = (await handleA2A(app, rpc("GetTaskPushNotificationConfig", { taskId, id: created.result.id }), {}, tasks)) as typeof created;
    expect(got.result).toEqual(created.result);

    const listed = (await handleA2A(app, rpc("ListTaskPushNotificationConfigs", { taskId }), {}, tasks)) as {
      result: { configs: unknown[]; nextPageToken: string };
    };
    expect(listed.result.configs).toEqual([created.result]);
    expect(listed.result.nextPageToken).toBe("");

    // Deleting is idempotent: twice is the same as once.
    for (let times = 0; times < 2; times++) {
      const deleted = (await handleA2A(app, rpc("DeleteTaskPushNotificationConfig", { taskId, id: created.result.id }), {}, tasks)) as {
        result: unknown;
      };
      expect(deleted.result).toEqual({});
    }
    const gone = (await handleA2A(app, rpc("GetTaskPushNotificationConfig", { taskId, id: created.result.id }), {}, tasks)) as Failed;
    expect(gone.error.code).toBe(-32001);
  });

  it("answers for a task that does not exist as the task not being found", async () => {
    const { app } = await load();
    const tasks = storeWith(receiver().fetchImpl);
    for (const [method, params] of [
      ["CreateTaskPushNotificationConfig", { taskId: "nope", url: "https://client.example/hook" }],
      ["GetTaskPushNotificationConfig", { taskId: "nope", id: "x" }],
      ["ListTaskPushNotificationConfigs", { taskId: "nope" }],
      ["DeleteTaskPushNotificationConfig", { taskId: "nope", id: "x" }],
    ] as const) {
      const reply = (await handleA2A(app, rpc(method, params), {}, tasks)) as Failed;
      expect(reply.error.code).toBe(-32001);
      expect(reply.error.data?.[0]?.reason).toBe("TASK_NOT_FOUND");
    }
  });

  it("will not send notifications into its own network", async () => {
    const { app } = await load();
    const hook = receiver();
    // The real rules: no resolver stub that calls everything public.
    const tasks = new TaskStore(1_000, { push: { fetch: hook.fetchImpl, resolve: async () => ["10.0.0.8"] } });

    for (const url of [
      "http://client.example/hook", // not https
      "https://127.0.0.1/hook",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/hook",
      "https://localhost/hook",
      "https://user:pass@client.example/hook",
      "https://rebinds.example/hook", // resolves to 10.0.0.8
      "file:///etc/passwd",
    ]) {
      const reply = (await handleA2A(
        app,
        rpc("SendMessage", { message: ask("hi"), configuration: { taskPushNotificationConfig: { url } } }),
        {},
        tasks,
      )) as Failed;
      expect(reply.error?.code, url).toBe(-32602);
    }
    // Refused before a task was opened, so nothing was started and nothing was sent.
    expect(tasks.list()).toHaveLength(0);
    expect(hook.got).toHaveLength(0);
  });

  it("refuses credentials that could end a header early", async () => {
    const { app } = await load();
    const tasks = storeWith(receiver().fetchImpl);
    const reply = (await handleA2A(
      app,
      rpc("SendMessage", {
        message: ask("hi"),
        configuration: {
          taskPushNotificationConfig: { url: "https://client.example/hook", authentication: { scheme: "Bearer", credentials: "a\r\nx-injected: 1" } },
        },
      }),
      {},
      tasks,
    )) as Failed;
    expect(reply.error.code).toBe(-32602);
  });

  it("tries again when the receiver is down, and writes it down when it stays down", async () => {
    const { app } = await load();
    const hook = receiver([503, 503, 503, 503, 503, 503, 503, 503, 503, 503, 503, 503]);
    const tasks = storeWith(hook.fetchImpl, { attempts: 2 });
    const sent = (await handleA2A(
      app,
      rpc("SendMessage", { message: ask("hi"), configuration: { taskPushNotificationConfig: { url: "https://client.example/hook" } } }),
      {},
      tasks,
    )) as Sent;
    await tasks.pushed();

    // The task is unaffected by a receiver that is down.
    expect(sent.result.task.status.state).toBe("TASK_STATE_COMPLETED");
    expect(hook.got.length).toBeGreaterThanOrEqual(4);
    expect(tasks.pushFailure).toContain("https://client.example");
    expect(tasks.pushFailure).toContain("503");
    // The path may carry a secret; the sentence an operator reads does not repeat it.
    expect(tasks.pushFailure).not.toContain("/hook");
  });

  it("is declared on the 1.0 card", async () => {
    const { app } = await load();
    expect((agentCard(app).capabilities as Record<string, unknown>).pushNotifications).toBe(true);
  });
});

describe("the outbound guard", () => {
  it("knows a private address in every spelling", () => {
    for (const address of ["10.1.2.3", "127.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fc00::1", "fd12::1", "fe80::1", "::ffff:10.0.0.1", "::ffff:a00:1", "[::1]"]) {
      expect(privateAddress(address), address).toBe(true);
    }
    for (const address of ["8.8.8.8", "93.184.216.34", "172.32.0.1", "2606:4700:4700::1111"]) {
      expect(privateAddress(address), address).toBe(false);
    }
  });

  it("allows what an operator named, and nothing else that is local", async () => {
    expect(await outboundFault("http://localhost:9000/hook", { allowHosts: ["localhost:9000"] })).toBeUndefined();
    expect(await outboundFault("http://localhost:9001/hook", { allowHosts: ["localhost:9000"] })).toBeDefined();
    expect(await outboundFault("https://public.example/x", { resolve: async () => ["93.184.216.34"] })).toBeUndefined();
    // One private record among public ones is enough.
    expect(await outboundFault("https://mixed.example/x", { resolve: async () => ["93.184.216.34", "192.168.0.4"] })).toContain("private");
  });
});

describe("the HTTP+JSON binding", () => {
  it("does each operation by a verb and a path, with the answer JSON-RPC gives", async () => {
    const { app } = await load();
    const tasks = storeWith(receiver().fetchImpl);

    const sent = await restA2A(app, { method: "POST", path: "/message:send", body: { message: ask("hi") } }, {}, tasks);
    expect(sent).toMatchObject({ status: 200 });
    const task = (sent as { body: { task: Task } }).body.task;
    expect(task.status.state).toBe("TASK_STATE_COMPLETED");

    // The same task, asked for both ways, is the same answer.
    const viaRest = await restA2A(app, { method: "GET", path: `/tasks/${task.id}`, query: new URLSearchParams("historyLength=1") }, {}, tasks);
    const viaRpc = (await handleA2A(app, rpc("GetTask", { id: task.id, historyLength: 1 }), {}, tasks)) as { result: Task };
    expect((viaRest as { body: Task }).body).toEqual(viaRpc.result);
    expect((viaRest as { body: Task }).body.history).toHaveLength(1);

    const listed = await restA2A(app, { method: "GET", path: "/tasks", query: new URLSearchParams("pageSize=5&includeArtifacts=true") }, {}, tasks);
    expect((listed as { body: { tasks: Task[]; pageSize: number } }).body).toMatchObject({ pageSize: 5, totalSize: 1 });
    expect((listed as { body: { tasks: Task[] } }).body.tasks[0]!.artifacts).toBeDefined();

    // A finished task cannot be cancelled: 400, and which 400 it is.
    const cancelled = await restA2A(app, { method: "POST", path: `/tasks/${task.id}:cancel`, body: {} }, {}, tasks);
    expect(cancelled).toMatchObject({ status: 400, body: { error: { code: 400, status: "FAILED_PRECONDITION" } } });
    expect((cancelled as { body: { error: { details: { reason: string; "@type": string; domain: string }[] } } }).body.error.details[0]).toMatchObject({
      "@type": "type.googleapis.com/google.rpc.ErrorInfo",
      reason: "TASK_NOT_CANCELABLE",
      domain: "a2a-protocol.org",
    });

    const missing = await restA2A(app, { method: "GET", path: "/tasks/nope" }, {}, tasks);
    expect(missing).toMatchObject({ status: 404, body: { error: { code: 404, status: "NOT_FOUND" } } });
  });

  it("manages push configs under the task's path", async () => {
    const { app } = await load();
    const tasks = storeWith(receiver().fetchImpl);
    const sent = await restA2A(app, { method: "POST", path: "/message:send", body: { message: ask("hi") } }, {}, tasks);
    const taskId = (sent as { body: { task: Task } }).body.task.id;
    const base = `/tasks/${taskId}/pushNotificationConfigs`;

    // The task in the path is the task, whatever the body says.
    const created = await restA2A(app, { method: "POST", path: base, body: { taskId: "another", url: "https://client.example/hook" } }, {}, tasks);
    const config = (created as { body: { id: string; taskId: string } }).body;
    expect(config.taskId).toBe(taskId);

    expect(await restA2A(app, { method: "GET", path: `${base}/${config.id}` }, {}, tasks)).toMatchObject({ status: 200, body: config });
    expect(await restA2A(app, { method: "GET", path: base }, {}, tasks)).toMatchObject({ status: 200, body: { configs: [config] } });
    expect(await restA2A(app, { method: "DELETE", path: `${base}/${config.id}` }, {}, tasks)).toEqual({ status: 200, body: {} });
    expect(await restA2A(app, { method: "GET", path: `${base}/${config.id}` }, {}, tasks)).toMatchObject({ status: 404 });
  });

  it("streams a message as bare StreamResponse objects, and subscribes by GET or POST", async () => {
    const { app } = await load();
    const tasks = storeWith(receiver().fetchImpl);
    const answer = await restA2A(app, { method: "POST", path: "/message:stream", body: { message: ask("hi") } }, {}, tasks);
    expect("stream" in answer).toBe(true);
    const frames: Record<string, any>[] = [];
    for await (const frame of (answer as { stream: AsyncGenerator<unknown> }).stream) frames.push(frame as Record<string, any>);

    // No JSON-RPC envelope: the first frame is the task, the last a status that ends it.
    expect(frames[0]!.jsonrpc).toBeUndefined();
    expect(frames[0]!.task.id).toBeTruthy();
    expect(frames.at(-1)!.statusUpdate.status.state).toBe("TASK_STATE_COMPLETED");

    for (const method of ["GET", "POST"]) {
      const finished = await restA2A(app, { method, path: `/tasks/${frames[0]!.task.id}:subscribe` }, {}, tasks);
      const first = await (finished as { stream: AsyncGenerator<unknown> }).stream.next();
      // Nothing left to subscribe to: the error the specification names for it.
      expect((first.value as { error: { details: { reason: string }[] } }).error.details[0]!.reason).toBe("UNSUPPORTED_OPERATION");
    }
  });

  it("is 1.0, and says so to a caller that says otherwise", async () => {
    const { app } = await load();
    const tasks = storeWith(receiver().fetchImpl);
    const legacy = await restA2A(app, { method: "GET", path: "/tasks" }, { headers: { "A2A-Version": "0.3" } }, tasks);
    expect(legacy).toMatchObject({ status: 400 });
    expect((legacy as { body: { error: { message: string; details: { reason: string }[] } } }).body.error.details[0]!.reason).toBe("VERSION_NOT_SUPPORTED");

    const current = await restA2A(app, { method: "GET", path: "/tasks" }, { headers: { "a2a-version": "1.0" } }, tasks);
    expect(current).toMatchObject({ status: 200 });

    expect(await restA2A(app, { method: "GET", path: "/nothing/here" }, {}, tasks)).toMatchObject({ status: 404 });
    expect(await restA2A(app, { method: "DELETE", path: "/tasks/x" }, {}, tasks)).toMatchObject({ status: 404 });
    // There is no extended card, and asking for one says so.
    expect(await restA2A(app, { method: "GET", path: "/extendedAgentCard" }, {}, tasks)).toMatchObject({ status: 400 });
  });

  it("is served by the dev server under the JSON-RPC address, behind the same token", async () => {
    const { root, stub } = await load();
    const server = await serve({ root, port: 0, watch: false, token: TEST_TOKEN, env: MODEL_ENV, fetch: stub.fetch });
    servers.push(server);
    const at = `http://localhost:${server.port}/a2a`;

    const refused = await fetch(`${at}/tasks`);
    expect(refused.status).toBe(401);

    const sent = await fetch(`${at}/message:send`, {
      method: "POST",
      headers: authed({ "content-type": "application/a2a+json" }),
      body: JSON.stringify({ message: ask("hi") }),
    });
    expect(sent.status).toBe(200);
    expect(sent.headers.get("content-type")).toContain("application/a2a+json");
    const { task } = (await sent.json()) as { task: Task };

    const got = await fetch(`${at}/tasks/${task.id}`, { headers: authed() });
    expect(((await got.json()) as Task).id).toBe(task.id);

    const missing = await fetch(`${at}/tasks/nope`, { headers: authed() });
    expect(missing.status).toBe(404);

    const stream = await fetch(`${at}/message:stream`, {
      method: "POST",
      headers: authed({ "content-type": "application/json", accept: "text/event-stream" }),
      body: JSON.stringify({ message: ask("hi") }),
    });
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const text = await stream.text();
    const frames = text.split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.replace(/^data: /, "")) as Record<string, any>);
    expect(frames[0]!.task).toBeDefined();
    expect(frames.at(-1)!.statusUpdate.status.state).toBe("TASK_STATE_COMPLETED");
  });
});
