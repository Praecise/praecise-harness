/**
 * The app, published as an A2A agent.
 *
 * MCP and A2A answer different questions and both are worth speaking. MCP publishes an
 * app as TOOLS, for a model to choose between mid-turn. A2A publishes it as an AGENT that
 * another agent delegates to: the unit of work is a task with a lifecycle, not a function
 * call with a return value, and the caller is a peer rather than a host.
 *
 * The practical difference is the task. An MCP `tools/call` either answers or fails within
 * the request. An A2A `message/send` may answer immediately, or return a task the caller
 * polls, cancels, or subscribes to — which is what makes A2A the right protocol for
 * delegating work that outlives one HTTP request.
 *
 * ── What this implements, and what it deliberately does not ───────────────────
 *
 * Implemented: agent card discovery, `message/send`, and the task methods that make a
 * returned task useful — `tasks/get`, `tasks/list`, `tasks/cancel`. Every agent, workflow
 * and function the app publishes becomes a skill, gated by exactly the same access rules
 * that gate it over MCP, because a second protocol must not be a second answer to "who
 * may run this".
 *
 * Not implemented: `message/sendStreaming` and `tasks/subscribe` (which need a streaming
 * transport this endpoint does not have), push notification configs (which need a
 * callback URL and a way to authenticate to it), and `agentCard/getExtended`. Each is
 * absent from the agent card's `capabilities` rather than declared and unimplemented —
 * a client trusts that card, and a claim we do not honour is worse than a missing feature.
 */

import { callPublished, groupsOf, toolsOf, type Caller } from "./mcp.js";
import type { App } from "../app.js";

/** The A2A revision this speaks. One version, no fallbacks — same rule as MCP. */
export const A2A_VERSION = "1.0.0";

/** Where a client looks for the card, per RFC 8615. Not a path we get to choose. */
export const AGENT_CARD_PATH = "/.well-known/agent-card.json";

/**
 * Task lifecycle states, spelled exactly as the protocol spells them.
 *
 * The `TASK_STATE_` prefix and SCREAMING_CASE come from the protocol being defined in
 * protobuf first, with JSON-RPC as a binding over it. It looks wrong in a JSON body and
 * is nonetheless what a conforming client matches on, so it is not tidied here.
 */
export type TaskState =
  | "TASK_STATE_SUBMITTED"
  | "TASK_STATE_WORKING"
  | "TASK_STATE_COMPLETED"
  | "TASK_STATE_FAILED"
  | "TASK_STATE_CANCELED"
  | "TASK_STATE_INPUT_REQUIRED"
  | "TASK_STATE_REJECTED"
  | "TASK_STATE_AUTH_REQUIRED";

/** One piece of a message. Only text parts are produced here; more are accepted. */
export interface Part {
  text?: string;
  data?: unknown;
  mediaType?: string;
  filename?: string;
  url?: string;
}

export interface A2AMessage {
  messageId: string;
  role: "user" | "agent";
  parts: Part[];
  contextId?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
}

export interface TaskStatus {
  state: TaskState;
  message?: A2AMessage;
  timestamp: string;
}

export interface Task {
  id: string;
  contextId: string;
  status: TaskStatus;
  artifacts?: { artifactId: string; name?: string; parts: Part[] }[];
  history?: A2AMessage[];
  metadata?: Record<string, unknown>;
}

/**
 * What a peer learns about this app before deciding to talk to it.
 *
 * The card is the whole of A2A discovery, and the skills on it are the app's published
 * surface filtered by what THIS caller may reach — the same filter `tools/list` applies
 * over MCP. Publishing the full list and refusing on call would tell an unauthorised
 * caller exactly what exists, which is the thing the MCP side is careful not to do.
 */
