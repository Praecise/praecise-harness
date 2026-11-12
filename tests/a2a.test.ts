/**
 * The app published as an A2A agent.
 *
 * A2A and MCP publish the SAME app and must not disagree about it. That is the property
 * most of these tests are really about: a second protocol is a second place for access
 * rules to drift, and the drift is invisible until someone reaches a skill over A2A that
 * they were correctly refused over MCP.
 *
 * The other half is the agent card. A card is a promise a client is entitled to act on,
 * so a capability declared and not implemented is worse than one that is simply absent —
 * it teaches clients to stop reading the card.
 *
 * And the endpoint answers two versions of the protocol. Each caller is answered in the
 * version it spoke, from one store, so the tests for the older one are about spelling.
 */
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../src/app.js";
import {
  agentCard,
  handleA2A,
  streamA2A,
  streamsA2A,
  TaskStore,
  textOf,
  type Task,
} from "../src/server/a2a.js";
import { toolsOf, type Caller } from "../src/server/mcp.js";
import { MODEL_ENV, TEST_ENDPOINT, cleanup, FRAMEWORK, makeProject, stubModel } from "./helpers.js";

const roots: string[] = [];
const stub = stubModel(Array.from({ length: 80 }, () => ({ text: "an answer" })));

async function load(files: Record<string, string>, fetchImpl: typeof fetch = stub.fetch) {
  const root = await makeProject({
    "praecise.config.ts": `import { defineConfig } from "${FRAMEWORK}";
      export default defineConfig({ name: "acme", version: "2.1.0", ${TEST_ENDPOINT} });`,
    ...files,
  });
  roots.push(root);
  return App.load({ root, env: MODEL_ENV, fetch: fetchImpl });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(cleanup));
});

const MIXED = {
  "agents/support.ts": `import { agent } from "${FRAMEWORK}";
    export default agent({ role: "Help.", description: "Answers questions.", effect: "read" });`,
  "agents/auditor.ts": `import { agent } from "${FRAMEWORK}";
    export default agent({ role: "Audit.", description: "Audits.", access: "gated", effect: "read" });`,
};

const ONE = {
  "agents/support.ts": `import { agent } from "${FRAMEWORK}";
    export default agent({ role: "Help.", description: "Answers questions.", effect: "read" });`,
};

/** A workflow that stops for a person before it does anything. */
const GATED = {
  ...ONE,
  "workflows/ship.ts": `import { workflow } from "${FRAMEWORK}";
    export default workflow({
      description: "Ship something, once a person says so.",
      input: { input: "what to ship" },
      steps: [{ id: "gate", approve: "Ship {{input}}?" }, { id: "after", ask: "confirm the shipment" }],
    });`,
};

const rpc = (method: string, params: Record<string, unknown> = {}, id: number | string = 1) => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});

/** A message as 1.0 writes it. */
const ask = (text: string, skillId?: string) => ({
  messageId: "m-1",
  role: "ROLE_USER",
  parts: [{ text }],
  ...(skillId ? { metadata: { skillId } } : {}),
});
const send = (message: Record<string, unknown>, id: number | string = 1) => rpc("SendMessage", { message }, id);

/** The same, as 0.3 wrote it. */
const askLegacy = (text: string, skillId?: string) => ({
  kind: "message",
  messageId: "m-1",
  role: "user",
  parts: [{ kind: "text", text }],
  ...(skillId ? { metadata: { skillId } } : {}),
});
const sendLegacy = (message: Record<string, unknown>, id: number | string = 1) =>
  rpc("message/send", { message }, id);

const speaking = (version: string): Caller => ({ headers: { "A2A-Version": version } });

type Sent = { result: { task: Task }; error?: { code: number; message: string; data?: unknown } };
type Failed = { error: { code: number; message: string; data?: { reason: string; "@type": string }[] } };

async function framesOf(stream: AsyncGenerator<unknown>): Promise<Record<string, any>[]> {
  const frames: Record<string, any>[] = [];
  for await (const frame of stream) frames.push((frame as { result: Record<string, any> }).result ?? (frame as Record<string, any>));
  return frames;
}

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

