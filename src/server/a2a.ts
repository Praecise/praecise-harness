/**
 * The app, published as an A2A agent.
 *
 * MCP and A2A answer different questions and both are worth speaking. MCP publishes an
 * app as TOOLS, for a model to choose between mid-turn. A2A publishes it as an AGENT that
 * another agent delegates to: the unit of work is a task with a lifecycle, not a function
 * call with a return value, and the caller is a peer rather than a host.
 *
 * The practical difference is the task. An MCP `tools/call` either answers or fails within
 * the request. An A2A `SendMessage` may answer immediately, or return a task the caller
 * polls, cancels, or subscribes to — which is what makes A2A the right protocol for
 * delegating work that outlives one HTTP request.
 *
 * ── Two versions, one endpoint ────────────────────────────────────────────────
 *
 * A2A 1.0 renamed every method, dropped the `kind` discriminators, and spelled its enums
 * in upper snake case. That is the shape this file thinks in: a `Task`, a `Part` and a
 * `TaskState` here are 1.0's. A 0.3 caller is still answered, in 0.3's shape, because
 * 0.3 agents are deployed and a server can serve both from one store — the difference is
 * spelling, and it is confined to the functions under "The 0.3 spelling" below.
 *
 * Which version a request speaks is read from its `A2A-Version` header, and from the
 * method name where there is no header: the protocol says a request without one is 0.3,
 * but a request that calls `SendMessage` has said which version it is as plainly as a
 * header would. A header and a method name that disagree are refused, naming both.
 * This is unlike the MCP endpoint, which serves one revision: there the older clients
 * cannot be told apart cheaply, and here each request says what it is.
 *
 * ── What this implements, and what it deliberately does not ───────────────────
 *
 * Implemented: agent card discovery; `SendMessage`, blocking or returning at once;
 * `SendStreamingMessage` and `SubscribeToTask`, as a stream of events; and the task
 * methods that make a returned task useful — `GetTask`, `ListTasks`, `CancelTask`. Each
 * under its 0.3 name as well. Every agent, workflow and function the app publishes
 * becomes a skill, gated by exactly the same access rules that gate it over MCP, because
 * a second protocol must not be a second answer to "who may run this".
 *
 * Also implemented, for 1.0 callers: push notifications (a task's changes POSTed to a
 * webhook the caller registered, authenticated the way the caller asked); the
 * HTTP+JSON binding beside JSON-RPC, at the same address and through the same code
 * (`restA2A`); a signed agent card where the app has a signing key (`a2a-card.ts`); and
 * A2UI surfaces, carried as the data part the A2UI extension defines.
 *
 * Not implemented: the extended agent card, the gRPC binding, and push notifications
 * for 0.3 callers. Each is absent from the card rather than declared and unimplemented:
 * a client trusts that card, and a claim we do not honour is worse than a missing
 * feature. gRPC needs a second listener speaking HTTP/2 with TLS and a protobuf codec
 * for every message; it is not listed under `supportedInterfaces`, so a client never
 * dials it.
 *
 * An approval gate is not answered here either. A workflow that stops at one surfaces as
 * `TASK_STATE_INPUT_REQUIRED`, and the task follows the run once a person has decided,
 * but the decision is made where the gate says it is made. A message from a peer agent
 * is not a person's approval, and reading "yes" out of one would make it so.
 */

import { callPublished, groupsOf, outcomeOf, toolsOf, type Caller } from "./mcp.js";
import type { App } from "../app.js";
import type { Progress } from "../harness/types.js";
import { outboundFault, type OutboundOptions } from "../outbound.js";
import { safeMessage } from "../redact.js";
import { postWithRetries, type DeliverWebhookOptions } from "../webhooks.js";
import { A2UI_EXTENSION_URI, A2UI_MEDIA_TYPE, a2uiTurn, surfaceTool, type A2uiMessage } from "./a2ui.js";

/** A version of A2A this endpoint answers, as `Major.Minor` — how the protocol names one. */
export type A2AVersion = "1.0" | "0.3";

/** The A2A version this speaks first, as it goes in `A2A-Version` and on the card. */
export const A2A_VERSION = "1.0";

/** The earlier version still answered, for the callers that have not moved. */
export const A2A_LEGACY_VERSION = "0.3";

/** The media type 1.0 prefers for its JSON. `application/json` is still accepted. */
export const A2A_MEDIA_TYPE = "application/a2a+json";

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

/**
 * One piece of a message: exactly one of `text`, `raw`, `url` or `data`, and what it is.
 * Text parts are produced here, and data parts for an A2UI surface; the others are
 * accepted.
 */
export interface Part {
  text?: string;
  /** Bytes, base64-encoded. */
  raw?: string;
  url?: string;
  data?: unknown;
  mediaType?: string;
  filename?: string;
  /** Where an extension says what a part is: A2UI marks its data parts here. */
  metadata?: Record<string, unknown>;
}

/**
 * Where a task's changes are sent, as a caller registered it.
 *
 * `authentication` is what goes in the `Authorization` header of each notification:
 * the scheme and the credentials, exactly as given. `token` is the caller's own value
 * for telling its tasks apart.
 */
export interface PushConfig {
  id: string;
  taskId: string;
  url: string;
  token?: string;
  authentication?: { scheme: string; credentials?: string };
}

/** How this endpoint behaves where an operator has a say. */
export interface A2AOptions {
  /**
   * Push notifications: how they are delivered, and which receivers are allowed.
   *
   * A webhook URL arrives from a caller, so it is held to `outboundFault`'s rules
   * (https, no private or loopback address) unless its host is in `allowHosts`. The
   * delivery options are `deliverWebhook`'s: attempts, budget, timeout, and the fetch.
   */
  push?: OutboundOptions & DeliverWebhookOptions;
}