export function agentCard(app: App, caller: Caller = {}, baseUrl = ""): Record<string, unknown> {
  return {
    protocolVersion: A2A_VERSION,
    name: app.name,
    description: `${app.name}, published by Praecise Harness`,
    version: app.version,
    url: `${baseUrl}/a2a`,
    preferredTransport: "JSONRPC",
    capabilities: {
      // Declared honestly. Each of these needs a transport or a credential store this
      // endpoint does not have, and a client trusts this object.
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: true,
    },
    // No credential of our own is offered to a peer; the endpoint is bearer-gated by the
    // same token that gates everything else the server hosts.
    securitySchemes: {
      bearer: { type: "http", scheme: "bearer" },
    },
    security: [{ bearer: [] }],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: toolsOf(app, caller).map((tool) => ({
      id: tool.name,
      name: tool.name,
      description: tool.description,
      tags: groupsOf(app),
      inputModes: ["text/plain"],
      outputModes: ["text/plain"],
    })),
  };
}

/**
 * Tasks this server has accepted, by id.
 *
 * In memory and per-process on purpose, matched to what this endpoint promises: the card
 * declares no push notifications and no streaming, so a task's whole observable life is
 * between the `message/send` that created it and the `tasks/get` that reads it. Persisting
 * them would imply a durability the rest of the endpoint does not offer.
 */
export class TaskStore {
  private readonly tasks = new Map<string, Task>();
  /** Cancellation is cooperative: the flag is what a running call is checked against. */
  private readonly cancelled = new Set<string>();
  private readonly limit: number;

  constructor(limit = 1_000) {
    this.limit = limit;
  }

  put(task: Task): void {
    this.tasks.set(task.id, task);
    // Oldest-first eviction, because an unbounded map on a long-lived server is a leak
    // that only shows up in production.
    while (this.tasks.size > this.limit) {
      const oldest = this.tasks.keys().next().value;
      if (oldest === undefined) break;
      this.tasks.delete(oldest);
      this.cancelled.delete(oldest);
    }
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  list(contextId?: string): Task[] {
    const all = [...this.tasks.values()];
    return contextId ? all.filter((task) => task.contextId === contextId) : all;
  }

  /** Ask a task to stop. Returns the task if it was cancellable, nothing otherwise. */
  cancel(id: string): Task | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    if (task.status.state !== "TASK_STATE_SUBMITTED" && task.status.state !== "TASK_STATE_WORKING") {
      // A finished task cannot be cancelled, and saying so beats pretending.
      return task;
    }
    this.cancelled.add(id);
    task.status = { state: "TASK_STATE_CANCELED", timestamp: new Date().toISOString() };
    return task;
  }

  isCancelled(id: string): boolean {
    return this.cancelled.has(id);
  }
}