async function until(condition: () => boolean): Promise<void> {
  for (let tries = 0; tries < 400 && !condition(); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(condition()).toBe(true);
}

describe("the agent card", () => {
  it("names its endpoint once for each version it answers, and no longer at the top", async () => {
    const app = await load(ONE);
    const card = agentCard(app, {}, "https://agents.example");

    expect(card.supportedInterfaces).toEqual([
      { url: "https://agents.example/a2a", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
      { url: "https://agents.example/a2a", protocolBinding: "JSONRPC", protocolVersion: "0.3" },
    ]);
    // What 1.0 replaced.
    for (const gone of ["url", "preferredTransport", "additionalInterfaces", "supportsAuthenticatedExtendedCard", "protocolVersion"]) {
      expect(card).not.toHaveProperty(gone);
    }
    expect(card.version).toBe("2.1.0");
  });

  it("claims no capability it does not implement, and claims the one it does", async () => {
    // No way to authenticate to a callback URL and no second card. Saying otherwise would
    // send a client to a method that is refused. Streaming IS answered, so it is declared.
    const app = await load(ONE);
    const capabilities = agentCard(app).capabilities as Record<string, boolean>;
    expect(capabilities.streaming).toBe(true);
    expect(capabilities.pushNotifications).toBe(false);
    expect(capabilities.extendedAgentCard).toBe(false);
  });

  it("is the card a 0.3 client reads, when a 0.3 client asks", async () => {
    const app = await load(ONE);
    const card = agentCard(app, {}, "https://agents.example", "0.3");

    expect(card.protocolVersion).toBe("0.3.0");
    expect(card.url).toBe("https://agents.example/a2a");
    expect(card.preferredTransport).toBe("JSONRPC");
    expect(card.supportsAuthenticatedExtendedCard).toBe(false);
    expect(card).not.toHaveProperty("supportedInterfaces");
    expect((card.skills as unknown[]).length).toBe(1);
  });

  it("lists exactly the skills this caller could actually run", async () => {
    // Not a cosmetic filter. Publishing a gated skill on an anonymous card tells an
    // unauthorised reader precisely what exists — the disclosure the MCP side is
    // careful to avoid, which would be reintroduced here by a card that lists everything.
    const app = await load(MIXED);
    const anonymous = (agentCard(app).skills as { id: string }[]).map((s) => s.id);
    const identified = (agentCard(app, { identified: true }).skills as { id: string }[]).map((s) => s.id);

    expect(anonymous).toContain("support");
    expect(anonymous).not.toContain("auditor");
    expect(identified).toContain("auditor");
  });

  it("shows the same surface A2A shows as MCP does, for the same caller", async () => {
    // The invariant that makes two protocols safe to publish at once.
    const app = await load(MIXED);
    for (const caller of [{}, { identified: true }, { identified: true, readOnly: true }]) {
      for (const version of ["1.0", "0.3"] as const) {
        const skills = (agentCard(app, caller, "", version).skills as { id: string }[]).map((s) => s.id).sort();
        const tools = toolsOf(app, caller).map((t) => t.name).sort();
        expect(skills).toEqual(tools);
      }
    }
  });
});

describe("SendMessage", () => {
  it("answers with a completed task carrying the agent's reply", async () => {
    const app = await load(ONE);
    const reply = (await handleA2A(app, send(ask("hello")))) as Sent;
    const task = reply.result.task;

    expect(task.status.state).toBe("TASK_STATE_COMPLETED");
    expect(textOf(task.status.message)).toBe("an answer");
    // The exchange is on the record, in the roles 1.0 names.
    expect(task.history?.map((m) => m.role)).toEqual(["ROLE_USER", "ROLE_AGENT"]);
    expect(task.artifacts?.[0]?.parts[0]?.text).toBe("an answer");
  });

  it("carries no `kind` anywhere, which 1.0 removed", async () => {
    const app = await load(ONE);
    const reply = await handleA2A(app, send(ask("hello")));
    expect(JSON.stringify(reply)).not.toContain('"kind"');
  });

  it("keeps the caller's context id, so a conversation stays one conversation", async () => {
    const app = await load(ONE);
    const reply = (await handleA2A(app, send({ ...ask("hi"), contextId: "ctx-42" }))) as Sent;
    expect(reply.result.task.contextId).toBe("ctx-42");
  });

  it("mints a context when the caller did not bring one", async () => {
    const app = await load(ONE);
    const reply = (await handleA2A(app, send(ask("hi")))) as Sent;
    expect(typeof reply.result.task.contextId).toBe("string");
    expect(reply.result.task.contextId.length).toBeGreaterThan(0);
  });

  it("asks which skill when the app publishes several", async () => {
    // A2A carries no name of its own: the protocol's model is that you talk to an agent
    // and it works out what you want. An app that is a bag of named skills has to be told.
    const app = await load(MIXED);
    const reply = (await handleA2A(app, send(ask("hi")), { identified: true })) as Failed;
    expect(reply.error.code).toBe(-32602);
    expect(reply.error.message).toContain("skillId");
  });

  it("needs no skillId when there is only one thing it could mean", async () => {
    const app = await load(ONE);
    const reply = (await handleA2A(app, send(ask("hi")))) as Sent;
    expect(reply.result.task.status.state).toBe("TASK_STATE_COMPLETED");
  });

  it("refuses a gated skill over A2A exactly as it does over MCP", async () => {
    // The drift this whole file exists to catch.
    const app = await load(MIXED);
    const reply = (await handleA2A(app, send(ask("hi", "auditor")))) as Sent;
    expect(reply.result.task.status.state).toBe("TASK_STATE_FAILED");
    expect(textOf(reply.result.task.status.message)).toContain("nothing named");
  });

  it("reports a refusal as a failed task, not a protocol error", async () => {
    // A caller that asked for something it may not have made a well-formed request. The
    // failure belongs in the task's state, where a peer agent can read and react to it.
    const app = await load(MIXED);
    const reply = (await handleA2A(app, send(ask("hi", "nothing-at-all")))) as Sent;
    expect(reply.error).toBeUndefined();
    expect(reply.result.task.status.state).toBe("TASK_STATE_FAILED");
  });

  it("refuses a request with no message rather than sending an empty prompt", async () => {
    const app = await load(ONE);
    const reply = (await handleA2A(app, rpc("SendMessage"))) as Failed;
    expect(reply.error.code).toBe(-32602);
  });

  it("refuses a request to be called back, since it never would be", async () => {
    // Ignoring the config would leave the caller waiting for a notification nobody sends.
    const app = await load(ONE);
    const reply = (await handleA2A(
      app,
      rpc("SendMessage", { message: ask("hi"), configuration: { taskPushNotificationConfig: { url: "https://x.example" } } }),
    )) as Failed;
    expect(reply.error.code).toBe(-32003);
  });

  it("returns at once when asked to, and the task is found finished later", async () => {
    const held = heldModel();
    const app = await load(ONE, held.fetchImpl);
    const tasks = new TaskStore();

    const reply = (await handleA2A(
      app,
      rpc("SendMessage", { message: ask("hi"), configuration: { returnImmediately: true } }),
      {},
      tasks,
    )) as Sent;
    expect(reply.result.task.status.state).toBe("TASK_STATE_WORKING");

    held.release();
    await until(() => tasks.get(reply.result.task.id)?.status.state === "TASK_STATE_COMPLETED");
    // What was answered stays what was answered: the reply is not the live task.
    expect(reply.result.task.status.state).toBe("TASK_STATE_WORKING");
  });
});

describe("the task methods that make a returned task useful", () => {
  it("finds again what SendMessage created", async () => {
    const app = await load(ONE);
    const tasks = new TaskStore();
    const made = (await handleA2A(app, send(ask("hi")), {}, tasks)) as Sent;

    const found = (await handleA2A(app, rpc("GetTask", { id: made.result.task.id }, 2), {}, tasks)) as {
      result: Task;
    };
    expect(found.result.id).toBe(made.result.task.id);
    expect(found.result.status.state).toBe("TASK_STATE_COMPLETED");
  });

  it("gives back as much history as was asked for", async () => {
    const app = await load(ONE);
    const tasks = new TaskStore();
    const made = (await handleA2A(app, send(ask("hi")), {}, tasks)) as Sent;
    const get = async (historyLength?: number) =>
      ((await handleA2A(app, rpc("GetTask", { id: made.result.task.id, historyLength }), {}, tasks)) as { result: Task })
        .result.history;

    expect(await get()).toHaveLength(2);
    expect((await get(1))?.map((m) => m.role)).toEqual(["ROLE_AGENT"]);
    expect(await get(0)).toBeUndefined();
  });

  it("tells a missing task apart from a malformed request, and says which in a form a program reads", async () => {
    // A caller polling a task that has been evicted needs to know which of the two
    // happened; collapsing them into -32602 makes an ordinary lifecycle event look
    // like a client bug.
    const app = await load(ONE);
    const gone = (await handleA2A(app, rpc("GetTask", { id: "task-nope" }))) as Failed;
    const malformed = (await handleA2A(app, rpc("GetTask"))) as Failed;

    expect(gone.error.code).toBe(-32001);
    expect(gone.error.data?.[0]).toMatchObject({
      "@type": "type.googleapis.com/google.rpc.ErrorInfo",
      reason: "TASK_NOT_FOUND",
      domain: "a2a-protocol.org",
      metadata: { taskId: "task-nope" },
    });
    expect(malformed.error.code).toBe(-32602);
  });

  it("lists tasks a page at a time, and narrows to one conversation when asked", async () => {
    const app = await load(ONE);
    const tasks = new TaskStore();
    for (const [index, contextId] of ["ctx-a", "ctx-b", "ctx-a"].entries()) {
      await handleA2A(app, send({ ...ask("x"), contextId }, index), {}, tasks);
    }
    type Listed = { result: { tasks: Task[]; nextPageToken: string; pageSize: number; totalSize: number } };

    const first = (await handleA2A(app, rpc("ListTasks", { pageSize: 2 }), {}, tasks)) as Listed;
    expect(first.result.tasks).toHaveLength(2);
    expect(first.result.totalSize).toBe(3);
    expect(first.result.pageSize).toBe(2);
    expect(first.result.nextPageToken).not.toBe("");
    // A listing is for finding a task; its artifacts are left to GetTask unless asked for.
    expect(first.result.tasks[0]?.artifacts).toBeUndefined();

    const second = (await handleA2A(
      app,
      rpc("ListTasks", { pageSize: 2, pageToken: first.result.nextPageToken, includeArtifacts: true }),
      {},
      tasks,
    )) as Listed;
    expect(second.result.tasks).toHaveLength(1);
    // The empty token is how the protocol says there is no further page.
    expect(second.result.nextPageToken).toBe("");
    expect(second.result.tasks[0]?.artifacts).toHaveLength(1);
    const seen = [...first.result.tasks, ...second.result.tasks].map((task) => task.id);
    expect(new Set(seen).size).toBe(3);

    const narrowed = (await handleA2A(app, rpc("ListTasks", { contextId: "ctx-b" }), {}, tasks)) as Listed;
    expect(narrowed.result.tasks.map((t) => t.contextId)).toEqual(["ctx-b"]);

    const none = (await handleA2A(app, rpc("ListTasks", { status: "TASK_STATE_FAILED" }), {}, tasks)) as Listed;
    expect(none.result.tasks).toEqual([]);
  });

  it("refuses a page size or a token it could not have issued", async () => {
    const app = await load(ONE);
    for (const params of [{ pageSize: 0 }, { pageSize: 101 }, { pageSize: 1.5 }, { pageToken: "not-a-token" }]) {
      const reply = (await handleA2A(app, rpc("ListTasks", params))) as Failed;
      expect(reply.error.code).toBe(-32602);
    }
  });

  it("will not cancel a task that already finished", async () => {
    const app = await load(ONE);
    const tasks = new TaskStore();
    const made = (await handleA2A(app, send(ask("hi")), {}, tasks)) as Sent;

    const reply = (await handleA2A(app, rpc("CancelTask", { id: made.result.task.id }, 2), {}, tasks)) as Failed;
    expect(reply.error.code).toBe(-32002);
    expect(reply.error.message).toContain("already finished");
    expect(reply.error.data?.[0]?.reason).toBe("TASK_NOT_CANCELABLE");
  });

  it("cancels a task that is still running, and the answer does not overwrite that", async () => {
    // The race worth having a test for: work finishes after the cancel lands. Writing
    // the answer over the cancellation would report a cancelled task as completed —
    // the one outcome a caller who cancelled is entitled not to see.
    const held = heldModel();
    const app = await load(ONE, held.fetchImpl);
    const tasks = new TaskStore();
    const made = (await handleA2A(
      app,
      rpc("SendMessage", { message: ask("hi"), configuration: { returnImmediately: true } }),
      {},
      tasks,
    )) as Sent;
    const id = made.result.task.id;

    const cancelled = (await handleA2A(app, rpc("CancelTask", { id }), {}, tasks)) as { result: Task };
    expect(cancelled.result.status.state).toBe("TASK_STATE_CANCELED");

    held.release();
    await until(() => !tasks.isRunning(id));
    expect(tasks.get(id)?.status.state).toBe("TASK_STATE_CANCELED");
    expect(tasks.get(id)?.artifacts).toBeUndefined();
  });

  it("evicts oldest-first rather than growing without bound", async () => {
    const tasks = new TaskStore(2);
    for (const id of ["a", "b", "c"]) {
      tasks.put({
        id,
        contextId: "ctx",
        status: { state: "TASK_STATE_COMPLETED", timestamp: new Date().toISOString() },
      });
    }
    expect(tasks.get("a")).toBeUndefined();
    expect(tasks.get("c")).toBeDefined();
  });
});

describe("a stream of events", () => {
  it("says which requests are answered with one", () => {
    for (const method of ["SendStreamingMessage", "SubscribeToTask", "message/stream", "tasks/resubscribe"]) {
      expect(streamsA2A(rpc(method))).toBe(true);
    }
    for (const method of ["SendMessage", "GetTask", "message/send", "nonsense"]) {
      expect(streamsA2A(rpc(method))).toBe(false);
    }
    expect(streamsA2A(undefined)).toBe(false);
  });

  it("opens with the task, reports the work, and ends on the status that finishes it", async () => {
    const app = await load(ONE);
    const tasks = new TaskStore();
    const frames = await framesOf(streamA2A(app, rpc("SendStreamingMessage", { message: ask("hello") }), {}, tasks));

    // The task first, so the caller has its id before anything else happens.
    expect(frames[0]?.task.status.state).toBe("TASK_STATE_WORKING");
    const id = frames[0]?.task.id as string;

    // Every frame is exactly one of the three things a stream carries.
    for (const frame of frames) {
      expect(Object.keys(frame).filter((key) => ["task", "message", "statusUpdate", "artifactUpdate"].includes(key))).toHaveLength(1);
    }
    // `final` and `kind` are 0.3's. The stream ends; it does not say that it has.
    expect(JSON.stringify(frames)).not.toContain('"final"');
    expect(JSON.stringify(frames)).not.toContain('"kind"');

    const last = frames.at(-1)?.statusUpdate;
    expect(last.status.state).toBe("TASK_STATE_COMPLETED");
    expect(last.taskId).toBe(id);
    // Exactly one status ends it.
    expect(frames.filter((f) => f.statusUpdate && f.statusUpdate.status.state !== "TASK_STATE_WORKING")).toHaveLength(1);

    // The answer arrives as an artifact, in one chunk or several, and adds up to itself.
    const chunks = frames.filter((f) => f.artifactUpdate).map((f) => f.artifactUpdate);
    expect(chunks.length).toBeGreaterThan(0);
    const answerId = chunks.at(-1).artifact.artifactId;
    const answer = chunks.filter((c) => c.artifact.artifactId === answerId);
    expect(answer.map((c) => c.artifact.parts[0].text).join("")).toBe("an answer");
    expect(answer[0].append).toBe(false);
    expect(answer.slice(1).every((c) => c.append === true)).toBe(true);
    expect(answer.filter((c) => c.lastChunk)).toHaveLength(1);
    expect(answer.at(-1).lastChunk).toBe(true);

    // And the task found afterwards is the one the stream described.
    const stored = tasks.get(id);
    expect(stored?.status.state).toBe("TASK_STATE_COMPLETED");
    expect(stored?.artifacts?.at(-1)?.parts[0]?.text).toBe("an answer");
    expect(stored?.artifacts?.at(-1)?.artifactId).toBe(answerId);
  });

  it("answers a refused request with the one error and nothing after it", async () => {
    const app = await load(MIXED);
    const frames = await framesOf(streamA2A(app, rpc("SendStreamingMessage", { message: ask("hi") }), { identified: true }));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.error.code).toBe(-32602);
  });

  it("is not answered by the single-reply handler, which says where it is", async () => {
    const app = await load(ONE);
    const reply = (await handleA2A(app, rpc("SendStreamingMessage", { message: ask("hi") }))) as Failed;
    expect(reply.error.code).toBe(-32600);
    expect(reply.error.message).toContain("streamA2A");
  });

  it("lets a second caller follow a task that is still being worked on", async () => {
    const held = heldModel();
    const app = await load(ONE, held.fetchImpl);
    const tasks = new TaskStore();
    const sending = handleA2A(app, send(ask("hi")), {}, tasks);
    await until(() => tasks.list().length === 1);
    const id = tasks.list()[0]!.id;

    const stream = streamA2A(app, rpc("SubscribeToTask", { id }), {}, tasks);
    const first = (await stream.next()).value as { result: Record<string, any> };
    expect(first.result.task.id).toBe(id);
    expect(first.result.task.status.state).toBe("TASK_STATE_WORKING");

    held.release();
    const rest = await framesOf(stream);
    expect(rest.some((frame) => frame.artifactUpdate?.artifact.parts[0].text === "an answer")).toBe(true);
    expect(rest.at(-1)?.statusUpdate.status.state).toBe("TASK_STATE_COMPLETED");
    expect(((await sending) as Sent).result.task.status.state).toBe("TASK_STATE_COMPLETED");
  });

  it("refuses to follow a task that has finished or was never there", async () => {
    const app = await load(ONE);
    const tasks = new TaskStore();
    const made = (await handleA2A(app, send(ask("hi")), {}, tasks)) as Sent;

    const finished = await framesOf(streamA2A(app, rpc("SubscribeToTask", { id: made.result.task.id }), {}, tasks));
    expect(finished).toHaveLength(1);
    expect(finished[0]?.error.code).toBe(-32004);
    expect(finished[0]?.error.data[0].reason).toBe("UNSUPPORTED_OPERATION");

    const missing = await framesOf(streamA2A(app, rpc("SubscribeToTask", { id: "task-nope" }), {}, tasks));
    expect(missing[0]?.error.code).toBe(-32001);
  });

  it("ends a stream when its task is cancelled", async () => {
    const held = heldModel();
    const app = await load(ONE, held.fetchImpl);
    const tasks = new TaskStore();
    const stream = streamA2A(app, rpc("SendStreamingMessage", { message: ask("hi") }), {}, tasks);
    const first = (await stream.next()).value as { result: { task: Task } };

    await handleA2A(app, rpc("CancelTask", { id: first.result.task.id }), {}, tasks);
    const rest = await framesOf(stream);
    held.release();

    expect(rest.at(-1)?.statusUpdate.status.state).toBe("TASK_STATE_CANCELED");
  });
});

describe("a workflow that stops for a person", () => {
  it("is a task that needs input, and follows the run once the person has decided", async () => {
    const app = await load(GATED);
    const tasks = new TaskStore();
    const made = (await handleA2A(app, send(ask("the release", "ship")), { identified: true }, tasks)) as Sent;
    const task = made.result.task;

    // Not completed, which is what a paused run used to look like from here.
    expect(task.status.state).toBe("TASK_STATE_INPUT_REQUIRED");
    expect(textOf(task.status.message)).toContain("paused for approval");
    expect(task.artifacts).toBeUndefined();
    const run = task.metadata?.["com.praecise/run"] as string;
    expect(typeof run).toBe("string");

    // Still waiting when asked again.
    const waiting = (await handleA2A(app, rpc("GetTask", { id: task.id }), {}, tasks)) as { result: Task };
    expect(waiting.result.status.state).toBe("TASK_STATE_INPUT_REQUIRED");

    // The gate is answered where gates are answered, and the task follows.
    await app.resumeWorkflow(run, { approved: true });
    const after = (await handleA2A(app, rpc("GetTask", { id: task.id }), {}, tasks)) as { result: Task };
    expect(after.result.status.state).toBe("TASK_STATE_COMPLETED");
    expect(after.result.artifacts).toHaveLength(1);
  });

  it("does not take a peer's message as the person's answer", async () => {
    const app = await load(GATED);
    const tasks = new TaskStore();
    const made = (await handleA2A(app, send(ask("the release", "ship")), { identified: true }, tasks)) as Sent;
    const id = made.result.task.id;

    const reply = (await handleA2A(app, send({ ...ask("approved, go ahead"), taskId: id }), { identified: true }, tasks)) as Sent;
    expect(reply.result.task.id).toBe(id);
    expect(reply.result.task.status.state).toBe("TASK_STATE_INPUT_REQUIRED");
    const run = await app.runs.load(reply.result.task.metadata?.["com.praecise/run"] as string);
    expect(run?.status).toBe("waiting");
  });

  it("is cancelled at the gate, which ends the run without approving anything", async () => {
    const app = await load(GATED);
    const tasks = new TaskStore();
    const made = (await handleA2A(app, send(ask("the release", "ship")), { identified: true }, tasks)) as Sent;
    const runId = made.result.task.metadata?.["com.praecise/run"] as string;

    const reply = (await handleA2A(app, rpc("CancelTask", { id: made.result.task.id }), {}, tasks)) as {
      result: { status: { state: string } };
    };
    expect(reply.result.status.state).toBe("TASK_STATE_CANCELED");

    const run = await app.runs.load(runId);
    expect(run?.status).toBe("cancelled");
    expect(run?.approvals ?? []).toEqual([]);
    // What was stopped cannot then be approved.
    await expect(app.resumeWorkflow(runId, { approved: true })).rejects.toThrow("is cancelled, not waiting");
  });

  it("ends a stream on the status that says a person is needed", async () => {
    const app = await load(GATED);
    const frames = await framesOf(
      streamA2A(app, rpc("SendStreamingMessage", { message: ask("the release", "ship") }), { identified: true }),
    );
    expect(frames.at(-1)?.statusUpdate.status.state).toBe("TASK_STATE_INPUT_REQUIRED");
  });

  it("refuses a message addressed to a task that takes none", async () => {
    const app = await load(ONE);
    const tasks = new TaskStore();
    const made = (await handleA2A(app, send(ask("hi")), {}, tasks)) as Sent;

    const finished = (await handleA2A(app, send({ ...ask("more"), taskId: made.result.task.id }), {}, tasks)) as Failed;
    expect(finished.error.code).toBe(-32004);
    const missing = (await handleA2A(app, send({ ...ask("more"), taskId: "task-nope" }), {}, tasks)) as Failed;
    expect(missing.error.code).toBe(-32001);
  });
});

describe("which version a caller speaks", () => {
  it("is read from the header, and from the method name where there is none", async () => {
    const app = await load(ONE);
    // 1.0 by name alone, 1.0 by header, and a patch release of 1.0.
    for (const caller of [{}, speaking("1.0"), speaking("1.0.1"), { headers: { "a2a-version": "1.0" } }]) {
      const reply = (await handleA2A(app, send(ask("hi")), caller)) as Sent;
      expect(reply.result.task.status.state).toBe("TASK_STATE_COMPLETED");
    }
    // 0.3 by name alone, by header, and with the empty header the protocol reads as 0.3.
    for (const caller of [{}, speaking("0.3"), speaking("0.3.0"), speaking("")]) {
      const reply = (await handleA2A(app, sendLegacy(askLegacy("hi")), caller)) as { result: { kind: string } };
      expect(reply.result.kind).toBe("task");
    }
  });

  it("refuses a version it does not speak, by its own error and naming the ones it does", async () => {
    const app = await load(ONE);
    for (const version of ["2.0", "1.1", "0.2", "latest"]) {
      const reply = (await handleA2A(app, send(ask("hi")), speaking(version))) as Failed;
      expect(reply.error.code).toBe(-32009);
      expect(reply.error.message).toContain("1.0 and 0.3");
      expect(reply.error.data?.[0]?.reason).toBe("VERSION_NOT_SUPPORTED");
    }
  });

  it("refuses a method name from the other version, and gives the name it has in this one", async () => {
    const app = await load(ONE);
    const old = (await handleA2A(app, sendLegacy(askLegacy("hi")), speaking("1.0"))) as Failed;
    expect(old.error.code).toBe(-32601);
    expect(old.error.message).toContain('"SendMessage"');

    const fresh = (await handleA2A(app, send(ask("hi")), speaking("0.3"))) as Failed;
    expect(fresh.error.code).toBe(-32601);
    expect(fresh.error.message).toContain('"message/send"');
  });
});

describe("a 0.3 caller, answered as 0.3 wrote it", () => {
  it("gets a task with its kind, lower-case state and roles, and parts that say what they are", async () => {
    const app = await load(ONE);
    const reply = (await handleA2A(app, sendLegacy(askLegacy("hello")))) as { result: Record<string, any> };
    const task = reply.result;

    // The task itself is the result; there is no `task` wrapper in 0.3.
    expect(task.kind).toBe("task");
    expect(task.status.state).toBe("completed");
    expect(task.status.message).toMatchObject({ kind: "message", role: "agent", parts: [{ kind: "text", text: "an answer" }] });
    expect(task.history.map((m: { role: string }) => m.role)).toEqual(["user", "agent"]);
    expect(task.history[0].parts).toEqual([{ kind: "text", text: "hello" }]);
    expect(task.artifacts[0].parts).toEqual([{ kind: "text", text: "an answer" }]);
    expect(JSON.stringify(task)).not.toContain("TASK_STATE_");
    expect(JSON.stringify(task)).not.toContain("ROLE_");
  });

  it("reads the same store a 1.0 caller writes, each in its own spelling", async () => {
    const app = await load(ONE);
    const tasks = new TaskStore();
    const made = (await handleA2A(app, send(ask("hi")), {}, tasks)) as Sent;

    const found = (await handleA2A(app, rpc("tasks/get", { id: made.result.task.id }), {}, tasks)) as {
      result: Record<string, any>;
    };
    expect(found.result.id).toBe(made.result.task.id);
    expect(found.result.status.state).toBe("completed");

    const listed = (await handleA2A(app, rpc("tasks/list"), {}, tasks)) as { result: { tasks: { kind: string }[] } };
    expect(listed.result.tasks.map((task) => task.kind)).toEqual(["task"]);
  });

  it("gets errors with the code and the message, and no details it would not expect", async () => {
    const app = await load(ONE);
    const gone = (await handleA2A(app, rpc("tasks/get", { id: "task-nope" }))) as Failed;
    expect(gone.error.code).toBe(-32001);
    expect(gone.error.data).toBeUndefined();

    const tasks = new TaskStore();
    const made = (await handleA2A(app, sendLegacy(askLegacy("hi")), {}, tasks)) as { result: { id: string } };
    const finished = (await handleA2A(app, rpc("tasks/cancel", { id: made.result.id }), {}, tasks)) as Failed;
    expect(finished.error.code).toBe(-32002);
  });

  it("spells an approval gate `input-required`", async () => {
    const app = await load(GATED);
    const reply = (await handleA2A(app, sendLegacy(askLegacy("the release", "ship")), { identified: true })) as {
      result: Record<string, any>;
    };
    expect(reply.result.status.state).toBe("input-required");
  });

  it("gets a stream whose events have kinds and whose last status says it is final", async () => {
    const app = await load(ONE);
    const frames = await framesOf(streamA2A(app, rpc("message/stream", { message: askLegacy("hello") })));

    expect(frames[0]?.kind).toBe("task");
    expect(frames[0]?.status.state).toBe("working");
    for (const frame of frames.slice(1)) expect(["status-update", "artifact-update"]).toContain(frame.kind);

    const statuses = frames.filter((frame) => frame.kind === "status-update");
    expect(statuses.at(-1)).toMatchObject({ final: true, status: { state: "completed" } });
    expect(statuses.slice(0, -1).every((frame) => frame.final === false)).toBe(true);
    expect(frames.at(-1)?.kind).toBe("status-update");

    const chunks = frames.filter((frame) => frame.kind === "artifact-update");
    expect(chunks.at(-1)?.artifact.parts[0].kind).toBe("text");
    expect(chunks.at(-1)?.lastChunk).toBe(true);
  });

  it("understands a file part as 0.3 nested it", async () => {
    const app = await load(ONE);
    const reply = (await handleA2A(
      app,
      sendLegacy({
        ...askLegacy("see attached"),
        parts: [
          { kind: "text", text: "see attached" },
          { kind: "file", file: { uri: "https://files.example/a.pdf", mimeType: "application/pdf", name: "a.pdf" } },
        ],
      }),
    )) as { result: Record<string, any> };

    // Taken in as one part with a url, and given back the way this caller wrote it.
    expect(reply.result.history[0].parts[1]).toEqual({
      kind: "file",
      file: { uri: "https://files.example/a.pdf", mimeType: "application/pdf", name: "a.pdf" },
    });
  });
});

describe("methods the card says are unsupported", () => {
  it("refuses them by name, in both versions, and says the card already said so", async () => {
    const app = await load(ONE);
    const push = [
      "CreateTaskPushNotificationConfig",
      "GetTaskPushNotificationConfig",
      "ListTaskPushNotificationConfigs",
      "DeleteTaskPushNotificationConfig",
      "tasks/pushNotificationConfig/set",
      "tasks/pushNotificationConfig/get",
    ];
    for (const method of push) {
      const reply = (await handleA2A(app, rpc(method))) as Failed;
      expect(reply.error.code).toBe(-32003);
      expect(reply.error.message).toContain(method);
      expect(reply.error.message).toContain("capabilities");
    }
    for (const method of ["GetExtendedAgentCard", "agent/getAuthenticatedExtendedCard"]) {
      const reply = (await handleA2A(app, rpc(method))) as Failed;
      expect(reply.error.code).toBe(-32007);
      expect(reply.error.message).toContain("capabilities");
    }
  });

  it("does not know a name neither version has", async () => {
    const app = await load(ONE);
    const reply = (await handleA2A(app, rpc("message/sendStreaming"))) as Failed;
    expect(reply.error.code).toBe(-32601);
  });

  it("rejects a body that is not JSON-RPC at all", async () => {
    const app = await load(ONE);
    const reply = (await handleA2A(app, { method: "SendMessage" })) as Failed;
    expect(reply.error.code).toBe(-32600);
  });
});