export interface A2AMessage {
  messageId: string;
  role: "ROLE_USER" | "ROLE_AGENT";
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

export interface Artifact {
  artifactId: string;
  name?: string;
  parts: Part[];
}

export interface Task {
  id: string;
  contextId: string;
  status: TaskStatus;
  artifacts?: Artifact[];
  history?: A2AMessage[];
  metadata?: Record<string, unknown>;
}

/**
 * Something that happened to a task, as a stream carries it.
 *
 * The property name says which it is. There is no `final` flag: a stream is over when a
 * status arrives that work does not continue from.
 */
export type TaskEvent =
  | { statusUpdate: { taskId: string; contextId: string; status: TaskStatus; metadata?: Record<string, unknown> } }
  | { artifactUpdate: { taskId: string; contextId: string; artifact: Artifact; append: boolean; lastChunk: boolean } };

/** Where a task records the workflow run it is waiting on, and the gate it stopped at. */
const RUN_KEY = "com.praecise/run";
const STEP_KEY = "com.praecise/step";

/** Whether work continues from this state. Everything else ends a stream. */
function live(state: TaskState): boolean {
  return state === "TASK_STATE_SUBMITTED" || state === "TASK_STATE_WORKING";
}

/** Whether a task in this state is finished for good. A task waiting on a person is not. */
function terminal(state: TaskState): boolean {
  return (
    state === "TASK_STATE_COMPLETED" ||
    state === "TASK_STATE_FAILED" ||
    state === "TASK_STATE_CANCELED" ||
    state === "TASK_STATE_REJECTED"
  );
}

/**
 * What a peer learns about this app before deciding to talk to it.
 *
 * The card is the whole of A2A discovery, and the skills on it are the app's published
 * surface filtered by what THIS caller may reach — the same filter `tools/list` applies
 * over MCP. Publishing the full list and refusing on call would tell an unauthorised
 * caller exactly what exists, which is the thing the MCP side is careful not to do.
 *
 * `version` chooses the card's shape. The 1.0 card names its endpoint under
 * `supportedInterfaces`, once per version answered there; the 0.3 card has the single
 * `url` and `preferredTransport` a 0.3 client reads. They are two documents and not one
 * with both sets of fields, because `securitySchemes` has the same name and a different
 * shape in each.
 */
export function agentCard(
  app: App,
  caller: Caller = {},
  baseUrl = "",
  version: A2AVersion = A2A_VERSION,
): Record<string, unknown> {
  const url = `${baseUrl}/a2a`;
  const described = {
    name: app.name,
    description: `${app.name}, published by Praecise Harness`,
    version: app.version,
  };
  const offered = {
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

  if (version === "0.3") {
    return {
      protocolVersion: "0.3.0",
      ...described,
      url,
      preferredTransport: "JSONRPC",
      capabilities: {
        streaming: true,
        pushNotifications: false,
        // What is kept is the messages exchanged, not each state a task passed through.
        stateTransitionHistory: false,
      },
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
      security: [{ bearer: [] }],
      supportsAuthenticatedExtendedCard: false,
      ...offered,
    };
  }

  return {
    ...described,
    // One endpoint, listed once for each version it answers. A client picks the entry
    // whose version it speaks and says so in `A2A-Version`.
    // The HTTP+JSON binding is served under the same address (`/a2a/message:send` and
    // the rest), in 1.0 only: its paths are 1.0's. gRPC is not listed because it is not
    // served.
    supportedInterfaces: [
      { url, protocolBinding: "JSONRPC", protocolVersion: A2A_VERSION },
      { url, protocolBinding: "HTTP+JSON", protocolVersion: A2A_VERSION },
      { url, protocolBinding: "JSONRPC", protocolVersion: A2A_LEGACY_VERSION },
    ],
    capabilities: {
      // Declared honestly. Streaming is `SendStreamingMessage` and `SubscribeToTask`;
      // push notifications are the four config methods and the delivery behind them.
      // There is no second card, and a client trusts this object.
      streaming: true,
      pushNotifications: true,
      extendedAgentCard: false,
      // An agent of this app can send an A2UI surface to a renderer that offers a
      // catalog. Optional for the client: nothing is sent to one that offers none.
      ...(app.agentNames.length
        ? {
            extensions: [
              {
                uri: A2UI_EXTENSION_URI,
                description: "Agents of this app can answer with A2UI 1.0 surfaces, in whichever catalog the renderer offers.",
                required: false,
                params: { acceptsInlineCatalogs: false },
              },
            ],
          }
        : {}),
    },
    // No credential of our own is offered to a peer; the endpoint is bearer-gated by the
    // same token that gates everything else the server hosts.
    securitySchemes: {
      bearer: { httpAuthSecurityScheme: { scheme: "Bearer" } },
    },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    ...offered,
  };
}

/**
 * Tasks this server has accepted, by id.
 *
 * In memory and per-process on purpose, matched to what this endpoint promises: a task
 * is worked on by this process, and is observed by asking for it, by holding a stream
 * open, or by a push notification this process sends. Persisting tasks would imply a
 * durability the rest of the endpoint does not offer. A push notification config lives
 * exactly as long as its task does.
 */
export class TaskStore {
  /** The most recent push notification that did not arrive, as a sentence for an operator. */
  pushFailure?: string;

  private readonly tasks = new Map<string, Task>();
  /** Where each task's changes are sent, by task and then by config id. */
  private readonly pushes = new Map<string, Map<string, PushConfig>>();
  /** One line of deliveries per config, so a receiver hears a task's changes in order. */
  private readonly sending = new Map<string, Promise<void>>();
  private readonly shown = new Map<string, Set<string>>();
  private readonly options: A2AOptions;
  /** Cancellation is cooperative: the flag is what a running call is checked against. */
  private readonly cancelled = new Set<string>();
  /** The work this process is doing for a task, so that cancelling one can stop it. */
  private readonly running = new Map<string, AbortController>();
  /** Who is following each task. A stream is one of these for as long as it is open. */
  private readonly watchers = new Map<string, Set<(event: TaskEvent) => void>>();
  private readonly limit: number;

  constructor(limit = 1_000, options: A2AOptions = {}) {
    this.limit = limit;
    this.options = options;
  }

  /** The rules a webhook address is held to, for whoever registers one. */
  get outbound(): OutboundOptions {
    return this.options.push ?? {};
  }

  /** Register where a task's changes go. Replaces a config of the same id. */
  setPush(config: PushConfig): void {
    const forTask = this.pushes.get(config.taskId) ?? new Map<string, PushConfig>();
    this.pushes.set(config.taskId, forTask);
    forTask.set(config.id, config);
  }

  getPush(taskId: string, id: string): PushConfig | undefined {
    return this.pushes.get(taskId)?.get(id);
  }

  listPush(taskId: string): PushConfig[] {
    return [...(this.pushes.get(taskId)?.values() ?? [])];
  }

  /** Stop sending to one config. True whether or not it existed: deleting is idempotent. */
  deletePush(taskId: string, id: string): boolean {
    this.pushes.get(taskId)?.delete(id);
    return true;
  }

  /**
   * The A2UI surfaces a conversation's renderer is showing: created and not deleted.
   *
   * Kept by context and not by task, because a surface outlives the task that drew it:
   * the next message in the conversation may update it. Bounded like the tasks are.
   */
  surfaces(contextId: string): Set<string> {
    const known = this.shown.get(contextId);
    if (known) return known;
    const made = new Set<string>();
    this.shown.set(contextId, made);
    while (this.shown.size > this.limit) {
      const oldest = this.shown.keys().next().value;
      if (oldest === undefined) break;
      this.shown.delete(oldest);
    }
    return made;
  }

  /** Resolves once every notification queued so far has been delivered or given up on. */
  async pushed(): Promise<void> {
    while (this.sending.size) await Promise.all(this.sending.values());
  }

  /**
   * Tell a task's webhooks what just happened to it.
   *
   * What a stream would carry, less the fragments: every change of status, each whole
   * artifact, and the task itself once it stops, so a receiver that only listens for
   * the end still gets what the work produced. A fragment of an answer is for a reader
   * holding a connection open, and one POST per fragment is not a notification.
   *
   * Returns at once. Delivery is behind the task and cannot fail it: a receiver that
   * is down is written to `pushFailure`, and the task is still there to be asked for.
   */
  private notify(id: string, event: TaskEvent): void {
    const configs = this.pushes.get(id);
    if (!configs?.size) return;

    const payloads: unknown[] = [];
    if ("statusUpdate" in event) {
      payloads.push(structuredClone(event));
      const task = this.tasks.get(id);
      if (task && !live(event.statusUpdate.status.state)) payloads.push({ task: taskFor("1.0", task) });
    } else if (!event.artifactUpdate.append && event.artifactUpdate.lastChunk) {
      payloads.push(structuredClone(event));
    }
    if (!payloads.length) return;

    for (const config of configs.values()) {
      const line = `${id}/${config.id}`;
      const next = (this.sending.get(line) ?? Promise.resolve()).then(async () => {
        for (const payload of payloads) await this.post(config, payload);
        return undefined;
      });
      this.sending.set(line, next);
      void next.then(() => {
        if (this.sending.get(line) === next) this.sending.delete(line);
        return undefined;
      });
    }
  }

  /** One notification to one webhook. Never rejects. */
  private async post(config: PushConfig, payload: unknown): Promise<void> {
    let why: string | undefined;
    try {
      // Checked again at the moment of sending: a name that resolved somewhere public
      // when it was registered may not an hour later.
      why = await outboundFault(config.url, this.outbound);
      if (!why) {
        const headers: Record<string, string> = {
          // "WebHook calls use plain HTTP and the JSON payloads as defined in the HTTP
          // protocol binding", whichever binding the caller registered over.
          "content-type": A2A_MEDIA_TYPE,
          ...(config.authentication
            ? { authorization: `${config.authentication.scheme} ${config.authentication.credentials ?? ""}`.trim() }
            : {}),
          // 1.0 defines the token and not where it travels. This is the header 0.3
          // receivers already read it from.
          ...(config.token ? { "x-a2a-notification-token": config.token } : {}),
        };
        const sent = await postWithRetries(config.url, JSON.stringify(payload), () => headers, this.options.push ?? {});
        if (!sent.delivered) {
          why = `${sent.error ?? "it was not accepted"}, after ${sent.attempts} attempt${sent.attempts === 1 ? "" : "s"}`;
        }
      }
    } catch (err) {
      why = safeMessage(err, "a2a push");
    }
    if (why) {
      this.pushFailure =
        `a push notification for task ${config.taskId} did not reach ${hostOf(config.url)} at ${new Date().toISOString()}: ${why}. ` +
        `The task itself is unaffected, and GetTask returns what the notification would have said.`;
    }
  }

  put(task: Task): void {
    this.tasks.set(task.id, task);
    // Oldest-first eviction, because an unbounded map on a long-lived server is a leak
    // that only shows up in production.
    while (this.tasks.size > this.limit) {
      const oldest = this.tasks.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.tasks.get(oldest);
      this.tasks.delete(oldest);
      this.cancelled.delete(oldest);
      this.running.get(oldest)?.abort();
      this.running.delete(oldest);
      // A stream still following it is told it is over, or it would wait for an event
      // that can no longer arrive.
      if (evicted && live(evicted.status.state)) {
        this.emit(oldest, {
          statusUpdate: {
            taskId: oldest,
            contextId: evicted.contextId,
            status: { state: "TASK_STATE_FAILED", timestamp: new Date().toISOString() },
          },
        });
      }
      this.watchers.delete(oldest);
      this.pushes.delete(oldest);
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
    if (terminal(task.status.state)) {
      // A finished task cannot be cancelled, and saying so beats pretending.
      return task;
    }
    this.cancelled.add(id);
    task.status = { state: "TASK_STATE_CANCELED", timestamp: new Date().toISOString() };
    this.running.get(id)?.abort();
    this.emit(id, { statusUpdate: { taskId: id, contextId: task.contextId, status: task.status } });
    return task;
  }

  isCancelled(id: string): boolean {
    return this.cancelled.has(id);
  }

  /** Mark work as begun for a task. The signal aborts if the task is cancelled. */
  begin(id: string): AbortSignal {
    const controller = new AbortController();
    this.running.set(id, controller);
    return controller.signal;
  }

  /** Mark that work as over, however it ended. */
  end(id: string): void {
    this.running.delete(id);
  }

  /** Whether this process is doing work for the task right now. */
  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  /** Follow a task's events. Returns the function that stops following. */
  watch(id: string, watcher: (event: TaskEvent) => void): () => void {
    const set = this.watchers.get(id) ?? new Set();
    this.watchers.set(id, set);
    set.add(watcher);
    return () => {
      set.delete(watcher);
      if (!set.size && this.watchers.get(id) === set) this.watchers.delete(id);
    };
  }

  /** Tell whoever is following a task what just happened to it. */
  emit(id: string, event: TaskEvent): void {
    for (const watcher of this.watchers.get(id) ?? []) watcher(event);
    this.notify(id, event);
  }
}

/** A receiver without its path and query, which is where a URL keeps anything secret. */
function hostOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "its webhook";
  }
}

/** The text a message carries, joined across its parts. */
export function textOf(message: unknown): string {
  const parts = (message as { parts?: Part[] })?.parts ?? [];
  return parts
    // What came back from an A2UI surface is read as what it means (`a2uiOf`), not
    // pasted in as JSON.
    .filter((part) => !isA2ui(part))
    .map((part) => (typeof part?.text === "string" ? part.text : part?.data !== undefined ? JSON.stringify(part.data) : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

/** Whether a part is a list of A2UI messages, as the A2UI extension marks one. */
function isA2ui(part: Part | undefined): boolean {
  return part?.data !== undefined && (part.metadata?.mimeType === A2UI_MEDIA_TYPE || part.mediaType === A2UI_MEDIA_TYPE);
}

/**
 * What a message carries of A2UI: the catalogs its renderer offers for this turn, and
 * what a person did on a surface, as text for the run.
 *
 * The capabilities and the data model ride on the message's metadata, and the actions
 * in its data parts. A message with no capabilities has offered no A2UI for this turn,
 * however the conversation went before.
 */
function a2uiOf(metadata: Record<string, unknown> | undefined, parts: Part[]): { catalogs?: string[]; text: string } {
  const events = parts.filter(isA2ui).flatMap((part) => (Array.isArray(part.data) ? (part.data as unknown[]) : [part.data]));
  const { catalogs, text } = a2uiTurn({
    capabilities: metadata?.a2uiRendererCapabilities,
    dataModel: metadata?.a2uiRendererDataModel,
    ...(events.length ? { events } : {}),
  });
  return { ...(catalogs ? { catalogs } : {}), text };
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

// ── The 0.3 spelling ───────────────────────────────────────────────────────────
//
// Everything a 0.3 caller sees that differs from 1.0 is written here and nowhere else:
// a `kind` on each object, lower-case states and roles, files nested under `file`, and
// `final` on a status event.

/** `TASK_STATE_INPUT_REQUIRED` as 0.3 wrote it: `input-required`. */
function legacyState(state: TaskState): string {
  return state.slice("TASK_STATE_".length).toLowerCase().replace("_", "-");
}

function legacyPart(part: Part): Record<string, unknown> {
  if (typeof part.text === "string") return { kind: "text", text: part.text };
  if (part.url !== undefined || part.raw !== undefined) {
    return {
      kind: "file",
      file: {
        ...(part.url !== undefined ? { uri: part.url } : { bytes: part.raw }),
        ...(part.mediaType ? { mimeType: part.mediaType } : {}),
        ...(part.filename ? { name: part.filename } : {}),
      },
    };
  }
  return { kind: "data", data: part.data, ...(part.metadata ? { metadata: part.metadata } : {}) };
}

function legacyMessage(message: A2AMessage): Record<string, unknown> {
  return {
    ...message,
    kind: "message",
    role: message.role === "ROLE_USER" ? "user" : "agent",
    parts: message.parts.map(legacyPart),
  };
}

function legacyStatus(status: TaskStatus): Record<string, unknown> {
  return {
    state: legacyState(status.state),
    ...(status.message ? { message: legacyMessage(status.message) } : {}),
    timestamp: status.timestamp,
  };
}

function legacyArtifact(artifact: Artifact): Record<string, unknown> {
  return { ...artifact, parts: artifact.parts.map(legacyPart) };
}

/**
 * The parts of a message as received, in this file's shape.
 *
 * Read by what each part carries and not by the version the request declared, so a
 * caller that mixed the two is understood rather than answered with an empty prompt.
 */
function partsFrom(given: unknown): Part[] {
  if (!Array.isArray(given)) return [];
  return given.flatMap((entry): Part[] => {
    if (!entry || typeof entry !== "object") return [];
    const raw = entry as Record<string, unknown>;
    const file = raw.file && typeof raw.file === "object" ? (raw.file as Record<string, unknown>) : undefined;
    const part: Part = {};

    if (typeof raw.text === "string") part.text = raw.text;
    else if (typeof raw.url === "string") part.url = raw.url;
    else if (typeof raw.raw === "string") part.raw = raw.raw;
    else if (typeof file?.uri === "string") part.url = file.uri;
    else if (typeof file?.bytes === "string") part.raw = file.bytes;
    else if (raw.data !== undefined) part.data = raw.data;
    else return [];

    const mediaType = raw.mediaType ?? file?.mimeType;
    const filename = raw.filename ?? file?.name;
    if (typeof mediaType === "string") part.mediaType = mediaType;
    if (typeof filename === "string") part.filename = filename;
    if (raw.metadata && typeof raw.metadata === "object" && !Array.isArray(raw.metadata)) {
      part.metadata = raw.metadata as Record<string, unknown>;
    }
    return [part];
  });
}

// ── What goes on the wire ──────────────────────────────────────────────────────

/** A task as one version's caller reads it, with as much history as it asked for. */
function taskFor(
  version: A2AVersion,
  task: Task,
  shown: { historyLength?: number; artifacts?: boolean } = {},
): Record<string, unknown> {
  const history =
    shown.historyLength === undefined
      ? task.history
      : shown.historyLength === 0
        ? undefined
        : task.history?.slice(-shown.historyLength);
  const artifacts = shown.artifacts === false ? undefined : task.artifacts;

  if (version === "0.3") {
    return {
      kind: "task",
      id: task.id,
      contextId: task.contextId,
      status: legacyStatus(task.status),
      ...(artifacts ? { artifacts: artifacts.map(legacyArtifact) } : {}),
      ...(history ? { history: history.map(legacyMessage) } : {}),
      ...(task.metadata ? { metadata: task.metadata } : {}),
    };
  }
  // Copied, because the task goes on changing while work continues and what was
  // answered must stay what was answered.
  return structuredClone({
    id: task.id,
    contextId: task.contextId,
    status: task.status,
    ...(artifacts ? { artifacts } : {}),
    ...(history ? { history } : {}),
    ...(task.metadata ? { metadata: task.metadata } : {}),
  });
}

/** One frame of a stream. In 1.0 a property names what it is; in 0.3 a `kind` did. */
function frameFor(version: A2AVersion, event: TaskEvent | { task: Task }): Record<string, unknown> {
  if ("task" in event) {
    return version === "0.3" ? taskFor(version, event.task) : { task: taskFor(version, event.task) };
  }
  if (version === "1.0") return structuredClone(event);
  if ("statusUpdate" in event) {
    const { status, ...rest } = event.statusUpdate;
    return { kind: "status-update", ...rest, status: legacyStatus(status), final: !live(status.state) };
  }
  const { artifact, ...rest } = event.artifactUpdate;
  return { kind: "artifact-update", ...rest, artifact: legacyArtifact(artifact) };
}

/** Whether a stream has said its last: a status that work does not continue from. */
function closes(event: TaskEvent): boolean {
  return "statusUpdate" in event && !live(event.statusUpdate.status.state);
}

// ── Which version, and which operation ─────────────────────────────────────────

type Operation =
  | "send"
  | "stream"
  | "get"
  | "list"
  | "cancel"
  | "subscribe"
  | "pushCreate"
  | "pushGet"
  | "pushList"
  | "pushDelete"
  /** A 0.3 push method: the 0.3 card declares none, and they are refused by name. */
  | "push"
  | "card";

/**
 * Every method name either version defines, and what it asks for.
 *
 * `tasks/list` was never in 0.3; this endpoint answered it before 1.0 gave the operation
 * a name, and still does, so that a caller who relied on it is not broken by an upgrade.
 */
const METHODS: Record<string, { does: Operation; speaks: A2AVersion }> = {
  SendMessage: { does: "send", speaks: "1.0" },
  SendStreamingMessage: { does: "stream", speaks: "1.0" },
  GetTask: { does: "get", speaks: "1.0" },
  ListTasks: { does: "list", speaks: "1.0" },
  CancelTask: { does: "cancel", speaks: "1.0" },
  SubscribeToTask: { does: "subscribe", speaks: "1.0" },
  CreateTaskPushNotificationConfig: { does: "pushCreate", speaks: "1.0" },
  GetTaskPushNotificationConfig: { does: "pushGet", speaks: "1.0" },
  ListTaskPushNotificationConfigs: { does: "pushList", speaks: "1.0" },
  DeleteTaskPushNotificationConfig: { does: "pushDelete", speaks: "1.0" },
  GetExtendedAgentCard: { does: "card", speaks: "1.0" },

  "message/send": { does: "send", speaks: "0.3" },
  "message/stream": { does: "stream", speaks: "0.3" },
  "tasks/get": { does: "get", speaks: "0.3" },
  "tasks/list": { does: "list", speaks: "0.3" },
  "tasks/cancel": { does: "cancel", speaks: "0.3" },
  "tasks/resubscribe": { does: "subscribe", speaks: "0.3" },
  "tasks/pushNotificationConfig/set": { does: "push", speaks: "0.3" },
  "tasks/pushNotificationConfig/get": { does: "push", speaks: "0.3" },
  "tasks/pushNotificationConfig/list": { does: "push", speaks: "0.3" },
  "tasks/pushNotificationConfig/delete": { does: "push", speaks: "0.3" },
  "agent/getAuthenticatedExtendedCard": { does: "card", speaks: "0.3" },
};

/** A2A's own error codes, and the reason each is given under in a 1.0 error's details. */
const TASK_NOT_FOUND = -32001;
const TASK_NOT_CANCELABLE = -32002;
const PUSH_NOT_SUPPORTED = -32003;
const UNSUPPORTED_OPERATION = -32004;
/** The spec's own code for "there is no extended card here", distinct from an unsupported method. */
const EXTENDED_CARD_NOT_CONFIGURED = -32007;
const VERSION_NOT_SUPPORTED = -32009;

const REASONS: Record<number, string> = {
  [TASK_NOT_FOUND]: "TASK_NOT_FOUND",
  [TASK_NOT_CANCELABLE]: "TASK_NOT_CANCELABLE",
  [PUSH_NOT_SUPPORTED]: "PUSH_NOTIFICATION_NOT_SUPPORTED",
  [UNSUPPORTED_OPERATION]: "UNSUPPORTED_OPERATION",
  [EXTENDED_CARD_NOT_CONFIGURED]: "EXTENDED_AGENT_CARD_NOT_CONFIGURED",
  [VERSION_NOT_SUPPORTED]: "VERSION_NOT_SUPPORTED",
};

interface Request {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

/** How to answer one request: the two envelopes, in the version it spoke. */
interface Reply {
  ok(result: unknown): unknown;
  fail(code: number, message: string, metadata?: Record<string, string>): unknown;
}

function replyTo(id: Request["id"], version: A2AVersion): Reply {
  return {
    ok: (result) => ({ jsonrpc: "2.0" as const, id: id ?? null, result }),
    fail: (code, message, metadata = {}) => {
      const reason = REASONS[code];
      return {
        jsonrpc: "2.0" as const,
        id: id ?? null,
        error: {
          code,
          message,
          // 1.0 says WHICH error in a form a program reads without parsing the message:
          // the `google.rpc.ErrorInfo` detail. 0.3 had the code and the message only.
          ...(version === "1.0" && reason
            ? {
                data: [
                  {
                    "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                    reason,
                    domain: "a2a-protocol.org",
                    metadata,
                  },
                ],
              }
            : {}),
        },
      };
    },
  };
}

/**
 * What each error is over HTTP: the status, and the name `google.rpc.Status` gives it.
 * From the specification's table of error mappings, with JSON-RPC's own codes beside.
 */
const HTTP_OF: Record<number, [number, string]> = {
  [TASK_NOT_FOUND]: [404, "NOT_FOUND"],
  [TASK_NOT_CANCELABLE]: [400, "FAILED_PRECONDITION"],
  [PUSH_NOT_SUPPORTED]: [400, "FAILED_PRECONDITION"],
  [UNSUPPORTED_OPERATION]: [400, "FAILED_PRECONDITION"],
  [EXTENDED_CARD_NOT_CONFIGURED]: [400, "FAILED_PRECONDITION"],
  [VERSION_NOT_SUPPORTED]: [400, "FAILED_PRECONDITION"],
  [-32600]: [400, "INVALID_ARGUMENT"],
  [-32601]: [404, "NOT_FOUND"],
  [-32602]: [400, "INVALID_ARGUMENT"],
};

/**
 * The same two envelopes for the HTTP+JSON binding.
 *
 * There a result is the body itself, and an error is a `google.rpc.Status` whose `code`
 * is the HTTP status it is sent with. Several errors share a status, so which one it is
 * goes in an `ErrorInfo` detail, as it does in a 1.0 JSON-RPC error.
 */
const restReply: Reply = {
  ok: (result) => result,
  fail: (code, message, metadata = {}) => {
    const [status, name] = HTTP_OF[code] ?? [500, "INTERNAL"];
    const reason = REASONS[code];
    return {
      error: {
        code: status,
        status: name,
        message,
        ...(reason
          ? { details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, domain: "a2a-protocol.org", metadata }] }
          : {}),
      },
    };
  },
};

/** One header, whatever case the transport kept it in. */
function headerOf(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
}

/**
 * Work out what a request is asking for and how to answer it, or refuse it.
 *
 * The version comes from the header first. With no header it comes from the method name,
 * and a name neither version knows is answered as 0.3, which is what the protocol says a
 * request with no header is.
 */
function entering(
  request: Request,
  caller: Caller,
): { refused: unknown } | { does: Operation; version: A2AVersion; reply: Reply } {
  if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return { refused: replyTo(request?.id, A2A_VERSION).fail(-32600, "invalid request") };
  }

  const method = request.method;
  const known = METHODS[method];
  const header = (headerOf(caller.headers, "a2a-version") ?? "").trim();

  let version: A2AVersion;
  if (!header) version = known?.speaks ?? A2A_LEGACY_VERSION;
  else if (/^1\.0(\.\d+)?$/.test(header)) version = "1.0";
  else if (/^0\.3(\.\d+)?$/.test(header)) version = "0.3";
  else {
    return {
      refused: replyTo(request.id, A2A_VERSION).fail(
        VERSION_NOT_SUPPORTED,
        `A2A-Version "${header}" is not one this agent speaks; it speaks ${A2A_VERSION} and ${A2A_LEGACY_VERSION}`,
        { requested: header, supported: `${A2A_VERSION}, ${A2A_LEGACY_VERSION}` },
      ),
    };
  }

  const reply = replyTo(request.id, version);
  if (!known) return { refused: reply.fail(-32601, `unknown method "${method}"`) };
  if (known.speaks !== version) {
    const there = Object.entries(METHODS).find(
      ([name, other]) => other.does === known.does && other.speaks === version && name !== method,
    )?.[0];
    return {
      refused: reply.fail(
        -32601,
        `"${method}" is a method of A2A ${known.speaks}, and this request's A2A-Version header says ${version}` +
          (there ? `, where it is called "${there}"` : ""),
      ),
    };
  }
  return { does: known.does, version, reply };
}

/** Whether a request is one that is answered with a stream of events. */
export function streamsA2A(message: unknown): boolean {
  const method = (message as Request | undefined)?.method;
  const does = typeof method === "string" ? METHODS[method]?.does : undefined;
  return does === "stream" || does === "subscribe";
}

// ── Doing the work ─────────────────────────────────────────────────────────────

/** A `historyLength` a caller sent, if it is one. */
function lengthOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Take in a message: refuse it, find the task it continues, or open a new one.
 *
 * Shared by the blocking and the streaming send, so that the two cannot come to accept
 * different things.
 */
async function opening(
  app: App,
  tasks: TaskStore,
  params: Record<string, unknown>,
  caller: Caller,
  reply: Reply,
  version: A2AVersion = A2A_VERSION,
): Promise<{ refused: unknown } | { existing: Task } | Opened> {
  const sent = params.message as Record<string, unknown> | undefined;
  if (!sent || typeof sent !== "object") return { refused: reply.fail(-32602, "params.message is required") };

  const configuration = (params.configuration ?? {}) as Record<string, unknown>;
  if (configuration.pushNotificationConfig !== undefined || (version === "0.3" && configuration.taskPushNotificationConfig !== undefined)) {
    // Refused and not ignored: a caller that asked to be called back and was not told no
    // would wait for a notification that is never sent. This is the 0.3 field; the 0.3
    // card declares no push notifications, and a 1.0 caller has another name for it.
    return {
      refused: reply.fail(
        PUSH_NOT_SUPPORTED,
        version === "0.3"
          ? `push notifications are not supported for A2A 0.3 callers; this agent's 0.3 card declares so under "capabilities"`
          : `"pushNotificationConfig" is the A2A 0.3 field; in 1.0 it is "taskPushNotificationConfig"`,
      ),
    };
  }
  // Checked before a task exists, so a webhook that is refused leaves nothing behind.
  let push: Omit<PushConfig, "taskId"> | undefined;
  if (configuration.taskPushNotificationConfig !== undefined) {
    const read = await pushFrom(configuration.taskPushNotificationConfig, tasks);
    if (typeof read === "string") return { refused: reply.fail(-32602, `configuration.taskPushNotificationConfig: ${read}`) };
    push = read;
  }

  // A message addressed to a task continues it, and the only tasks here that can be
  // continued are the ones waiting on a person — whose answer does not come this way.
  if (typeof sent.taskId === "string") {
    const existing = tasks.get(sent.taskId);
    if (!existing) return { refused: reply.fail(TASK_NOT_FOUND, `no task with id "${sent.taskId}"`, { taskId: sent.taskId }) };
    await settle(app, tasks, existing);
    if (existing.status.state !== "TASK_STATE_INPUT_REQUIRED") {
      return {
        refused: reply.fail(
          UNSUPPORTED_OPERATION,
          `task "${sent.taskId}" ${live(existing.status.state) ? "is still being worked on" : "has finished"} and takes no further ` +
            `messages; to go on with the conversation, send a new message with its contextId and no taskId`,
          { taskId: sent.taskId },
        ),
      };
    }
    return { existing };
  }

  const skill = skillFor(app, sent, caller);
  if (!skill) {
    return {
      refused: reply.fail(
        -32602,
        "message.metadata.skillId is required: this agent publishes several skills and " +
          "the protocol carries no name of its own",
      ),
    };
  }

  const contextId = typeof sent.contextId === "string" ? sent.contextId : newId("ctx");
  const taskId = newId("task");
  const asked: A2AMessage = {
    messageId: typeof sent.messageId === "string" ? sent.messageId : newId("msg"),
    role: "ROLE_USER",
    parts: partsFrom(sent.parts),
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
  if (push) tasks.setPush({ ...push, taskId });

  // What a person did on a surface is part of what was asked, beside whatever was typed.
  const metadata = sent.metadata && typeof sent.metadata === "object" ? (sent.metadata as Record<string, unknown>) : undefined;
  const a2ui = a2uiOf(metadata, asked.parts);
  return {
    task,
    skill,
    input: [textOf(asked), a2ui.text].filter(Boolean).join("\n\n"),
    ...(a2ui.catalogs ? { catalogs: a2ui.catalogs } : {}),
  };
}

/** A message taken in as new work: the task opened for it, and what to run. */
interface Opened {
  task: Task;
  skill: string;
  input: string;
  /** The A2UI catalogs the caller's renderer offered for this turn, if it offered any. */
  catalogs?: string[];
}

/** An `Authorization` scheme, as RFC 9110 spells a token. */
const SCHEME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
/** What may follow it, or travel in a header at all: visible ASCII, so nothing can end the header early. */
const HEADER_VALUE = /^[\x20-\x7e]*$/;

/** The most webhooks one task may have. More than a few is somebody else's fan-out. */
const MOST_PUSH_CONFIGS = 10;

/**
 * Read a push notification config as a caller sent it, or say what is wrong with it.
 *
 * The address is the part that matters: it is a request this server will make because a
 * caller asked, so it is held to `outboundFault`'s rules before it is accepted.
 */
async function pushFrom(given: unknown, tasks: TaskStore): Promise<Omit<PushConfig, "taskId"> | string> {
  if (!given || typeof given !== "object" || Array.isArray(given)) return "must be an object";
  const raw = given as Record<string, unknown>;
  if (typeof raw.url !== "string" || !raw.url) return "url is required";
  const fault = await outboundFault(raw.url, tasks.outbound);
  if (fault) return `url is not an address this agent will send notifications to: ${fault}`;

  if (raw.id !== undefined && (typeof raw.id !== "string" || !raw.id || raw.id.length > 200)) return "id must be a short string";
  if (raw.token !== undefined && (typeof raw.token !== "string" || !HEADER_VALUE.test(raw.token))) {
    return "token must be a string of visible ASCII characters";
  }
  let authentication: PushConfig["authentication"];
  if (raw.authentication !== undefined && raw.authentication !== null) {
    const auth = raw.authentication as Record<string, unknown>;
    if (typeof auth !== "object" || typeof auth.scheme !== "string" || !SCHEME.test(auth.scheme)) {
      return 'authentication.scheme is required and must be an HTTP authentication scheme, e.g. "Bearer"';
    }
    if (auth.credentials !== undefined && (typeof auth.credentials !== "string" || !HEADER_VALUE.test(auth.credentials))) {
      return "authentication.credentials must be a string of visible ASCII characters";
    }
    authentication = { scheme: auth.scheme, ...(typeof auth.credentials === "string" ? { credentials: auth.credentials } : {}) };
  }
  return {
    id: typeof raw.id === "string" ? raw.id : newId("push"),
    url: raw.url,
    ...(typeof raw.token === "string" && raw.token ? { token: raw.token } : {}),
    ...(authentication ? { authentication } : {}),
  };
}

/** A step of the work, in a sentence a peer can show. Nothing for what is not a step. */
function stepOf(event: Progress): string | undefined {
  switch (event.kind) {
    case "routing":
      return `routing the request to ${event.entry}`;
    case "answering":
      return `asking ${event.model}`;
    case "checking":
      return `checking the answer against ${event.samples} more of the same`;
    case "checked":
      return event.kept ? "the answer held when checked" : "the answer did not hold when checked";
    case "climbing":
      return `asking ${event.to} instead of ${event.from}: ${event.why}`;
    case "tool":
      return `calling ${event.name}`;
    case "tool result":
      return event.failed ? `${event.name} failed` : `${event.name} answered`;
    case "refused":
      return `${event.name} was refused: ${event.why}`;
    case "note":
      return event.text;
    default:
      return undefined;
  }
}

/**
 * Run a task's skill to its end, changing the task and telling its followers as it goes.
 *
 * Never rejects: however the work ends, the task is left in a state that says so, and a
 * stream following it is sent a status that closes it.
 *
 * `reporting` asks the app for progress, which is also what makes an agent's answer
 * arrive in fragments. Each run of fragments is one artifact, sent a chunk at a time —
 * what an agent says on the way to a tool is something it said, and is not withdrawn
 * when the answer follows. The newest fragment is held back until the next one arrives,
 * so that the chunk that ends a run can say `lastChunk` without an empty one after it.
 */
async function work(
  app: App,
  tasks: TaskStore,
  opened: Opened,
  caller: Caller,
  reporting: boolean,
): Promise<void> {
  const { task, skill, input } = opened;
  const { id: taskId, contextId } = task;
  const signal = tasks.begin(taskId);

  const said = (text: string): A2AMessage => ({
    messageId: newId("msg"),
    role: "ROLE_AGENT",
    parts: [{ text }],
    contextId,
    taskId,
  });
  const status = (state: TaskState, message?: A2AMessage, metadata?: Record<string, unknown>): void => {
    task.status = { state, ...(message ? { message } : {}), timestamp: new Date().toISOString() };
    tasks.emit(taskId, {
      statusUpdate: { taskId, contextId, status: task.status, ...(metadata ? { metadata } : {}) },
    });
  };

  const artifacts: Artifact[] = [];
  let saying: { artifactId: string; text: string; held: string; begun: boolean } | undefined;
  const chunk = (artifactId: string, text: string, append: boolean, lastChunk: boolean): void =>
    tasks.emit(taskId, {
      artifactUpdate: { taskId, contextId, artifact: { artifactId, name: skill, parts: [{ text }] }, append, lastChunk },
    });
  /** End the run of fragments in progress, if there is one, and keep what it said. */
  const finishSaying = (): void => {
    if (!saying) return;
    chunk(saying.artifactId, saying.held, saying.begun, true);
    artifacts.push({ artifactId: saying.artifactId, name: skill, parts: [{ text: saying.text }] });
    saying = undefined;
  };

  const onProgress = (event: Progress): void => {
    // A cancelled task has had its last status. Nothing may follow it.
    if (tasks.isCancelled(taskId)) return;
    if (event.kind === "text") {
      if (!saying) {
        saying = { artifactId: newId("art"), text: event.text, held: event.text, begun: false };
        return;
      }
      chunk(saying.artifactId, saying.held, saying.begun, false);
      saying.begun = true;
      saying.held = event.text;
      saying.text += event.text;
      return;
    }
    finishSaying();
    const step = stepOf(event);
    if (step) status("TASK_STATE_WORKING", said(step), { "com.praecise/progress": event.kind });
  };

  // A surface the agent sends is an artifact of its own: a data part marked as A2UI, the
  // way the A2UI extension has it. Offered only for a turn whose renderer said what it
  // can draw; the extension forbids answering any other turn with one.
  const surface = (messages: A2uiMessage[]): void => {
    if (tasks.isCancelled(taskId)) return;
    finishSaying();
    const artifact: Artifact = {
      artifactId: newId("art"),
      name: "a2ui",
      parts: [{ data: messages, mediaType: A2UI_MEDIA_TYPE, metadata: { mimeType: A2UI_MEDIA_TYPE } }],
    };
    artifacts.push(artifact);
    tasks.emit(taskId, { artifactUpdate: { taskId, contextId, artifact, append: false, lastChunk: true } });
  };

  try {
    const { text, isError, waiting, cancelled } = await callPublished(app, skill, { input }, caller, {
      signal,
      ...(reporting ? { onProgress } : {}),
      ...(opened.catalogs
        ? { tools: [surfaceTool({ catalogs: opened.catalogs, emit: surface, surfaces: tasks.surfaces(contextId) })] }
        : {}),
    });
    // A cancellation that arrived while the work was running wins. Overwriting it
    // with the answer would report a cancelled task as completed, which is the one
    // outcome a caller who cancelled is entitled not to see.
    if (tasks.isCancelled(taskId)) return;

    const answer = said(text);
    task.history = [...(task.history ?? []), answer];

    if (cancelled) {
      // The run was stopped by somebody other than this task's caller.
      finishSaying();
      status("TASK_STATE_CANCELED", answer);
      return;
    }
    if (waiting?.event) {
      // Stopped until an event arrives. Nothing is being asked of the caller, so the
      // task is still working; it is brought up to date from the run when asked about.
      finishSaying();
      task.metadata = { ...task.metadata, [RUN_KEY]: waiting.run, [STEP_KEY]: waiting.step };
      status("TASK_STATE_WORKING", answer);
      return;
    }
    if (waiting) {
      // Stopped at an approval gate. Not finished and not failed: it needs a person,
      // which is the state the protocol has for exactly this.
      finishSaying();
      task.metadata = { ...task.metadata, [RUN_KEY]: waiting.run, [STEP_KEY]: waiting.step };
      status("TASK_STATE_INPUT_REQUIRED", answer);
      return;
    }
    if (isError) {
      finishSaying();
      if (artifacts.length) task.artifacts = artifacts;
      status("TASK_STATE_FAILED", answer);
      return;
    }

    if (saying && saying.text === text) {
      // What was just said, fragment by fragment, is the answer. Sending it again whole
      // would give the caller the same text twice.
      finishSaying();
    } else {
      finishSaying();
      const artifact: Artifact = { artifactId: newId("art"), name: skill, parts: [{ text }] };
      artifacts.push(artifact);
      tasks.emit(taskId, { artifactUpdate: { taskId, contextId, artifact, append: false, lastChunk: true } });
    }
    task.artifacts = artifacts;
    status("TASK_STATE_COMPLETED", answer);
  } catch (err) {
    if (tasks.isCancelled(taskId)) return;
    finishSaying();
    if (artifacts.length) task.artifacts = artifacts;
    status("TASK_STATE_FAILED", said((err as Error).message));
  } finally {
    tasks.end(taskId);
  }
}

/**
 * Bring a task that was waiting on a workflow run up to date with the run.
 *
 * The gate is answered somewhere else — the dashboard, or `/api/runs/{id}` — and nothing
 * tells this store when it is. So the run is read when the task is asked about, which is
 * the only moment the answer matters.
 */
async function settle(app: App, tasks: TaskStore, task: Task): Promise<void> {
  const runId = task.metadata?.[RUN_KEY];
  if (typeof runId !== "string" || terminal(task.status.state) || tasks.isRunning(task.id)) return;

  const run = await app.runs.load(runId).catch(() => undefined);
  if (!run) return;

  const now = (state: TaskState, message?: A2AMessage): void => {
    task.status = { state, ...(message ? { message } : {}), timestamp: new Date().toISOString() };
    if (message) task.history = [...(task.history ?? []), message];
    tasks.emit(task.id, { statusUpdate: { taskId: task.id, contextId: task.contextId, status: task.status } });
  };

  if (run.status === "running") {
    // Someone decided and the run went on. There is no answer to report yet.
    if (task.status.state !== "TASK_STATE_WORKING") now("TASK_STATE_WORKING");
    return;
  }

  const { text, isError, waiting, cancelled } = outcomeOf(run);
  const said: A2AMessage = {
    messageId: newId("msg"),
    role: "ROLE_AGENT",
    parts: [{ text }],
    contextId: task.contextId,
    taskId: task.id,
  };

  if (cancelled) {
    now("TASK_STATE_CANCELED", said);
    return;
  }
  if (waiting?.event) {
    // Waiting for an event: still working. Said once per wait, not on every poll.
    if (task.status.state === "TASK_STATE_WORKING" && task.metadata?.[STEP_KEY] === waiting.step) return;
    task.metadata = { ...task.metadata, [STEP_KEY]: waiting.step };
    now("TASK_STATE_WORKING", said);
    return;
  }
  if (waiting) {
    // Still waiting. Only worth saying again if it is now a different gate.
    if (task.status.state === "TASK_STATE_INPUT_REQUIRED" && task.metadata?.[STEP_KEY] === waiting.step) return;
    task.metadata = { ...task.metadata, [STEP_KEY]: waiting.step };
    now("TASK_STATE_INPUT_REQUIRED", said);
    return;
  }
  if (isError) {
    now("TASK_STATE_FAILED", said);
    return;
  }
  task.artifacts = [{ artifactId: newId("art"), name: run.workflow, parts: [{ text }] }];
  now("TASK_STATE_COMPLETED", said);
}

/**
 * Answer one A2A JSON-RPC request.
 *
 * Shaped like `handleMcp` deliberately: same signature, same `Caller`, same access rules,
 * so that what an app publishes cannot drift between the two protocols it publishes over.
 * The version is read from `caller.headers`, where the transport put the request's
 * headers, and from the method name.
 *
 * A method that is answered with a stream is not answered here; `streamA2A` is for
 * those, and `streamsA2A` says which they are.
 */
export async function handleA2A(
  app: App,
  message: unknown,
  caller: Caller = {},
  tasks: TaskStore = shared(app),
): Promise<unknown | undefined> {
  const request = message as Request;
  const asked = entering(request, caller);
  if ("refused" in asked) return asked.refused;
  return perform(app, tasks, caller, { ...asked, params: request.params ?? {}, method: request.method as string });
}

/** One operation, asked for in one version, with the envelope its binding answers in. */
interface Asked {
  does: Operation;
  version: A2AVersion;
  reply: Reply;
  params: Record<string, unknown>;
  /** What the caller called it, for a refusal to name. */
  method: string;
}

/**
 * Do one operation that is answered once.
 *
 * The one implementation of each: JSON-RPC and HTTP+JSON both arrive here, having
 * worked out which operation is meant and brought the envelope they answer in. Nothing
 * below knows which binding it is serving, which is what keeps them from drifting.
 */
async function perform(app: App, tasks: TaskStore, caller: Caller, asked: Asked): Promise<unknown> {
  const { does, version, reply, params, method } = asked;

  switch (does) {
    case "send": {
      const opened = await opening(app, tasks, params, caller, reply, version);
      if ("refused" in opened) return opened.refused;

      const configuration = (params.configuration ?? {}) as Record<string, unknown>;
      const historyLength = lengthOf(configuration.historyLength);
      // In 1.0 a task is its own property of the result, beside the `message` a server
      // may answer with instead. In 0.3 the result WAS the task, marked by its `kind`.
      const sent = (task: Task): unknown =>
        reply.ok(version === "1.0" ? { task: taskFor(version, task, { historyLength }) } : taskFor(version, task, { historyLength }));

      if ("existing" in opened) return sent(opened.existing);

      const working = work(app, tasks, opened, caller, false);
      // A caller may ask not to be kept waiting: the task comes back still working, and
      // is polled, subscribed to, or cancelled from there. 1.0 calls that
      // `returnImmediately`; 0.3 called it `blocking: false`.
      const detached = configuration.returnImmediately === true || configuration.blocking === false;
      if (!detached) await working;
      return sent(opened.task);
    }

    case "get": {
      const wanted = params.id ?? params.name;
      if (typeof wanted !== "string") return reply.fail(-32602, "params.id is required");
      const task = tasks.get(wanted);
      // -32001 is A2A's "task not found". Kept distinct from a malformed request:
      // a caller polling a task that has been evicted needs to know which happened.
      if (!task) return reply.fail(TASK_NOT_FOUND, `no task with id "${wanted}"`, { taskId: wanted });
      await settle(app, tasks, task);
      return reply.ok(taskFor(version, task, { historyLength: lengthOf(params.historyLength) }));
    }

    case "list": {
      const found = tasks.list(typeof params.contextId === "string" ? params.contextId : undefined);
      await Promise.all(found.map((task) => settle(app, tasks, task)));

      // As this endpoint always answered it under the old name: everything, in the order
      // it was accepted.
      if (version === "0.3") return reply.ok({ tasks: found.map((task) => taskFor(version, task)) });

      const size = params.pageSize === undefined ? 50 : params.pageSize;
      if (typeof size !== "number" || !Number.isInteger(size) || size < 1 || size > 100) {
        return reply.fail(-32602, "params.pageSize must be a whole number from 1 to 100");
      }
      const start = params.pageToken === undefined || params.pageToken === "" ? 0 : offsetOf(params.pageToken);
      if (start === undefined) return reply.fail(-32602, "params.pageToken is not a token this agent issued");

      const since = params.statusTimestampAfter === undefined ? undefined : Date.parse(String(params.statusTimestampAfter));
      if (since !== undefined && Number.isNaN(since)) {
        return reply.fail(-32602, "params.statusTimestampAfter must be an ISO 8601 timestamp");
      }
      const matching = found
        .filter((task) => typeof params.status !== "string" || task.status.state === params.status)
        .filter((task) => since === undefined || Date.parse(task.status.timestamp) >= since)
        // Most recently changed first, which is the order the protocol asks for.
        .sort((a, b) => (a.status.timestamp < b.status.timestamp ? 1 : a.status.timestamp > b.status.timestamp ? -1 : 0));
      const page = matching.slice(start, start + size);
      const next = start + size;

      return reply.ok({
        tasks: page.map((task) =>
          taskFor(version, task, {
            historyLength: lengthOf(params.historyLength),
            // Left out of a listing unless asked for, as the protocol has it: a list is
            // for finding a task, and its artifacts are what `GetTask` is for.
            artifacts: params.includeArtifacts === true,
          }),
        ),
        // An empty token is how the protocol says there is no further page.
        nextPageToken: next < matching.length ? tokenFor(next) : "",
        pageSize: size,
        totalSize: matching.length,
      });
    }

    case "cancel": {
      const wanted = params.id;
      if (typeof wanted !== "string") return reply.fail(-32602, "params.id is required");
      const found = tasks.get(wanted);
      if (found) await settle(app, tasks, found);
      // A run this task's own call is driving hears the task's signal, which
      // `tasks.cancel` aborts. A run stopped at a gate or waiting for an event has
      // nobody driving it, so it is ended by id. Ending a run is not approving one:
      // a peer may do it to a task that is its own.
      const runId = found?.metadata?.[RUN_KEY];
      if (found && typeof runId === "string" && !terminal(found.status.state) && !tasks.isRunning(wanted)) {
        await app.cancelWorkflow(runId, { reason: "the task was cancelled over A2A" }).catch(() => undefined);
      }
      const task = tasks.cancel(wanted);
      if (!task) return reply.fail(TASK_NOT_FOUND, `no task with id "${wanted}"`, { taskId: wanted });
      if (task.status.state !== "TASK_STATE_CANCELED") {
        return reply.fail(TASK_NOT_CANCELABLE, `task "${wanted}" has already finished and cannot be cancelled`, {
          taskId: wanted,
        });
      }
      return reply.ok(taskFor(version, task));
    }

    case "stream":
    case "subscribe":
      return reply.fail(
        -32600,
        `${method} is answered with a stream of events and this is a single reply; ` +
          `a transport sends it to streamA2A instead`,
      );

    case "pushCreate": {
      const task = typeof params.taskId === "string" ? tasks.get(params.taskId) : undefined;
      if (typeof params.taskId !== "string") return reply.fail(-32602, "params.taskId is required");
      if (!task) return reply.fail(TASK_NOT_FOUND, `no task with id "${params.taskId}"`, { taskId: params.taskId });
      const read = await pushFrom(params, tasks);
      if (typeof read === "string") return reply.fail(-32602, read);
      if (!tasks.getPush(task.id, read.id) && tasks.listPush(task.id).length >= MOST_PUSH_CONFIGS) {
        return reply.fail(-32602, `task "${task.id}" already has ${MOST_PUSH_CONFIGS} push notification configs, which is the most one task may have`);
      }
      const config: PushConfig = { ...read, taskId: task.id };
      tasks.setPush(config);
      return reply.ok(config);
    }

    case "pushGet":
    case "pushDelete":
    case "pushList": {
      const taskId = params.taskId;
      if (typeof taskId !== "string") return reply.fail(-32602, "params.taskId is required");
      if (!tasks.get(taskId)) return reply.fail(TASK_NOT_FOUND, `no task with id "${taskId}"`, { taskId });
      if (does === "pushList") {
        // Few enough to send whole: a task has at most ten. An empty token says so.
        return reply.ok({ configs: tasks.listPush(taskId), nextPageToken: "" });
      }
      if (typeof params.id !== "string") return reply.fail(-32602, "params.id is required");
      if (does === "pushDelete") {
        // Idempotent: deleting what is not there has the same effect as deleting it.
        tasks.deletePush(taskId, params.id);
        return reply.ok({});
      }
      const config = tasks.getPush(taskId, params.id);
      // The specification's error for a config that does not exist is the task's.
      if (!config) {
        return reply.fail(TASK_NOT_FOUND, `task "${taskId}" has no push notification config with id "${params.id}"`, { taskId });
      }
      return reply.ok(config);
    }

    // The 0.3 card declares no push notifications, and its methods are refused in the
    // same words. A method that is absent from `capabilities` and still answers is
    // worse than one that does not: it teaches a client to ignore the card.
    case "push":
      return reply.fail(
        PUSH_NOT_SUPPORTED,
        `${method} is not supported for A2A 0.3 callers; this agent's 0.3 card declares so under "capabilities"`,
      );

    case "card":
      return reply.fail(
        EXTENDED_CARD_NOT_CONFIGURED,
        `${method}: this agent has no extended card; its public card declares so under "capabilities"`,
      );
  }
}

/** Where a page starts, as a token a caller hands back without reading. */
function tokenFor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

function offsetOf(token: unknown): number | undefined {
  if (typeof token !== "string") return undefined;
  const text = Buffer.from(token, "base64url").toString("utf8");
  return /^\d{1,9}$/.test(text) ? Number(text) : undefined;
}

/**
 * Answer a request that is answered with a stream: `SendStreamingMessage` and
 * `SubscribeToTask`, and their 0.3 names.
 *
 * Yields JSON-RPC responses, one per event, each for a transport to send as one
 * server-sent event. The first is always the task as it stands, so a caller knows the id
 * before anything else happens; the stream ends after the status that work does not
 * continue from. A request that is refused yields the one error and ends — a transport
 * that has not yet opened its stream can send that as an ordinary reply.
 *
 * Going away does not stop the work. A caller whose connection dropped subscribes to the
 * task again; it is `CancelTask` that stops it.
 *
 * Any other request is answered once, as `handleA2A` would.
 */
export async function* streamA2A(
  app: App,
  message: unknown,
  caller: Caller = {},
  tasks: TaskStore = shared(app),
): AsyncGenerator<unknown, void, void> {
  const request = message as Request;
  const asked = entering(request, caller);
  if ("refused" in asked) {
    yield asked.refused;
    return;
  }
  yield* flow(app, tasks, caller, { ...asked, params: request.params ?? {}, method: request.method as string });
}

/**
 * Do one operation that is answered with a stream. The one implementation, as `perform`
 * is for the rest: each frame is handed to the binding's own envelope.
 */
async function* flow(app: App, tasks: TaskStore, caller: Caller, asked: Asked): AsyncGenerator<unknown, void, void> {
  const { does, version, reply, params } = asked;

  if (does !== "stream" && does !== "subscribe") {
    yield await perform(app, tasks, caller, asked);
    return;
  }

  let task: Task;
  let opened: Opened | undefined;

  if (does === "stream") {
    const taken = await opening(app, tasks, params, caller, reply, version);
    if ("refused" in taken) {
      yield taken.refused;
      return;
    }
    if ("existing" in taken) {
      // Still waiting on a person. The task says so, and there is nothing to follow.
      yield reply.ok(frameFor(version, { task: taken.existing }));
      return;
    }
    opened = taken;
    task = taken.task;
  } else {
    const wanted = params.id;
    if (typeof wanted !== "string") {
      yield reply.fail(-32602, "params.id is required");
      return;
    }
    const found = tasks.get(wanted);
    if (!found) {
      yield reply.fail(TASK_NOT_FOUND, `no task with id "${wanted}"`, { taskId: wanted });
      return;
    }
    await settle(app, tasks, found);
    if (terminal(found.status.state)) {
      yield reply.fail(
        UNSUPPORTED_OPERATION,
        `task "${wanted}" has finished, so there is nothing left to subscribe to; GetTask returns it as it ended`,
        { taskId: wanted },
      );
      return;
    }
    task = found;
  }

  // Following starts before the work does and before the first frame is handed over, so
  // that nothing which happens in between is missed.
  const queue: TaskEvent[] = [];
  let wake: (() => void) | undefined;
  const stop = tasks.watch(task.id, (event) => {
    queue.push(event);
    wake?.();
    wake = undefined;
  });

  try {
    const first = reply.ok(frameFor(version, { task }));
    if (opened) void work(app, tasks, opened, caller, true);
    yield first;

    // A task subscribed to that nobody in this process is working on will send nothing
    // more: it is waiting on a person, or on a run that another request is driving. The
    // task was the answer. (Work begun just above is not asked about here: it may be
    // over already, with everything it said waiting in the queue.)
    if (!opened && !tasks.isRunning(task.id) && !queue.length) return;

    for (;;) {
      while (queue.length) {
        const event = queue.shift() as TaskEvent;
        yield reply.ok(frameFor(version, event));
        if (closes(event)) return;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    stop();
  }
}

// ── The HTTP+JSON binding ──────────────────────────────────────────────────────

/** A request as the HTTP+JSON binding receives one, with the path below the interface's URL. */
export interface A2ARestRequest {
  method: string;
  /** What follows the interface URL: `/message:send`, `/tasks/abc:cancel`. */
  path: string;
  query?: URLSearchParams;
  /** The parsed JSON body, where the method has one. */
  body?: unknown;
}

/** What to send back: one body with its status, or a stream of bodies. */
export type A2ARestAnswer =
  | { status: number; body: unknown }
  | { stream: AsyncGenerator<unknown, void, void> };

/** The query parameters that are not strings, and what each is. */
const QUERY_TYPES: Record<string, "number" | "boolean"> = {
  pageSize: "number",
  historyLength: "number",
  includeArtifacts: "boolean",
};

function paramsOf(query: URLSearchParams | undefined): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const [key, value] of query ?? []) {
    const type = QUERY_TYPES[key];
    if (type === "number" && /^\d{1,9}$/.test(value)) params[key] = Number(value);
    else if (type === "boolean" && (value === "true" || value === "false")) params[key] = value === "true";
    // Anything else goes through as it was written, and the operation says what is wrong with it.
    else params[key] = value;
  }
  return params;
}

/** Which operation a method and path are, and the parameters the path itself carries. */
function routeOf(method: string, path: string): { does: Operation; from: Record<string, unknown>; body: boolean } | undefined {
  if (path === "/message:send" && method === "POST") return { does: "send", from: {}, body: true };
  if (path === "/message:stream" && method === "POST") return { does: "stream", from: {}, body: true };
  if (path === "/tasks" && method === "GET") return { does: "list", from: {}, body: false };
  if (path === "/extendedAgentCard" && method === "GET") return { does: "card", from: {}, body: false };

  const task = /^\/tasks\/([^/:]+)(?::(cancel|subscribe))?$/.exec(path);
  if (task) {
    const id = decodeURIComponent(task[1]!);
    if (!task[2]) return method === "GET" ? { does: "get", from: { id }, body: false } : undefined;
    if (task[2] === "cancel") return method === "POST" ? { does: "cancel", from: { id }, body: true } : undefined;
    // The service definition has this as GET and the specification's own table as POST.
    // Both are answered; neither carries a body that matters.
    return method === "GET" || method === "POST" ? { does: "subscribe", from: { id }, body: false } : undefined;
  }

  const push = /^\/tasks\/([^/:]+)\/pushNotificationConfigs(?:\/([^/]+))?$/.exec(path);
  if (push) {
    const taskId = decodeURIComponent(push[1]!);
    if (push[2] === undefined) {
      if (method === "POST") return { does: "pushCreate", from: { taskId }, body: true };
      return method === "GET" ? { does: "pushList", from: { taskId }, body: false } : undefined;
    }
    const id = decodeURIComponent(push[2]);
    if (method === "GET") return { does: "pushGet", from: { taskId, id }, body: false };
    return method === "DELETE" ? { does: "pushDelete", from: { taskId, id }, body: false } : undefined;
  }
  return undefined;
}

/**
 * Answer one request of A2A's HTTP+JSON binding.
 *
 * The same operations as `handleA2A` and `streamA2A`, reached by a verb and a path
 * instead of a method name, and answered without the JSON-RPC envelope: a result is the
 * body, and an error is a `google.rpc.Status` sent with the HTTP status it names. The
 * operations themselves are `perform` and `flow`, the ones JSON-RPC runs.
 *
 * 1.0 only. The paths are 1.0's, so a request here has said which version it speaks; a
 * header that says otherwise is refused, naming both.
 */
export async function restA2A(
  app: App,
  request: A2ARestRequest,
  caller: Caller = {},
  tasks: TaskStore = shared(app),
): Promise<A2ARestAnswer> {
  const failed = (answer: unknown): A2ARestAnswer => ({
    status: (answer as { error: { code: number } }).error.code,
    body: answer,
  });

  const header = (headerOf(caller.headers, "a2a-version") ?? "").trim();
  if (header && !/^1\.0(\.\d+)?$/.test(header)) {
    return failed(
      restReply.fail(
        VERSION_NOT_SUPPORTED,
        `A2A-Version "${header}" is not one this interface speaks; the HTTP+JSON binding here is ${A2A_VERSION}` +
          (/^0\.3(\.\d+)?$/.test(header) ? `, and ${A2A_LEGACY_VERSION} callers are answered over JSON-RPC at the same address` : ""),
        { requested: header, supported: A2A_VERSION },
      ),
    );
  }

  const method = request.method.toUpperCase();
  const route = routeOf(method, request.path);
  if (!route) return failed(restReply.fail(-32601, `nothing is served at ${method} ${request.path}`));

  const body = route.body && request.body && typeof request.body === "object" && !Array.isArray(request.body)
    ? (request.body as Record<string, unknown>)
    : {};
  const asked: Asked = {
    does: route.does,
    version: "1.0",
    reply: restReply,
    // What the path says wins over what the body says: a body cannot address a task
    // other than the one in the URL it was sent to.
    params: { ...paramsOf(request.query), ...body, ...route.from },
    method: `${method} ${request.path}`,
  };

  if (route.does === "stream" || route.does === "subscribe") return { stream: flow(app, tasks, caller, asked) };

  const answer = await perform(app, tasks, caller, asked);
  if (answer && typeof answer === "object" && "error" in answer) return failed(answer);
  return { status: 200, body: answer };
}

/** One task store per app, so `GetTask` can find what `SendMessage` created. */
const stores = new WeakMap<App, TaskStore>();

/**
 * The task store an app's A2A endpoint uses, made on first use.
 *
 * `options` take effect when the store is made, which is how a server says how push
 * notifications are delivered and which receivers are allowed.
 */
export function tasksOf(app: App, options: A2AOptions = {}): TaskStore {
  const found = stores.get(app);
  if (found) return found;
  const made = new TaskStore(1_000, options);
  stores.set(app, made);
  return made;
}

function shared(app: App): TaskStore {
  return tasksOf(app);
}