/** The text a message carries, joined across its parts. */
export function textOf(message: unknown): string {
  const parts = (message as { parts?: Part[] })?.parts ?? [];
  return parts
    .map((part) => (typeof part?.text === "string" ? part.text : part?.data !== undefined ? JSON.stringify(part.data) : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

/**
 * Which skill a message is asking for.
 *
 * A2A has no `name` field on a message — the protocol's model is that you talk to an
 * agent and it works out what you want. This app is a collection of named skills, so the
 * caller has to say which, and `metadata.skillId` is the conventional place. Falling back
 * to a single published skill is not a guess: if the app publishes exactly one thing,
 * there is nothing to be ambiguous about.
 */
export function skillFor(app: App, message: unknown, caller: Caller): string | undefined {
  const asked = (message as { metadata?: { skillId?: unknown } })?.metadata?.skillId;
  if (typeof asked === "string") return asked;
  const published = toolsOf(app, caller);
  return published.length === 1 ? published[0]?.name : undefined;
}

let counter = 0;
/** An id that is unique within this process and does not look guessable. */
function newId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

interface Request {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

/**
 * Answer one A2A JSON-RPC request.
 *
 * Shaped like `handleMcp` deliberately: same signature, same `Caller`, same access rules,
 * so that what an app publishes cannot drift between the two protocols it publishes over.
 */
export async function handleA2A(
  app: App,
  message: unknown,
  caller: Caller = {},
  tasks: TaskStore = shared(app),
): Promise<unknown | undefined> {
  const request = message as Request;
  const id = request?.id ?? null;

  const ok = (result: unknown) => ({ jsonrpc: "2.0" as const, id, result });
  const fail = (code: number, msg: string) => ({
    jsonrpc: "2.0" as const,
    id,
    error: { code, message: msg },
  });

  if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return fail(-32600, "invalid request");
  }

  switch (request.method) {
    case "message/send": {
      const sent = request.params?.message;
      if (!sent || typeof sent !== "object") return fail(-32602, "params.message is required");

      const skill = skillFor(app, sent, caller);
      if (!skill) {
        return fail(
          -32602,
          "message.metadata.skillId is required: this agent publishes several skills and " +
            "the protocol carries no name of its own",
        );
      }

      const contextId = (sent as { contextId?: string }).contextId ?? newId("ctx");
      const taskId = newId("task");
      const asked: A2AMessage = {
        messageId: (sent as { messageId?: string }).messageId ?? newId("msg"),
        role: "user",
        parts: (sent as { parts?: Part[] }).parts ?? [],
        contextId,
        taskId,
      };

      const task: Task = {
        id: taskId,
        contextId,
        status: { state: "TASK_STATE_WORKING", timestamp: new Date().toISOString() },
        history: [asked],
      };
      tasks.put(task);

      const input = textOf(sent);
      try {
        const { text, isError } = await callPublished(app, skill, { input }, caller);
        // A cancellation that arrived while the work was running wins. Overwriting it
        // with the answer would report a cancelled task as completed, which is the one
        // outcome a caller who cancelled is entitled not to see.
        if (tasks.isCancelled(taskId)) return ok(tasks.get(taskId));

        const answer: A2AMessage = {
          messageId: newId("msg"),
          role: "agent",
          parts: [{ text }],
          contextId,
          taskId,
        };
        task.status = {
          state: isError ? "TASK_STATE_FAILED" : "TASK_STATE_COMPLETED",
          message: answer,
          timestamp: new Date().toISOString(),
        };
        task.history = [...(task.history ?? []), answer];
        if (!isError) {
          task.artifacts = [{ artifactId: newId("art"), name: skill, parts: [{ text }] }];
        }
        return ok(task);
      } catch (err) {
        task.status = {
          state: "TASK_STATE_FAILED",
          message: {
            messageId: newId("msg"),
            role: "agent",
            parts: [{ text: (err as Error).message }],
            contextId,
            taskId,
          },
          timestamp: new Date().toISOString(),
        };
        return ok(task);
      }
    }

    case "tasks/get": {
      const wanted = request.params?.id ?? request.params?.name;
      if (typeof wanted !== "string") return fail(-32602, "params.id is required");
      const task = tasks.get(wanted);
      // -32001 is A2A's "task not found". Kept distinct from a malformed request:
      // a caller polling a task that has been evicted needs to know which happened.
      if (!task) return fail(-32001, `no task with id "${wanted}"`);
      return ok(task);
    }

    case "tasks/list":
      return ok({
        tasks: tasks.list(
          typeof request.params?.contextId === "string" ? request.params.contextId : undefined,
        ),
      });

    case "tasks/cancel": {
      const wanted = request.params?.id;
      if (typeof wanted !== "string") return fail(-32602, "params.id is required");
      const task = tasks.cancel(wanted);
      if (!task) return fail(-32001, `no task with id "${wanted}"`);
      if (task.status.state !== "TASK_STATE_CANCELED") {
        return fail(-32002, `task "${wanted}" has already finished and cannot be cancelled`);
      }
      return ok(task);
    }

    // Declared unsupported on the card, and refused here in the same words. A method
    // that is absent from `capabilities` and still answers is worse than one that does
    // not: it teaches a client to ignore the card.
    case "message/sendStreaming":
    case "tasks/subscribe":
    case "tasks/pushNotificationConfigs/create":
    case "tasks/pushNotificationConfigs/get":
    case "tasks/pushNotificationConfigs/list":
    case "tasks/pushNotificationConfigs/delete":
    case "agentCard/getExtended":
      return fail(
        -32601,
        `${request.method} is not supported by this agent; its card declares so under "capabilities"`,
      );

    default:
      return fail(-32601, `unknown method "${request.method}"`);
  }
}

/** One task store per app, so `tasks/get` can find what `message/send` created. */
const stores = new WeakMap<App, TaskStore>();
function shared(app: App): TaskStore {
  const found = stores.get(app);
  if (found) return found;
  const made = new TaskStore();
  stores.set(app, made);
  return made;
}
