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
 */
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../src/app.js";
import { agentCard, handleA2A, TaskStore, textOf, type Task } from "../src/server/a2a.js";
import { toolsOf } from "../src/server/mcp.js";
import { MODEL_ENV, TEST_ENDPOINT, cleanup, FRAMEWORK, makeProject, stubModel } from "./helpers.js";

const roots: string[] = [];
const stub = stubModel(Array.from({ length: 40 }, () => ({ text: "an answer" })));

async function load(files: Record<string, string>) {
  const root = await makeProject({
    "praecise.config.ts": `import { defineConfig } from "${FRAMEWORK}";
      export default defineConfig({ name: "acme", version: "2.1.0", ${TEST_ENDPOINT} });`,
    ...files,
  });
  roots.push(root);
  return App.load({ root, env: MODEL_ENV, fetch: stub.fetch });
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

const send = (message: Record<string, unknown>, id: number | string = 1) => ({
  jsonrpc: "2.0",
  id,
  method: "message/send",
  params: { message },
});

const ask = (text: string, skillId?: string) => ({
  messageId: "m-1",
  role: "user",
  parts: [{ text }],
  ...(skillId ? { metadata: { skillId } } : {}),
});

describe("the agent card", () => {
  it("declares the protocol version and where to send messages", async () => {
    const app = await load(ONE);
    const card = agentCard(app, {}, "https://agents.example");
    expect(card.protocolVersion).toBe("1.0.0");
    expect(card.url).toBe("https://agents.example/a2a");
    expect(card.version).toBe("2.1.0");
  });

  it("claims no capability it does not implement", async () => {
    // The endpoint has no streaming transport and no way to authenticate to a callback
    // URL. Saying otherwise would send a client to a method that answers -32601.
    const app = await load(ONE);
    const card = agentCard(app);
    const capabilities = card.capabilities as Record<string, boolean>;
    expect(capabilities.streaming).toBe(false);
    expect(capabilities.pushNotifications).toBe(false);
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
      const skills = (agentCard(app, caller).skills as { id: string }[]).map((s) => s.id).sort();
      const tools = toolsOf(app, caller).map((t) => t.name).sort();
      expect(skills).toEqual(tools);
    }
  });
});

describe("message/send", () => {
  it("answers with a completed task carrying the agent's reply", async () => {
    const app = await load(ONE);
    const reply = (await handleA2A(app, send(ask("hello")))) as { result: Task };

    expect(reply.result.status.state).toBe("TASK_STATE_COMPLETED");
    expect(textOf(reply.result.status.message)).toBe("an answer");
    // The exchange is on the record, which is what `stateTransitionHistory` promises.
    expect(reply.result.history?.map((m) => m.role)).toEqual(["user", "agent"]);
    expect(reply.result.artifacts?.[0]?.parts[0]?.text).toBe("an answer");
  });

  it("keeps the caller's context id, so a conversation stays one conversation", async () => {
    const app = await load(ONE);
    const reply = (await handleA2A(app, send({ ...ask("hi"), contextId: "ctx-42" }))) as { result: Task };
    expect(reply.result.contextId).toBe("ctx-42");
  });

  it("mints a context when the caller did not bring one", async () => {
    const app = await load(ONE);
    const reply = (await handleA2A(app, send(ask("hi")))) as { result: Task };
    expect(typeof reply.result.contextId).toBe("string");
    expect(reply.result.contextId.length).toBeGreaterThan(0);
  });

  it("asks which skill when the app publishes several", async () => {
    // A2A carries no name of its own: the protocol's model is that you talk to an agent
    // and it works out what you want. An app that is a bag of named skills has to be told.
    const app = await load(MIXED);
    const reply = (await handleA2A(app, send(ask("hi")), { identified: true })) as {
      error: { code: number; message: string };
    };
    expect(reply.error.code).toBe(-32602);
    expect(reply.error.message).toContain("skillId");
  });

  it("needs no skillId when there is only one thing it could mean", async () => {
    const app = await load(ONE);
    const reply = (await handleA2A(app, send(ask("hi")))) as { result: Task };
    expect(reply.result.status.state).toBe("TASK_STATE_COMPLETED");
  });

  it("refuses a gated skill over A2A exactly as it does over MCP", async () => {
    // The drift this whole file exists to catch.
    const app = await load(MIXED);
    const reply = (await handleA2A(app, send(ask("hi", "auditor")))) as { result: Task };
    expect(reply.result.status.state).toBe("TASK_STATE_FAILED");
    expect(textOf(reply.result.status.message)).toContain("nothing named");
  });

  it("reports a refusal as a failed task, not a protocol error", async () => {
    // A caller that asked for something it may not have made a well-formed request. The
    // failure belongs in the task's state, where a peer agent can read and react to it.
    const app = await load(MIXED);
    const reply = (await handleA2A(app, send(ask("hi", "nothing-at-all")))) as {
      result: Task;
      error?: unknown;
    };
    expect(reply.error).toBeUndefined();
    expect(reply.result.status.state).toBe("TASK_STATE_FAILED");
  });

  it("refuses a message with no parts to read rather than sending an empty prompt", async () => {
    const app = await load(ONE);
    const reply = (await handleA2A(app, {
      jsonrpc: "2.0",
      id: 1,
      method: "message/send",
      params: {},
    })) as { error: { code: number } };
    expect(reply.error.code).toBe(-32602);
  });
});

describe("the task methods that make a returned task useful", () => {
  it("finds again what message/send created", async () => {
    const app = await load(ONE);
    const tasks = new TaskStore();
    const made = (await handleA2A(app, send(ask("hi")), {}, tasks)) as { result: Task };

    const found = (await handleA2A(
      app,
      { jsonrpc: "2.0", id: 2, method: "tasks/get", params: { id: made.result.id } },
      {},
      tasks,
    )) as { result: Task };
    expect(found.result.id).toBe(made.result.id);
    expect(found.result.status.state).toBe("TASK_STATE_COMPLETED");
  });

  it("tells a missing task apart from a malformed request", async () => {
    // A caller polling a task that has been evicted needs to know which of the two
    // happened; collapsing them into -32602 makes an ordinary lifecycle event look
    // like a client bug.
    const app = await load(ONE);
    const gone = (await handleA2A(app, {
      jsonrpc: "2.0",
      id: 1,
      method: "tasks/get",
      params: { id: "task-nope" },
    })) as { error: { code: number } };
    const malformed = (await handleA2A(app, {
      jsonrpc: "2.0",
      id: 1,
      method: "tasks/get",
      params: {},
    })) as { error: { code: number } };

    expect(gone.error.code).toBe(-32001);
    expect(malformed.error.code).toBe(-32602);
  });

  it("lists tasks, and narrows to one conversation when asked", async () => {
    const app = await load(ONE);
    const tasks = new TaskStore();
    await handleA2A(app, send({ ...ask("a"), contextId: "ctx-a" }), {}, tasks);
    await handleA2A(app, send({ ...ask("b"), contextId: "ctx-b" }, 2), {}, tasks);

    const all = (await handleA2A(app, { jsonrpc: "2.0", id: 3, method: "tasks/list", params: {} }, {}, tasks)) as {
      result: { tasks: Task[] };
    };
    expect(all.result.tasks).toHaveLength(2);

    const narrowed = (await handleA2A(
      app,
      { jsonrpc: "2.0", id: 4, method: "tasks/list", params: { contextId: "ctx-a" } },
      {},
      tasks,
    )) as { result: { tasks: Task[] } };
    expect(narrowed.result.tasks.map((t) => t.contextId)).toEqual(["ctx-a"]);
  });

  it("will not cancel a task that already finished", async () => {
    const app = await load(ONE);
    const tasks = new TaskStore();
    const made = (await handleA2A(app, send(ask("hi")), {}, tasks)) as { result: Task };

    const reply = (await handleA2A(
      app,
      { jsonrpc: "2.0", id: 2, method: "tasks/cancel", params: { id: made.result.id } },
      {},
      tasks,
    )) as { error: { code: number; message: string } };
    expect(reply.error.code).toBe(-32002);
    expect(reply.error.message).toContain("already finished");
  });

  it("cancels a task that is still running, and the answer does not overwrite that", async () => {
    // The race worth having a test for: work finishes after the cancel lands. Writing
    // the answer over the cancellation would report a cancelled task as completed —
    // the one outcome a caller who cancelled is entitled not to see.
    const tasks = new TaskStore();
    tasks.put({
      id: "task-live",
      contextId: "ctx",
      status: { state: "TASK_STATE_WORKING", timestamp: new Date().toISOString() },
    });

    expect(tasks.cancel("task-live")?.status.state).toBe("TASK_STATE_CANCELED");
    expect(tasks.isCancelled("task-live")).toBe(true);
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

describe("methods the card says are unsupported", () => {
  it("refuses them, and says the card already said so", async () => {
    const app = await load(ONE);
    for (const method of [
      "message/sendStreaming",
      "tasks/subscribe",
      "tasks/pushNotificationConfigs/create",
      "agentCard/getExtended",
    ]) {
      const reply = (await handleA2A(app, { jsonrpc: "2.0", id: 1, method, params: {} })) as {
        error: { code: number; message: string };
      };
      expect(reply.error.code).toBe(-32601);
      expect(reply.error.message).toContain("capabilities");
    }
  });

  it("rejects a body that is not JSON-RPC at all", async () => {
    const app = await load(ONE);
    const reply = (await handleA2A(app, { method: "message/send" })) as { error: { code: number } };
    expect(reply.error.code).toBe(-32600);
  });
});
