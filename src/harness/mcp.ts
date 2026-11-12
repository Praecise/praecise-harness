/**
 * A minimal MCP client over streamable HTTP — enough to discover a server's
 * tools and call them. Servers may answer JSON-RPC with either a JSON body or
 * an SSE stream, so both are handled.
 *
 * Tool names are namespaced `service__tool` on the way out, because providers
 * restrict tool names to `[A-Za-z0-9_-]` and an agent may hold several services
 * at once.
 */

import type { ResolvedService } from "../compile/services.js";
import { StdioTransport } from "./stdio-transport.js";
import { authorizerFor, parseChallenge, type Challenge } from "./oauth.js";
import { traceMeta, type TraceContext } from "./trace.js";
import type { Effect } from "../define.js";
import type { ToolSchema, UiView } from "./types.js";
import { callOperation, operationsFrom, type Operation } from "./openapi.js";

/**
 * The MCP revision this speaks. There is exactly one, and it is the current one.
 *
 * `2026-07-28` made MCP a STATELESS protocol, which is not a detail — it deleted the
 * `initialize`/`notifications/initialized` handshake, the `Mcp-Session-Id` header, the
 * standalone GET stream, `ping`, `logging/setLevel`, and SSE resumability. Every request
 * now carries its own protocol version, capabilities and client identity in `_meta`, and
 * a server answers each one independently without inferring anything from what came
 * before it on the same connection.
 *
 * Nothing here speaks an earlier revision. The spec defines a dual-era client that probes
 * and falls back, and this is deliberately not one: a fallback path is a second protocol
 * implementation that runs only against servers you do not have, which is the definition
 * of code that rots untested. A server on an older revision fails with a message naming
 * this version rather than being quietly accommodated.
 */
const PROTOCOL_VERSION = "2026-07-28";

/** Who we say we are. Self-reported, never trusted for anything by either side. */
const CLIENT_INFO = { name: "praecise", version: "0.1.0" } as const;

/** The Tasks extension: a `tools/call` answered with a task that is polled to its end. */
const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";

/**
 * What this client can do, declared on every request.
 *
 * Short is the honest answer and also a load-bearing one: a server MUST NOT rely on a
 * capability the client did not declare, and MUST refuse with
 * `MissingRequiredClientCapability` rather than proceeding on an assumption. Declaring
 * capabilities we do not implement would convert that clean refusal into a hang.
 *
 * The one thing always declared is the Tasks extension, which `call` implements: a server
 * may answer a tool call with a task, and the call follows it to its end. It is declared
 * bare. Everything else is declared only by a client that was given the means to do it
 * (see `clientCapabilities`): elicitation where the app supplied a handler, MCP Apps where
 * the app said a front end renders them, an authorization extension where the service is
 * configured for that grant. Sampling, roots and logging are never declared. This
 * revision deprecates all three (SEP-2577) and says new implementations should not adopt
 * them, so a server that asks for one is refused by name.
 */
const CLIENT_CAPABILITIES: Record<string, unknown> = { extensions: { [TASKS_EXTENSION]: {} } };

/** MCP Apps: a tool may name a `ui://` page for a host to show. */
export const UI_EXTENSION = "io.modelcontextprotocol/ui";
/** The one media type an MCP App is served as. */
export const UI_MIME = "text/html;profile=mcp-app";
/** Skills over MCP: a server's `SKILL.md` folders, listed and read as resources. */
export const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";
/** The two authorization extensions, declared by a client that is using one. */
export const CLIENT_CREDENTIALS_EXTENSION = "io.modelcontextprotocol/oauth-client-credentials";
export const ENTERPRISE_AUTH_EXTENSION = "io.modelcontextprotocol/enterprise-managed-authorization";

/** What one field of a form may come back as. Flat by the protocol's rule: no nesting. */
export type ElicitedValue = string | number | boolean | string[];

/** How a person, or whatever stands in for one, answered. */
export interface ElicitResult {
  /** `accept`: they agreed. `decline`: they said no. `cancel`: they left without choosing. */
  action: "accept" | "decline" | "cancel";
  /** The form's values, on `accept` of a form. Never set for a URL. */
  content?: Record<string, ElicitedValue>;
}

/** A server asking for a few values, through this client, in the middle of a call. */
export interface FormElicitation {
  /** The service that is asking, as the app names it. Show it: the person must know who wants this. */
  service: string;
  /** What was being done when it asked: `tools/call`, `prompts/get` or `resources/read`. */
  method: string;
  /** The tool, prompt or resource the call was for. */
  name?: string;
  /** Why, in the server's words. */
  message: string;
  /** What to collect: a flat JSON Schema object of strings, numbers, booleans and choices. */
  schema: Record<string, unknown>;
}

/** A server asking for the person to be sent to a page, where they deal with it directly. */
export interface UrlElicitation {
  service: string;
  method: string;
  name?: string;
  message: string;
  /** The whole address, to be shown before anything opens it. Never fetched here. */
  url: string;
  /** Its host, which is what a person should be reading before they agree. */
  host: string;
}

/**
 * How an app answers a server that asks for something mid-call.
 *
 * One function per mode, because the two are different promises. A form's answer passes
 * through this process; a URL's does not, and what the handler agrees to is only that the
 * person may be sent there. The mode a client declares is exactly the set of handlers it
 * was given, so a server never asks for one that nothing here can answer.
 *
 * A URL handler is the consent the protocol requires: it MUST show the full address and
 * MUST NOT open it unasked. Nothing in this framework opens, fetches or previews it.
 */
export interface Elicit {
  form?(asked: FormElicitation): ElicitResult | Promise<ElicitResult>;
  url?(asked: UrlElicitation): ElicitResult | Promise<ElicitResult>;
}

/**
 * What the application around a client can do that the client cannot do alone.
 *
 * The seam for every client capability that needs a person or a screen. Empty, a client
 * declares only what it does unaided, and a server that wants more is refused cleanly.
 */
export interface McpHost {
  /** Answers elicitation. Each mode is declared only if its handler is here. */
  elicit?: Elicit;
  /**
   * Say that a front end renders MCP Apps. With it, the UI extension is declared, and a
   * tool that names a `ui://` page has that page read and handed on with its result
   * (`Answer.ui`). Without it nothing is declared and nothing is read.
   */
  apps?: boolean;
}

/**
 * The capabilities one client declares, from what it was given.
 *
 * `grant` is the authorization grant the service is configured for, when it has one: the
 * two authorization extensions are declared by a client that is actually using them.
 */
export function clientCapabilities(host: McpHost = {}, grant?: string): Record<string, unknown> {
  const modes = {
    ...(host.elicit?.form ? { form: {} } : {}),
    ...(host.elicit?.url ? { url: {} } : {}),
  };
  return {
    ...(Object.keys(modes).length ? { elicitation: modes } : {}),
    extensions: {
      [TASKS_EXTENSION]: {},
      ...(host.apps ? { [UI_EXTENSION]: { mimeTypes: [UI_MIME] } } : {}),
      ...(grant === "client_credentials" ? { [CLIENT_CREDENTIALS_EXTENSION]: {} } : {}),
      ...(grant === "id-jag" ? { [ENTERPRISE_AUTH_EXTENSION]: {} } : {}),
    },
  };
}

/** How many times one call may be asked for more before it is given up on. */
const MAX_INPUT_ROUNDS = 8;
/** How long a server has to acknowledge a subscription before it is taken as not offering one. */
const LISTEN_ACK_MS = 10_000;
/** JSON-RPC's "no such method": how a server says it does not do subscriptions. */
const METHOD_NOT_FOUND = -32601;
/** The key every message on a subscription carries, naming the request that opened it. */
const SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId";

/** How often a task is asked about when the server does not say. */
const TASK_POLL_MS = 1_000;
/** The longest wait between two looks, however long a task has been quiet. */
const TASK_POLL_CAP_MS = 10_000;
/** How much longer each wait is than the last. Gentle: most tasks finish in a few looks. */
const TASK_POLL_GROWTH = 1.25;
/** How long a best-effort `tasks/cancel` may take before it is given up on. */
const TASK_CANCEL_MS = 5_000;

/** A task as a server reports it, at creation and on every `tasks/get`. */
interface TaskState {
  taskId?: unknown;
  status?: unknown;
  statusMessage?: unknown;
  ttlMs?: unknown;
  pollIntervalMs?: unknown;
  inputRequests?: unknown;
  result?: unknown;
  error?: unknown;
}

/** Error codes this revision defines. The `-32020..-32099` block belongs to the spec. */
const HEADER_MISMATCH = -32020;
const MISSING_CAPABILITY = -32021;
const UNSUPPORTED_VERSION = -32022;

const SEPARATOR = "__";

/**
 * How many pages of a paginated list to follow before deciding the server is not
 * going to stop.
 *
 * CONSTRAINT: a list is followed to exhaustion, but never forever.
 *
 * Both halves matter. Reading only the first page — which is what this did — silently
 * loses every tool, resource and prompt past the server's page size, and the failure is
 * invisible: the agent simply never learns the tool exists, and a model cannot ask for
 * what it was never shown. So cursors are followed.
 *
 * But `nextCursor` is opaque and entirely under the server's control, and a server that
 * returns one unconditionally — a bug that costs its author nothing and is easy to
 * write — would spin this loop until the process died. A cap is not a guess about how
 * many tools are reasonable; it is the refusal to let a remote party choose how long
 * this runs. Fifty pages is far past any real catalogue, and hitting it is recorded as a
 * warning rather than swallowed, because a truncated list is a fact about the answer.
 */
const MAX_PAGES = 50;

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** The server's own safety hints. Absent when it declared none. */
  annotations?: Record<string, unknown>;
  /** The interactive view the tool declared, when it declared one. See `uiOf`. */
  ui?: McpToolUi;
}

/** A tool's MCP App declaration, as `_meta.ui` carries it. */
export interface McpToolUi {
  /** The `ui://` resource to render. */
  resourceUri: string;
  /**
   * Who may call the tool: a model, a view, or both. A tool without `model` is never
   * shown to an agent; one without `app` is never callable from a view.
   */
  visibility: ("model" | "app")[];
}

/**
 * What a tool said about its view, or nothing.
 *
 * Read from `_meta.ui`, and from the flat `_meta["ui/resourceUri"]` that servers written
 * before the nested form still send. Only a `ui://` address counts: the extension gives
 * the scheme as a MUST, and a page from anywhere else is not this kind of resource.
 * Visibility defaults to both, as the extension has it.
 */
export function uiOf(meta: unknown): McpToolUi | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  const nested = (meta as { ui?: { resourceUri?: unknown; visibility?: unknown } }).ui;
  const uri = typeof nested?.resourceUri === "string" ? nested.resourceUri : (meta as Record<string, unknown>)["ui/resourceUri"];
  const listed = Array.isArray(nested?.visibility)
    ? nested.visibility.filter((who): who is "model" | "app" => who === "model" || who === "app")
    : undefined;
  const visibility: ("model" | "app")[] = listed ?? ["model", "app"];
  if (typeof uri !== "string" || !uri.startsWith("ui://")) {
    // No page, but a tool may still be for views only, and that has to hold either way.
    return listed && !listed.includes("model") ? { resourceUri: "", visibility } : undefined;
  }
  return { resourceUri: uri, visibility };
}

/** One file of a skill a server offers: where it is, what it hashes to, how long it is. */
export interface McpSkillFile {
  uri: string;
  /** `sha256:` and 64 lowercase hex characters, over the bytes served. */
  digest: string;
  size: number;
}

/** A skill a server offers, as `skills/list` and `skills/get` describe it. */
export interface McpSkill {
  /** The address of its `SKILL.md`. With the service, this is the skill's identity; its name is a label. */
  uri: string;
  /** The frontmatter of that file, as the server parsed it. */
  frontmatter: Record<string, unknown> & { name: string; description: string };
  /** Every file of the skill, `SKILL.md` included, or `"dynamic"` for one generated on request. */
  resources: McpSkillFile[] | "dynamic";
}

/** Which changes a subscription asks to be told about. Everything left out is not asked for. */
export interface McpSubscriptionFilter {
  toolsListChanged?: boolean;
  promptsListChanged?: boolean;
  resourcesListChanged?: boolean;
  /** Resources to be told about when their contents change. */
  resourceSubscriptions?: string[];
  /** Tasks to be told about when their state changes (the Tasks extension). */
  taskIds?: string[];
}

/** One thing a server said on a subscription. */
export interface McpNotification {
  method: string;
  params: Record<string, unknown>;
}

/** An open subscription. */
export interface McpSubscription {
  /** What the server agreed to send, which may be less than was asked for. */
  acknowledged: McpSubscriptionFilter;
  /**
   * Settles when the subscription is over, with how: the server ended it and said so,
   * the connection went without a word, or this side closed it.
   */
  closed: Promise<"graceful" | "dropped" | "cancelled">;
  close(): void;
}

/**
 * The server's annotations, read back as the `Effect` this codebase already speaks.
 *
 * The exact inverse of `annotate()` in `server/mcp.ts`, and it has to stay that way: those two
 * are the write and read halves of one wire format, and a disagreement between them would be
 * invisible from either side alone.
 *
 * Returns `undefined` when the server annotated nothing. `annotate()` defaults an undeclared
 * effect to `"write"` on the way OUT because it must emit something concrete; there is no such
 * obligation on the way IN, and inventing `"write"` here would report a server's silence as a
 * declaration it never made.
 *
 * `readOnlyHint` is checked before `destructiveHint` because a server that sets both has
 * contradicted itself, and the safe reading of a contradiction is not the permissive one — but
 * a tool claiming to be read-only AND destructive is treated as destructive, since that is the
 * claim that costs something if ignored.
 */
export function effectOf(annotations?: Record<string, unknown>): Effect | undefined {
  if (!annotations || typeof annotations !== "object") return undefined;
  const destructive = annotations.destructiveHint === true;
  const readOnly = annotations.readOnlyHint === true;
  if (destructive) return "destructive";
  if (readOnly) return "read";
  // Something was declared, and it was neither read-only nor destructive.
  if ("readOnlyHint" in annotations || "destructiveHint" in annotations) return "write";
  return undefined;
}

/** A resource a server offers, as it appears in `resources/list`. */
export interface McpResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

/** One block of what a resource read came back with. */
export interface McpResourceContents {
  uri: string;
  mimeType?: string;
  /** Present for textual resources. */
  text?: string;
  /** Base64, present for binary ones. Never rendered into a prompt — see `readText`. */
  blob?: string;
  /** What the server attached to this block, such as an MCP App's `ui` settings. */
  _meta?: Record<string, unknown>;
}

/** A prompt a server offers, as it appears in `prompts/list`. */
export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}

/** One message of a filled-in prompt, flattened to text. */
export interface McpPromptMessage {
  role: "user" | "assistant";
  text: string;
}

export interface McpPromptResult {
  description?: string;
  messages: McpPromptMessage[];
}

/**
 * A step of a long-running call, as the server reports it.
 *
 * `progress` is a number that only goes up; `total` is present only when the server
 * knows how much there is, which is why this is not a percentage. Inventing one from a
 * missing total would report a fraction nobody measured.
 */
export interface McpProgress {
  progress: number;
  total?: number;
  message?: string;
}

export interface McpRequestOptions {
  /**
   * Cancels the request. On stdio this sends `notifications/cancelled` so the server
   * can stop working; on HTTP it closes the stream, which is what cancellation IS
   * there — there is no message to send, because the response stream is the request.
   */
  signal?: AbortSignal;
  /**
   * Called as the server reports progress. Passing this is also what makes progress
   * happen: a `progressToken` is only sent when somebody is listening, so a server is
   * never asked to narrate work nobody is watching.
   */
  onProgress?: (event: McpProgress) => void;
}

export interface McpCallOptions extends McpRequestOptions {
  idempotencyKey?: string;
  /**
   * Where what a tool returned that is not text goes: an image, a recording, a file.
   *
   * Handed over here rather than returned, so that a tool's answer is still the text it
   * always was. Without somewhere to put it, such a block is described in a line —
   * never spelled out as base64, which is tokens spent on something no model can read.
   */
  media?: (attachment: { mime: string; data?: string; url?: string; name?: string }) => void;
  /**
   * Where the interactive view a tool declared goes, with the input and result it is to
   * be shown. Called at most once a call, and only by a client whose host renders MCP
   * Apps. The text the call returns is the same either way: a view is beside an answer,
   * not instead of one.
   */
  ui?: (view: UiView) => void;
  /**
   * Where in a trace this call sits.
   *
   * Sent as `traceparent` in `_meta`, which is the key MCP's current revision reserves
   * for W3C Trace Context. A tool call that crosses into another process is the most
   * interesting span boundary in an agentic system and the easiest to lose: without this
   * the server's work becomes an unrelated trace and its latency is attributed to nothing.
   */
  trace?: TraceContext;
}

/** What `completion/complete` answers with. */
export interface McpCompletion {
  values: string[];
  total?: number;
  hasMore?: boolean;
}

interface RpcResponse {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * Split an SSE buffer into complete events, keeping any partial tail for the next read.
 *
 * Events are separated by a blank line, and a single event may carry several `data:`
 * lines that concatenate. Reading a frame before it is whole is how a streamed reply
 * becomes a JSON parse error under load and never under test.
 */
function frames(buffer: string): { events: string[]; rest: string } {
  const normalised = buffer.replace(/\r\n/g, "\n");
  const events: string[] = [];
  let rest = normalised;
  let cut = rest.indexOf("\n\n");
  while (cut >= 0) {
    events.push(rest.slice(0, cut));
    rest = rest.slice(cut + 2);
    cut = rest.indexOf("\n\n");
  }
  return { events, rest };
}

/** The JSON-RPC payload carried by one SSE event, if it carries one. */
function payloadOf(event: string): RpcResponse | undefined {
  const data = event
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");
  if (!data) return undefined;
  try {
    return JSON.parse(data) as RpcResponse;
  } catch {
    // A partial or non-JSON data frame; the caller keeps looking.
    return undefined;
  }
}

/** Whether a payload is an answer to a request rather than a notification. */
const isReply = (payload: RpcResponse): boolean =>
  payload.method === undefined && (payload.result !== undefined || payload.error !== undefined);

/**
 * What a content block carries that is not text, handed to `sink`, and the line that
 * stands for it in the text. Nothing for a block that is text or that is not media.
 */
function mediaIn(block: unknown, sink: McpCallOptions["media"]): string | undefined {
  if (!block || typeof block !== "object") return undefined;
  const typed = block as {
    type?: string;
    data?: string;
    mimeType?: string;
    uri?: string;
    name?: string;
    resource?: { blob?: string; uri?: string; mimeType?: string };
  };
  const found =
    (typed.type === "image" || typed.type === "audio") && typeof typed.data === "string"
      ? { mime: typed.mimeType ?? (typed.type === "image" ? "image/png" : "audio/wav"), data: typed.data }
      : typed.type === "resource" && typeof typed.resource?.blob === "string"
        ? { mime: typed.resource.mimeType ?? "application/octet-stream", data: typed.resource.blob, name: typed.resource.uri }
        : typed.type === "resource_link" && typeof typed.uri === "string" && /^https:/i.test(typed.uri)
          ? { mime: typed.mimeType ?? "application/octet-stream", url: typed.uri, name: typed.name }
          : undefined;
  if (!found) return undefined;
  sink?.(found);
  const what = found.name ? `${found.name} (${found.mime})` : found.mime;
  return sink ? `[attached: ${what}]` : `[${what} was returned and is not shown here]`;
}

/** Flatten a content block — a tool result, a prompt message — to text. */
function blockText(block: unknown): string {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object") return "";
  const typed = block as {
    type?: string;
    text?: string;
    resource?: { text?: string; uri?: string; mimeType?: string };
  };
  if (typed.type === "text") return typed.text ?? "";
  // An embedded resource carries its own text; a binary one is described rather than
  // spelled out, because base64 in a prompt is tokens spent on nothing readable.
  if (typed.type === "resource" && typed.resource) {
    return typed.resource.text ?? `[${typed.resource.mimeType ?? "binary"} ${typed.resource.uri ?? ""}]`;
  }
  return JSON.stringify(block);
}

/**
 * A value as it may appear in an HTTP header, per this revision's sentinel format.
 *
 * Header values are visible ASCII only, but a tool name or a resource URI is neither
 * constrained to that nor validated for it — a `file:///` URI with a space, or any name
 * with a non-Latin character, is ordinary and would otherwise produce an invalid header
 * or, worse, a header-splitting one. The spec's answer is `=?base64?…?=`, and a plain
 * value that happens to LOOK like the sentinel must also be encoded, or a server cannot
 * tell an encoded value from a literal that mimics one.
 */
export function headerValue(raw: string): string {
  const plain = /^[\x20-\x7e]*$/.test(raw) && raw.trim() === raw && !isSentinel(raw);
  if (plain) return raw;
  return `=?base64?${Buffer.from(raw, "utf8").toString("base64")}?=`;
}

const isSentinel = (raw: string): boolean => raw.startsWith("=?base64?") && raw.endsWith("?=");

/** Decode a header value that may be carrying the sentinel. The inverse of `headerValue`. */
export function decodeHeaderValue(raw: string): string {
  if (!isSentinel(raw)) return raw;
  return Buffer.from(raw.slice("=?base64?".length, -"?=".length), "base64").toString("utf8");
}

/**
 * The `Mcp-Name` header's source value for a method, or nothing if it takes none.
 *
 * Required on three methods of the core protocol, and on the three of the Tasks
 * extension, where it mirrors the task's id. Sending it elsewhere is not harmless: a server
 * validates headers against the body and rejects a mismatch, so a name attached to a
 * request whose body has no such field is a `HeaderMismatch` waiting to happen.
 */
export function nameFor(method: string, params?: Record<string, unknown>): string | undefined {
  if (!params) return undefined;
  if (method === "tasks/get" || method === "tasks/update" || method === "tasks/cancel") {
    return typeof params.taskId === "string" ? params.taskId : undefined;
  }
  if (method === "tools/call" || method === "prompts/get") {
    return typeof params.name === "string" ? params.name : undefined;
  }
  if (method === "resources/read") return typeof params.uri === "string" ? params.uri : undefined;
  return undefined;
}

/**
 * Which properties of a tool's input schema the server wants mirrored into headers, and
 * whether the annotations are legal.
 *
 * A client MUST support this and MUST exclude a tool whose annotation breaks the rules,
 * rather than passing it on. The reachability rule is the one with teeth: an annotation
 * is only valid on a property reachable through a chain of `properties` keys alone. A
 * value inside an array, a `oneOf` branch, or behind a `$ref` has no single well-defined
 * location to read at call time, so an annotation there is not a header this client can
 * honour — it is an instruction it cannot follow, and following it approximately would
 * put a guessed value in a header an intermediary routes on.
 */
export function headerParamsOf(schema: unknown): { paths: Map<string, string[]>; faults: string[] } {
  const paths = new Map<string, string[]>();
  const faults: string[] = [];
  const claimed = new Set<string>();

  const walk = (node: unknown, trail: string[]): void => {
    if (!node || typeof node !== "object") return;
    const properties = (node as { properties?: Record<string, unknown> }).properties;
    if (!properties || typeof properties !== "object") return;
    for (const [key, raw] of Object.entries(properties)) {
      if (!raw || typeof raw !== "object") continue;
      const property = raw as { type?: unknown; "x-mcp-header"?: unknown };
      const here = [...trail, key];
      const annotation = property["x-mcp-header"];
      if (annotation !== undefined) {
        if (typeof annotation !== "string" || !annotation) {
          faults.push(`x-mcp-header on "${here.join(".")}" is not a non-empty string`);
        } else if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(annotation)) {
          faults.push(`x-mcp-header "${annotation}" is not a valid HTTP field name`);
        } else if (claimed.has(annotation.toLowerCase())) {
          faults.push(`x-mcp-header "${annotation}" is declared more than once`);
        } else if (!["string", "integer", "boolean"].includes(String(property.type))) {
          // `number` is excluded by the spec: 42.0 and 42 are the same header value and
          // different JSON, so a server comparing them has no unambiguous rule.
          faults.push(`x-mcp-header "${annotation}" is on a ${String(property.type)}, which cannot be a header`);
        } else {
          claimed.add(annotation.toLowerCase());
          paths.set(annotation, here);
        }
      }
      walk(property, here);
    }
  };
  walk(schema, []);

  // Anywhere an annotation can hide that a `properties` walk cannot reach it.
  const unreachable = JSON.stringify(schema ?? {});
  if (unreachable.includes('"x-mcp-header"')) {
    const found = (unreachable.match(/"x-mcp-header"/g) ?? []).length;
    if (found > paths.size + faults.length) {
      faults.push("x-mcp-header appears somewhere no client can read a value from");
    }
  }
  return { paths, faults };
}

/** Read the value at a property path, if the call actually supplied one. */
function valueAt(input: unknown, path: string[]): unknown {
  let here: unknown = input;
  for (const step of path) {
    if (!here || typeof here !== "object") return undefined;
    here = (here as Record<string, unknown>)[step];
  }
  return here;
}

/**
 * Turn a JSON-RPC error from a server into one a person can act on.
 *
 * The three codes this revision defines all mean "your request was well-formed and I still
 * will not serve it", and each has a different remedy. Collapsing them into the message
 * text — which is what a generic `Error(message)` does — throws away the one piece of
 * information that distinguishes "point this at a newer server" from "this client is
 * missing a feature".
 */
export function explain(service: string, method: string, error: { code: number; message: string; data?: unknown }): Error {
  // The code is kept on the error as well as worded into it, for the few places that act
  // on which refusal it was instead of showing it to somebody.
  return Object.assign(explained(service, method, error), { code: error.code });
}

function explained(service: string, method: string, error: { code: number; message: string; data?: unknown }): Error {
  const data = (error.data ?? {}) as { supported?: unknown; requiredCapabilities?: unknown };
  /** Capabilities as a server may name them: a list, or the shape they are declared in. */
  const named = (wanted: unknown): string[] => {
    if (Array.isArray(wanted)) return wanted.map(String);
    if (!wanted || typeof wanted !== "object") return [];
    return Object.entries(wanted).flatMap(([key, value]) =>
      key === "extensions" && value && typeof value === "object" ? Object.keys(value) : [key],
    );
  };
  if (error.code === UNSUPPORTED_VERSION) {
    const supported = Array.isArray(data.supported) ? data.supported.join(", ") : "none stated";
    return new Error(
      `service "${service}" does not speak MCP ${PROTOCOL_VERSION} (it offers: ${supported}). ` +
        `This client implements ${PROTOCOL_VERSION} only — the server needs upgrading.`,
    );
  }
  if (error.code === MISSING_CAPABILITY) {
    const wanted = named(data.requiredCapabilities).join(", ") || "unstated";
    return new Error(
      `service "${service}" needs client capabilities this client does not implement (${wanted}), so ${method} cannot be served`,
    );
  }
  if (error.code === HEADER_MISMATCH) {
    return new Error(
      `service "${service}" rejected ${method}: the mirrored HTTP headers disagreed with the body (${error.message}). ` +
        `If the tool's schema changed, its \`x-mcp-header\` annotations changed with it.`,
    );
  }
  return new Error(`MCP ${service} ${method}: ${error.message}`);
}

/**
 * A result that is not an answer.
 *
 * `resultType: "input_required"` means the server wants something before it can finish —
 * the multi-round-trip pattern that replaced server-initiated requests. An elicitation is
 * answered when the app supplied a handler for its mode, and the call is made again with
 * the answer. Anything else is this: a sampling or roots request (deprecated in this
 * revision and never declared here), or an elicitation in a mode no handler was given
 * for. A conforming server sends neither, since neither was declared; one that does gets
 * a named failure instead of having its interim result read as the final one, which is
 * the specific way this fails silently.
 *
 * A task that reaches `input_required` with nothing this client can answer is the same
 * refusal, made after the task has been cancelled so that the server is not left holding
 * work nobody will answer.
 */
export class InputRequired extends Error {
  readonly service: string;
  readonly method: string;
  readonly requests: string[];
  constructor(
    service: string,
    method: string,
    requests: string[]
  ) {
    super(
      `service "${service}" cannot finish ${method} without more input (${requests.join(", ") || "unnamed"}). ` +
        `This client declared nothing that answers it: elicitation is answered only where the app supplies a ` +
        `handler for that mode, and sampling and roots are deprecated in MCP ${PROTOCOL_VERSION} and not implemented.`,
    );

    this.service = service;
    this.method = method;
    this.requests = requests;
  }
}

/** The JSON-RPC error inside an HTTP error body, when the body carries one. */
function jsonRpcError(body: string): { code: number; message: string; data?: unknown } | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown; message?: unknown; data?: unknown } };
    const error = parsed?.error;
    if (!error || typeof error.code !== "number") return undefined;
    return { code: error.code, message: String(error.message ?? ""), data: error.data };
  } catch {
    return undefined;
  }
}

/**
 * A conforming JSON-RPC request for this revision, metadata and all.
 *
 * Exported because building one by hand is now easy to get subtly wrong: three `_meta`
 * fields with reserved reverse-DNS keys, two of them mandatory, and a server that
 * correctly refuses the request rather than defaulting them. Anything talking to an MCP
 * server without going through `McpClient` — a test, a probe, another transport — should
 * build its requests here rather than reproducing the shape from memory.
 */
/**
 * The protocol headers for one request: what the body says, mirrored where an
 * intermediary can read it without parsing JSON.
 *
 * Exported alongside `mcpRequest` and for the same reason. These are not optional
 * decoration in this revision — a conforming server compares them against the body and
 * refuses a request whose headers are missing or disagree, so anything sending an MCP
 * request over HTTP by other means has to produce them exactly. Auth is deliberately not
 * here: whose credential to present is the caller's business, not the protocol's.
 */
export function mcpHeaders(
  method: string,
  params?: Record<string, unknown>,
  schema?: unknown,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": PROTOCOL_VERSION,
    "mcp-method": method,
  };
  const name = nameFor(method, params);
  if (name !== undefined) headers["mcp-name"] = headerValue(name);

  // Tool parameters the server asked to have mirrored. Omitted rather than sent empty
  // when the call did not supply one — the server MUST NOT expect a header for an
  // argument that is not there, and sending a blank would be a mismatch.
  if (method === "tools/call" && schema) {
    const input = (params?.arguments ?? {}) as Record<string, unknown>;
    for (const [header, path] of headerParamsOf(schema).paths) {
      const value = valueAt(input, path);
      if (value === undefined || value === null) continue;
      headers[`mcp-param-${header.toLowerCase()}`] = headerValue(String(value));
    }
  }
  return headers;
}

export function mcpRequest(
  method: string,
  params: Record<string, unknown> = {},
  id: number | string = 1,
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params,
      _meta: {
        ...((params._meta as Record<string, unknown>)),
        "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
        "io.modelcontextprotocol/clientCapabilities": CLIENT_CAPABILITIES,
        "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
      },
    },
  };
}

/**
 * A server that will not answer without a token, and what it said about getting one.
 *
 * Thrown rather than swallowed because a 401 from an OAuth-protected MCP server is not a
 * failure — it is the first step of the flow, and the challenge it carries names the
 * metadata document that leads to an authorization server. Losing it turns a recoverable
 * state into a dead end, which is what a generic "request failed (401)" does.
 */
export class Unauthorized extends Error {
  readonly service: string;
  readonly resource: string;
  readonly challenge: Challenge | undefined;
  readonly status: number;
  constructor(
    service: string,
    resource: string,
    challenge: Challenge | undefined,
    status: number
  ) {
    super(
      challenge?.error === "insufficient_scope"
        ? `service "${service}" needs more scope than this token has` +
            (challenge.scope?.length ? ` (${challenge.scope.join(", ")})` : "")
        : `service "${service}" requires authorization` +
            (challenge?.resourceMetadata ? `; its metadata is at ${challenge.resourceMetadata}` : ""),
    );

    this.service = service;
    this.resource = resource;
    this.challenge = challenge;
    this.status = status;
  }
}

/**
 * How an application supplies a token when a server asks for one.
 *
 * The framework does not run this flow itself, and the reason is not squeamishness: the
 * flow needs a browser, a place to put a callback, and somewhere to keep tokens, and a
 * framework that guessed at any of the three would be unusable wherever the guess was
 * wrong. What it does own is the retry — recognising the challenge, asking, and sending
 * the request again — which is the part that is the same everywhere.
 */
export type Authorize = (challenge: Unauthorized) => Promise<string | undefined>;

/**
 * What the harness needs from a service, whichever protocol it speaks.
 *
 * Named as an interface rather than left implicit because it is the seam that keeps
 * "which protocol is this" out of every caller.
 */
export interface ToolSource {
  readonly name: string;
  listTools(opts?: McpRequestOptions): Promise<McpTool[]>;
  remember(tools: McpTool[]): void;
  call(tool: string, args: Record<string, unknown>, opts?: McpCallOptions): Promise<string>;
  close(): void;
  readonly warnings: string[];
}

export class McpClient {
  /** Set when this service is a launched program rather than an endpoint. */
  private readonly stdio?: StdioTransport;
  private nextId = 1;
  private nextToken = 1;
  /** Live progress subscriptions, by the token that was sent with the request. */
  private readonly listening = new Map<
    string,
    { report: (event: McpProgress) => void; id: number }
  >();
  /**
   * Things that went wrong without failing the call — a list that had to be cut short,
   * a resource that would not read. Kept rather than logged, so the caller that owns
   * the user's attention decides what to do with them.
   */
  readonly warnings: string[] = [];

  /** A token obtained through `authorize`, preferred over the configured credential. */
  private granted?: string;

  private readonly service: ResolvedService;

  private readonly fetchImpl: typeof fetch = fetch;

  private readonly authorize?: Authorize;

  /** What the application around this client can do. See `McpHost`. */
  private readonly host: McpHost;

  /** What this client declares on every request, fixed by what it was given. */
  private readonly capabilities: Record<string, unknown>;

  /** Open subscriptions, by the id of the request that opened each. */
  private readonly subscriptions = new Map<
    string,
    { deliver: (method: string, params: Record<string, unknown>) => void; end: () => void }
  >();

  /** Set once the server has said it does not do subscriptions, so it is asked once. */
  private pollOnly = false;

  /** The view each listed tool declared, for the call that will need it. */
  private readonly uis = new Map<string, McpToolUi>();

  /** Pages already read, by address. A page is read once per client, not once per call. */
  private readonly pages = new Map<string, Promise<{ html: string; meta?: Record<string, unknown> } | undefined>>();

  /** The subscription that watches the tool list, while there is one. */
  private watching?: McpSubscription;

  constructor(

    service: ResolvedService,

    fetchImpl: typeof fetch = fetch,

    authorize?: Authorize,

    host: McpHost = {},

  ) {

    this.service = service;

    this.fetchImpl = fetchImpl;

    // A service configured for a machine grant brings its own way to a token, unless the
    // caller handed one in.
    this.authorize = authorize ?? (service.oauth ? authorizerFor(service.oauth, fetchImpl) : undefined);

    this.host = host;

    this.capabilities = clientCapabilities(host, service.oauth?.grant);

    if (service.command?.length) {
      this.stdio = new StdioTransport({
        command: service.command[0] as string,
        args: service.command.slice(1),
        env: service.env,
      });
      // Notifications on stdio arrive on the same pipe as replies and belong to nobody
      // waiting; without this hook the transport drops them, which is correct for noise
      // and wrong for progress.
      this.stdio.onNotification((method, params) => this.notified(method, params));
    }
  }

  /**
   * Stop a launched server, and end every subscription. A spawned process outlives good
   * intentions, and so does an open stream: either keeps a program alive that has
   * finished its work.
   */
  close(): void {
    for (const subscription of this.subscriptions.values()) subscription.end();
    this.subscriptions.clear();
    this.watching = undefined;
    this.stdio?.close();
  }

  get name(): string {
    return this.service.name;
  }

  private warn(text: string): void {
    this.warnings.push(`service "${this.service.name}": ${text}`);
  }

  /**
   * The headers for one request.
   *
   * This revision mirrors selected body fields into headers so a load balancer or gateway
   * can route without parsing JSON — and then requires the server to CHECK that the two
   * agree, because a proxy authorising on the header while the server executes on the body
   * is a confused-deputy bug with a clean exploit. So these are not decoration: a missing
   * or disagreeing header is a `-32020` refusal, not a warning.
   */
  /**
   * The headers for one request: the protocol's, plus whatever credential this service
   * was configured with.
   */
  private headers(method: string, params?: Record<string, unknown>, schema?: unknown): Record<string, string> {
    const headers = mcpHeaders(method, params, schema);
    if (this.granted) {
      // A token obtained through the flow wins over a static credential: the static one
      // is what produced the 401 that started the flow.
      headers.authorization = `Bearer ${this.granted}`;
    } else if (this.service.apiKey) {
      if (this.service.auth === "header" && this.service.header) {
        headers[this.service.header] = this.service.apiKey;
      } else {
        headers.authorization = `Bearer ${this.service.apiKey}`;
      }
    }
    return headers;
  }

  /**
   * Route a notification the server sent us: progress to the call it is about, anything
   * on a subscription to whoever opened it. The rest is dropped.
   */
  private notified(method: string, params: unknown): void {
    if (method !== "notifications/progress") {
      // On stdio every subscription shares the one pipe, so the id is the only thing
      // that says whose a message is. One with no id, or an id nobody opened, is nobody's.
      const meta = (params as { _meta?: Record<string, unknown> } | undefined)?._meta;
      const id = meta?.[SUBSCRIPTION_ID];
      if (id === undefined) return;
      this.subscriptions.get(String(id))?.deliver(method, (params ?? {}) as Record<string, unknown>);
      return;
    }
    const note = params as { progressToken?: string | number; progress?: number; total?: number; message?: string };
    const token = note?.progressToken === undefined ? undefined : String(note.progressToken);
    const waiting = token === undefined ? undefined : this.listening.get(token);
    if (!waiting) return;
    // A server that is still narrating is still alive, so the reply clock is pushed
    // back. Without this a tool that legitimately takes ten minutes and says so every
    // second still times out at sixty, which reports a working server as a broken one.
    this.stdio?.touch(waiting.id);
    waiting.report({
      progress: typeof note.progress === "number" ? note.progress : 0,
      total: typeof note.total === "number" ? note.total : undefined,
      message: typeof note.message === "string" ? note.message : undefined,
    });
  }

  /**
   * One request, made again for as long as the server asks for more and can be answered.
   *
   * A server that needs something from the person mid-call no longer asks on a channel of
   * its own. It ends the request with `input_required`, naming what it wants, and the
   * client makes the SAME request again with the answers and whatever opaque state the
   * server handed over to find its place. Each round is a request of its own, with its
   * own id. The count is capped: a server may ask again as often as it likes, and that
   * must not be a way to keep a call open for ever.
   */
  private async rpc(
    method: string,
    params?: Record<string, unknown>,
    opts: McpRequestOptions & { notify?: boolean; schema?: unknown } = {},
  ): Promise<unknown> {
    let sent = params;
    for (let round = 0; ; round++) {
      const result = await this.once(method, sent, opts);
      const interim = result as { resultType?: unknown; inputRequests?: unknown; requestState?: unknown } | undefined;
      if (interim?.resultType !== "input_required") return result;

      const asked = (interim.inputRequests ?? {}) as Record<string, unknown>;
      if (round >= MAX_INPUT_ROUNDS) {
        throw new Error(
          `service "${this.service.name}" asked for more input ${MAX_INPUT_ROUNDS + 1} times running on ${method} ` +
            `and still had not finished, so the call was given up`,
        );
      }
      const responses = Object.keys(asked).length ? await this.answer(method, params, asked) : undefined;
      sent = {
        ...params,
        ...(responses ? { inputResponses: responses } : {}),
        // Handed back exactly as it came, and only if it came: it is the server's own
        // note to itself, and this client has no business reading it or inventing one.
        ...(typeof interim.requestState === "string" ? { requestState: interim.requestState } : {}),
      };
    }
  }

  /**
   * Answer what a server asked for, or say that nothing here can.
   *
   * All of it or none of it: an answer to half of what was asked is a retry the server
   * will only ask again on. So every request is checked before any handler is called,
   * and a person is never put a question whose answer could not be used.
   */
  private async answer(
    method: string,
    params: Record<string, unknown> | undefined,
    asked: Record<string, unknown>,
  ): Promise<Record<string, ElicitResult>> {
    const service = this.service.name;
    const name = nameFor(method, params) ?? (typeof params?.name === "string" ? params.name : undefined);
    const unanswerable = (): InputRequired => new InputRequired(service, method, Object.keys(asked));

    const planned: [string, () => ElicitResult | Promise<ElicitResult>][] = [];
    for (const [key, raw] of Object.entries(asked)) {
      const request = raw as { method?: unknown; params?: Record<string, unknown> } | null;
      if (request?.method !== "elicitation/create") throw unanswerable();
      const wanted = request.params ?? {};
      const message = typeof wanted.message === "string" ? wanted.message : "";
      // No mode is a form: servers written before there were two may leave it out.
      const mode = wanted.mode === undefined ? "form" : wanted.mode;

      if (mode === "form") {
        const form = this.host.elicit?.form;
        if (!form) throw unanswerable();
        const schema = (wanted.requestedSchema ?? { type: "object", properties: {} }) as Record<string, unknown>;
        planned.push([
          key,
          async () => {
            const said = checkAction(service, await form({ service, method, name, message, schema }));
            if (said.action !== "accept") return { action: said.action };
            const fault = elicitedFault(schema, said.content);
            if (fault) {
              throw new Error(
                `the answer given to "${service}" does not fit the form it asked for: ${fault}. Nothing was sent to it.`,
              );
            }
            return { action: "accept", content: said.content ?? {} };
          },
        ]);
      } else if (mode === "url") {
        const open = this.host.elicit?.url;
        if (!open) throw unanswerable();
        const address = typeof wanted.url === "string" ? wanted.url : "";
        let parsed: URL | undefined;
        try {
          parsed = new URL(address);
        } catch {
          parsed = undefined;
        }
        // A page a person is sent to is a web page. Anything else a server names here —
        // a file, a script, another program's scheme — is not something to offer them.
        if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
          throw new Error(
            `service "${service}" asked for a person to be sent to "${address.slice(0, 200)}", which is not a web address; it was not shown to anyone`,
          );
        }
        const host = parsed.host;
        planned.push([
          key,
          // Only the decision is passed on. Whatever the person does at that address is
          // between them and it; a URL answer never carries content.
          async () => ({ action: checkAction(service, await open({ service, method, name, message, url: address, host })).action }),
        ]);
      } else {
        throw unanswerable();
      }
    }

    const responses: Record<string, ElicitResult> = {};
    // One at a time, in the order asked: these are questions put to one person.
    for (const [key, ask] of planned) responses[key] = await ask();
    return responses;
  }

  /** Whether everything a server asked for is something `answer` has a handler for. */
  private answerable(asked: Record<string, unknown>): boolean {
    return Object.values(asked).every((raw) => {
      const request = raw as { method?: unknown; params?: { mode?: unknown } } | null;
      if (request?.method !== "elicitation/create") return false;
      const mode = request.params?.mode ?? "form";
      return mode === "form" ? Boolean(this.host.elicit?.form) : mode === "url" ? Boolean(this.host.elicit?.url) : false;
    });
  }

  private async once(
    method: string,
    params?: Record<string, unknown>,
    opts: McpRequestOptions & { notify?: boolean; schema?: unknown } = {},
  ): Promise<unknown> {
    const id = this.nextId++;
    let token: string | undefined;

    // Every request carries who is asking, what they can do, and which protocol they are
    // speaking. This is the whole of what the old handshake established, moved onto each
    // request so that no request depends on one that came before it — which is what makes
    // the protocol stateless rather than merely un-negotiated.
    const meta = this.meta(params);

    if (opts.onProgress && !opts.notify) {
      token = `praecise/${this.nextToken++}`;
      // Opting in is what makes progress happen: a server is never asked to narrate work
      // nobody is watching.
      meta.progressToken = token;
      this.listening.set(token, { report: opts.onProgress, id });
    }
    const sent: Record<string, unknown> = { ...(params), _meta: meta };

    try {
      const body = opts.notify
        ? { jsonrpc: "2.0", method, params: sent }
        : { jsonrpc: "2.0", id, method, params: sent };

      // A launched server is spoken to over its own stdin and stdout; everything above
      // this line is identical either way, which is the point of putting the split here.
      if (this.stdio) {
        if (opts.notify) {
          this.stdio.notify(method, sent);
          return undefined;
        }
        return this.settled(
          method,
          await this.stdio.request(id, method, sent, {
            signal: opts.signal,
            label: `MCP ${this.service.name} ${method}`,
          }),
        );
      }

      return await this.http(id, method, body, sent, opts);
    } finally {
      if (token) this.listening.delete(token);
    }
  }

  /** The three fields every request restates, over whatever `_meta` the call brought. */
  private meta(params?: Record<string, unknown>): Record<string, unknown> {
    return {
      ...((params?._meta as Record<string, unknown>)),
      "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
      "io.modelcontextprotocol/clientCapabilities": this.capabilities,
      "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
    };
  }

  private async http(
    id: number,
    method: string,
    body: unknown,
    params: Record<string, unknown>,
    opts: McpRequestOptions & { notify?: boolean; schema?: unknown; retried?: boolean },
  ): Promise<unknown> {
    const response = await this.post(method, body, params, opts);
    if (opts.notify) return undefined;

    const streamed = response.headers.get("content-type")?.includes("text/event-stream");
    if (streamed && response.body) return this.stream(response.body, id, method, opts.signal);

    const text = await response.text();
    if (!text.trim()) return undefined;

    const payload = streamed ? this.walk(text) : (JSON.parse(text) as RpcResponse);
    if (payload?.error) throw explain(this.service.name, method, payload.error);
    return this.settled(method, payload?.result);
  }

  /**
   * Send one request and hand back the response, once it is one worth reading: the
   * authorization round has been gone through and a refusal has been turned into an error.
   */
  private async post(
    method: string,
    body: unknown,
    params: Record<string, unknown>,
    opts: McpRequestOptions & { schema?: unknown; retried?: boolean },
  ): Promise<Response> {
    if (opts.signal?.aborted) throw cancelled(this.service.name, method, opts.signal);

    const response = await this.fetchImpl(this.service.url as string, {
      method: "POST",
      headers: this.headers(method, params, opts.schema),
      body: JSON.stringify(body),
      // Honoured by any real fetch. The stream is closed independently below, because
      // cancellation on HTTP has to hold even against a caller-supplied fetch that
      // ignores the signal it was handed.
      signal: opts.signal,
    });

    // A 401, or a 403 saying the scope is short, is the start of the OAuth flow rather
    // than the end of the request. Retried ONCE: a server that refuses the token it just
    // helped us obtain is refusing for a reason another round trip will not change.
    if (response.status === 401 || response.status === 403) {
      const challenge = parseChallenge(response.headers.get("www-authenticate"));
      // A plain 403 is a decision, not a challenge. Only "your scope is short" is
      // recoverable by asking for more; treating every 403 as one would loop against a
      // server that simply said no.
      if (response.status === 401 || challenge?.error === "insufficient_scope") {
        const asked = new Unauthorized(this.service.name, this.service.url as string, challenge, response.status);
        // Retried ONCE. A server that refuses the token it just helped us obtain is
        // refusing for a reason another round trip will not change — but it is still an
        // authorization failure, and saying "request failed (401)" instead would lose
        // the challenge that names what went wrong.
        if (opts.retried) throw asked;
        const token = this.authorize ? await this.authorize(asked) : undefined;
        if (!token) throw asked;
        this.granted = token;
        return this.post(method, body, params, { ...opts, retried: true });
      }
    }

    if (!response.ok) {
      // A 400 from a conforming server is not an opaque failure — it is one of three
      // named refusals with three different remedies, carried in the body. Reading it is
      // the difference between "upgrade the server" and "MCP request failed (400)".
      const said = await response.text().catch(() => "");
      const refusal = jsonRpcError(said);
      if (refusal) throw explain(this.service.name, method, refusal);
      throw new Error(
        `MCP ${this.service.name} ${method} failed (${response.status}): ${said.slice(0, 200)}`,
      );
    }
    return response;
  }

  /**
   * Read a whole SSE body that arrived at once, dispatching notifications and returning
   * the reply.
   *
   * This used to take the FIRST data frame and call it the answer, which is wrong the
   * moment a server sends anything before its reply — and progress notifications are
   * exactly that. The result was a client that read a progress event as a tool's output
   * as soon as a server got chatty.
   */
  private walk(body: string): RpcResponse | undefined {
    // The tail is whatever followed the last blank line — a single-frame body that was
    // never terminated is the common case, not an edge one.
    const { events, rest } = frames(body);
    for (const event of rest.trim() ? [...events, rest] : events) {
      const payload = payloadOf(event);
      if (!payload) continue;
      if (payload.method) {
        this.notified(payload.method, payload.params);
        continue;
      }
      if (isReply(payload)) return payload;
    }
    return undefined;
  }

  /**
   * Read a streamed reply, handing progress over as it arrives rather than after.
   *
   * Cancellation is the stream being closed. There is no cancel message to send on
   * HTTP: the request IS the response stream, so dropping it is the whole gesture, and
   * doing it here rather than trusting `fetch` to honour a signal means cancellation
   * works with whatever fetch the caller supplied.
   */
  private async stream(
    body: ReadableStream<Uint8Array>,
    id: number,
    method: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Raced against every read rather than checked after one, because a stream that has
    // gone quiet is exactly the case cancellation exists for: waiting for a read that
    // will never resolve is the hang, not the cure for it.
    let aborted: (error: Error) => void = () => undefined;
    let quit = false;
    const stopped = new Promise<never>((_, reject) => {
      aborted = reject;
    });

    const stop = () => {
      // Rejected BEFORE the stream is closed, because closing it resolves the pending
      // read with `done` — and a race between "cancelled" and "the server stopped
      // talking" that the wrong one can win reports a cancellation as a broken server.
      quit = true;
      aborted(cancelled(this.service.name, method, signal));
      void reader.cancel().catch(() => undefined);
    };
    if (signal?.aborted) {
      void reader.cancel().catch(() => undefined);
      throw cancelled(this.service.name, method, signal);
    }
    signal?.addEventListener("abort", stop, { once: true });

    try {
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), stopped]);
        if (quit) throw cancelled(this.service.name, method, signal);
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { events, rest } = frames(buffer);
        buffer = rest;
        for (const event of events) {
          const payload = payloadOf(event);
          if (!payload) continue;
          if (payload.method) {
            this.notified(payload.method, payload.params);
            continue;
          }
          if (!isReply(payload)) continue;
          void reader.cancel().catch(() => undefined);
          if (payload.error) throw explain(this.service.name, method, payload.error);
          return this.settled(method, payload.result);
        }
      }
      // A last frame without its blank-line terminator is still an answer.
      const trailing = payloadOf(buffer);
      if (trailing && isReply(trailing)) {
        if (trailing.error) throw explain(this.service.name, method, trailing.error);
        return this.settled(method, trailing.result);
      }
      throw new Error(`MCP ${this.service.name} ${method}: stream ended without a reply (id ${id})`);
    } finally {
      signal?.removeEventListener("abort", stop);
      reader.releaseLock?.();
    }
  }

  /**
   * Check what kind of result this is before anybody treats it as an answer.
   *
   * `resultType` is required on every result in this revision, and the reason it is worth
   * checking rather than ignoring is `input_required`: an interim result whose shape is
   * close enough to a real one that reading it as final produces an empty answer and no
   * error. An unknown value is invalid per the spec and refused here for the same reason
   * — a future result type will mean something, and guessing it means "complete" is the
   * one guess guaranteed to be wrong.
   */
  private settled(method: string, result: unknown): unknown {
    if (!result || typeof result !== "object") return result;
    const kind = (result as { resultType?: unknown }).resultType;
    if (kind === undefined || kind === "complete") return result;
    // A task is an answer only to a tool call, and only `call` knows how to follow one.
    if (kind === "task" && method === "tools/call") return result;
    if (kind === "input_required") {
      // Only three requests may be answered this way, and `rpc` is what answers them.
      // On any other it is a server breaking the rule, and there is no retry to make.
      if (method === "tools/call" || method === "prompts/get" || method === "resources/read") return result;
      const asked = (result as { inputRequests?: Record<string, unknown> }).inputRequests ?? {};
      throw new InputRequired(this.service.name, method, Object.keys(asked));
    }
    throw new Error(
      `service "${this.service.name}" answered ${method} with resultType "${String(kind)}", which this client does not recognise`,
    );
  }

  /**
   * What a server says it is, and which revisions it can speak.
   *
   * `server/discover` is the one RPC every server MUST implement. A client is not
   * required to call it — any request may be sent cold and a version refusal handled if
   * it comes — and this client does exactly that, calling it only when something has
   * already gone wrong and the answer would name the cause. Calling it up front would add
   * a round trip to every single service on every run to learn something that is almost
   * always "yes".
   */
  async discover(opts: McpRequestOptions = {}): Promise<{
    protocolVersions: string[];
    capabilities: Record<string, unknown>;
    serverInfo?: { name?: string; version?: string };
  }> {
    const result = (await this.rpc("server/discover", {}, opts)) as
      | { protocolVersions?: unknown; capabilities?: unknown; serverInfo?: unknown }
      | undefined;
    const versions = Array.isArray(result?.protocolVersions)
      ? (result.protocolVersions as unknown[]).filter((v): v is string => typeof v === "string")
      : [];
    return {
      protocolVersions: versions,
      capabilities: (result?.capabilities as Record<string, unknown>) ?? {},
      serverInfo: result?.serverInfo as { name?: string; version?: string } | undefined,
    };
  }

  /**
   * Ask to be told when something changes, on a stream that stays open.
   *
   * `subscriptions/listen` is the one request in this revision whose answer is meant to
   * come late: the server acknowledges with what it agreed to send, then says nothing
   * until something it was asked about changes. It replaced the standalone GET stream and
   * `resources/subscribe`, and it is how a task's state is pushed instead of polled.
   *
   * Resolves once the server has acknowledged, with what it acknowledged, which may be
   * less than was asked. A server that does not do this at all refuses the request, and
   * that refusal is what is thrown. Nothing is listened for that was not asked for, and
   * `on` is called for nothing else.
   */
  async listen(
    filter: McpSubscriptionFilter,
    on: (notification: McpNotification) => void,
    opts: { signal?: AbortSignal } = {},
  ): Promise<McpSubscription> {
    const service = this.service.name;
    const method = "subscriptions/listen";
    const id = this.nextId++;
    const key = String(id);
    const params: Record<string, unknown> = { notifications: filter };
    const sent = { ...params, _meta: this.meta(params) };

    // One controller ends it from either side: the caller's signal, or `close()`.
    const ending = new AbortController();
    const stop = (): void => ending.abort(opts.signal?.reason);
    if (opts.signal?.aborted) throw cancelled(service, method, opts.signal);
    opts.signal?.addEventListener("abort", stop, { once: true });

    let acknowledge: (filter: McpSubscriptionFilter) => void = () => undefined;
    let refuse: (error: Error) => void = () => undefined;
    const acknowledged = new Promise<McpSubscriptionFilter>((resolve, reject) => {
      acknowledge = resolve;
      refuse = reject;
    });
    let finish: (how: "graceful" | "dropped" | "cancelled") => void = () => undefined;
    const closed = new Promise<"graceful" | "dropped" | "cancelled">((resolve) => {
      finish = resolve;
    });
    const over = (how: "graceful" | "dropped" | "cancelled", error?: Error): void => {
      this.subscriptions.delete(key);
      opts.signal?.removeEventListener("abort", stop);
      // Before it was acknowledged, an ending is a failure to subscribe at all.
      refuse(
        error ??
          Object.assign(new Error(`service "${service}" ended ${method} before acknowledging it`), {
            // Answered and closed without a word of acknowledgement: the server took
            // the request for something else. It does not offer subscriptions.
            unoffered: how === "graceful" && !ending.signal.aborted,
          }),
      );
      finish(ending.signal.aborted ? "cancelled" : how);
    };

    this.subscriptions.set(key, {
      deliver: (name, said) => {
        if (name === "notifications/subscriptions/acknowledged") {
          acknowledge(filterOf(said.notifications));
          return;
        }
        try {
          on({ method: name, params: said });
        } catch {
          // A listener that throws must not end the stream it is listening to.
        }
      },
      end: () => ending.abort(),
    });

    if (this.stdio) {
      // The reply to this request is the server saying the subscription is over.
      this.stdio.request(id, method, sent, { signal: ending.signal, label: `MCP ${service} ${method}`, patient: true }).then(
        () => over("graceful"),
        (err: unknown) => {
          const code = (err as { code?: number }).code;
          over("dropped", typeof code === "number" ? explain(service, method, { code, message: (err as Error).message }) : (err as Error));
        },
      );
    } else {
      void this.subscribed(id, method, sent, ending.signal).then(
        (how) => over(how),
        (err: unknown) => over("dropped", err as Error),
      );
    }

    // A server that accepts the request and then never acknowledges is not offering this,
    // whatever it meant by accepting. Waiting on it for ever would hang whoever asked.
    const patience = setTimeout(() => {
      refuse(
        Object.assign(new Error(`service "${service}" did not acknowledge ${method} within ${LISTEN_ACK_MS}ms`), { unoffered: true }),
      );
      ending.abort();
    }, LISTEN_ACK_MS);
    try {
      const agreed = await acknowledged;
      return { acknowledged: agreed, closed, close: () => ending.abort() };
    } catch (err) {
      ending.abort();
      if (opts.signal?.aborted) throw cancelled(service, method, opts.signal);
      throw err;
    } finally {
      clearTimeout(patience);
    }
  }

  /**
   * Read a subscription's stream over HTTP until one side ends it.
   *
   * Everything on the stream goes to the subscription it belongs to. The stream is this
   * subscription's own, so a message that names no subscription is taken to be for it;
   * one that names another is not delivered.
   */
  private async subscribed(
    id: number,
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<"graceful" | "dropped"> {
    const service = this.service.name;
    const response = await this.post(method, { jsonrpc: "2.0", id, method, params }, params, { signal });
    const deliver = (payload: RpcResponse): "graceful" | undefined => {
      if (payload.method) {
        const said = (payload.params ?? {}) as Record<string, unknown>;
        const named = (said._meta as Record<string, unknown> | undefined)?.[SUBSCRIPTION_ID];
        if (named === undefined || String(named) === String(id)) this.subscriptions.get(String(id))?.deliver(payload.method, said);
        return undefined;
      }
      if (!isReply(payload)) return undefined;
      if (payload.error) throw explain(service, method, payload.error);
      return "graceful";
    };

    if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body) {
      // A plain answer: a refusal, or a server that closed the subscription at once.
      const text = await response.text();
      const payload = text.trim() ? (JSON.parse(text) as RpcResponse) : undefined;
      return (payload && deliver(payload)) ?? "dropped";
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const quit = (): void => void reader.cancel().catch(() => undefined);
    signal.addEventListener("abort", quit, { once: true });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { events, rest } = frames(buffer);
        buffer = rest;
        for (const event of events) {
          const payload = payloadOf(event);
          if (payload && deliver(payload)) {
            quit();
            return "graceful";
          }
        }
      }
      const trailing = payloadOf(buffer);
      return (trailing && deliver(trailing)) ?? "dropped";
    } finally {
      signal.removeEventListener("abort", quit);
      reader.releaseLock?.();
    }
  }

  /**
   * Be told when this server's tool list changes, for as long as the client is open.
   *
   * `changed` is called when the server says so, and also when the stream is lost without
   * a word: a change may have gone by unheard, and listing again is the only way to know.
   * Answers whether the server agreed. One that did not is listed once, as it always was.
   */
  async watch(changed: () => void): Promise<boolean> {
    if (this.watching) return true;
    if (this.pollOnly) return false;
    let subscription: McpSubscription;
    try {
      subscription = await this.listen({ toolsListChanged: true }, (note) => {
        if (note.method === "notifications/tools/list_changed") changed();
      });
    } catch (err) {
      if (unoffered(err)) this.pollOnly = true;
      return false;
    }
    if (subscription.acknowledged.toolsListChanged !== true) {
      subscription.close();
      return false;
    }
    this.watching = subscription;
    void subscription.closed.then((how) => {
      if (this.watching === subscription) this.watching = undefined;
      if (how === "dropped") changed();
      return how;
    });
    return true;
  }

  // ── Skills ───────────────────────────────────────────────────────────────
  //
  // A server may offer skills: folders holding a SKILL.md and the files it points at.
  // They are listed by two methods of their own and READ as ordinary resources. Listing
  // one is not using one. Nothing here puts a skill in front of a model; that is
  // `harness/mcp-skills.ts`, which checks every file against the manifest first.

  /** What this server says about skills, or nothing if it offers none. Asked once. */
  private offered?: Promise<{ directoryRead: boolean } | undefined>;
  skillsOffered(opts: McpRequestOptions = {}): Promise<{ directoryRead: boolean } | undefined> {
    return (this.offered ??= this.discover(opts).then(
      ({ capabilities }) => {
        const extension = (capabilities.extensions as Record<string, unknown> | undefined)?.[SKILLS_EXTENSION];
        if (!extension || typeof extension !== "object") return undefined;
        return { directoryRead: (extension as { directoryRead?: unknown }).directoryRead === true };
      },
      // A server that cannot be asked offers nothing that can be relied on.
      () => undefined,
    ));
  }

  /**
   * The skills a server lists. Empty for a server that does not declare the extension:
   * the methods may only be sent to one that does.
   *
   * An entry that is not shaped as the extension requires is left out and said so. Its
   * manifest is what every later read is checked against, so half of one is none.
   */
  async listSkills(opts: McpRequestOptions = {}): Promise<McpSkill[]> {
    if (!(await this.skillsOffered(opts))) return [];
    const listed = await this.page<unknown>("skills/list", "skills", {}, opts);
    const usable: McpSkill[] = [];
    for (const raw of listed) {
      const skill = skillOf(raw);
      if (skill) usable.push(skill);
      else this.warn(`a skill entry was not offered: it has no uri, frontmatter with a name and description, or file list`);
    }
    return usable;
  }

  /** One skill by the address of its SKILL.md, listed or not. */
  async getSkill(uri: string, opts: McpRequestOptions = {}): Promise<McpSkill> {
    if (!(await this.skillsOffered(opts))) {
      throw new Error(`service "${this.service.name}" does not declare the ${SKILLS_EXTENSION} extension, so it has no skills to get`);
    }
    const result = (await this.rpc("skills/get", { uri }, opts)) as { skill?: unknown } | undefined;
    const skill = skillOf(result?.skill);
    if (!skill) throw new Error(`service "${this.service.name}" answered skills/get for "${uri}" with something that is not a skill entry`);
    return skill;
  }

  /**
   * Follow a paginated list to its end.
   *
   * The cursor is opaque and belongs to the server; the only two things this knows
   * about it are that an absent one means the end, and that a repeated one means the
   * server is looping — which is worth catching separately from the page cap, because
   * it is the common bug and costs fifty pointless round trips to discover otherwise.
   */
  private async page<T>(
    method: string,
    key: string,
    params: Record<string, unknown> = {},
    opts: McpRequestOptions = {},
  ): Promise<T[]> {
    const collected: T[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const result = (await this.rpc(
        method,
        cursor === undefined ? params : { ...params, cursor },
        opts,
      )) as Record<string, unknown> | undefined;

      const items = result?.[key];
      if (Array.isArray(items)) collected.push(...(items as T[]));

      const next = result?.nextCursor;
      if (typeof next !== "string" || !next) return collected;
      if (seen.has(next)) {
        this.warn(`${method} repeated cursor "${next.slice(0, 40)}"; stopped after ${page + 1} pages`);
        return collected;
      }
      seen.add(next);
      cursor = next;
    }

    this.warn(`${method} still had pages after ${MAX_PAGES}; the rest was not read`);
    return collected;
  }

  async listTools(opts: McpRequestOptions = {}): Promise<McpTool[]> {
    const tools = await this.page<McpTool>("tools/list", "tools", {}, opts);
    const usable: McpTool[] = [];
    for (const tool of tools) {
      const schema = tool.inputSchema ?? { type: "object", properties: {} };
      // A tool whose header annotations are illegal is dropped, not repaired. The client
      // MUST exclude it: the annotation is an instruction about what goes in a header an
      // intermediary may route or authorise on, and an instruction that cannot be followed
      // exactly must not be followed approximately. Dropping one tool rather than failing
      // the list keeps a single bad definition from hiding every good one.
      const { faults } = headerParamsOf(schema);
      if (faults.length) {
        this.warn(`tool "${tool.name}" was not offered: ${faults.join("; ")}`);
        continue;
      }
      usable.push({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: schema,
        // Carried, not dropped. This rebuild is where the server's safety hints were being
        // lost — before anything downstream could read them — so a tool arrived at the agent
        // with no way to tell a lookup from a deletion.
        annotations: tool.annotations,
        // What it said about a view, read whether or not this client renders them: a
        // tool that is for views only must stay out of an agent's list either way.
        ...((): { ui?: McpToolUi } => {
          const ui = uiOf((tool as { _meta?: unknown })._meta);
          return ui ? { ui } : {};
        })(),
      });
    }
    return usable;
  }

  /** The input schema of a named tool, remembered so calls can mirror its headers. */
  private readonly schemas = new Map<string, unknown>();

  /**
   * Record what was listed, so `call` can mirror headers and find a tool's view without
   * listing again. What a server no longer lists is forgotten with it.
   */
  remember(tools: McpTool[]): void {
    this.schemas.clear();
    this.uis.clear();
    for (const tool of tools) {
      this.schemas.set(tool.name, tool.inputSchema);
      if (tool.ui) this.uis.set(tool.name, tool.ui);
    }
  }

  /** What a tool declared about its view, if it was listed with one. */
  uiFor(tool: string): McpToolUi | undefined {
    return this.uis.get(tool);
  }

  /**
   * The page a tool declared, read from the server that declared it.
   *
   * Read with `resources/read`, as the extension requires, and once: a view's page is the
   * same for every call. Only the block served as an MCP App counts. A page that will not
   * read is a warning and no view, never a failed call, because the tool's answer does
   * not depend on it.
   */
  private viewPage(uri: string): Promise<{ html: string; meta?: Record<string, unknown> } | undefined> {
    let reading = this.pages.get(uri);
    if (!reading) {
      reading = this.readResource(uri).then(
        (contents) => {
          const block = contents.find((entry) => (entry.mimeType ?? "").replace(/\s+/g, "").toLowerCase() === UI_MIME);
          if (!block) {
            this.warn(`${uri} was not served as ${UI_MIME}, so it was not handed on as a view`);
            return undefined;
          }
          const html = typeof block.text === "string" ? block.text : Buffer.from(block.blob ?? "", "base64").toString("utf8");
          const meta = block._meta?.ui;
          return { html, ...(meta && typeof meta === "object" ? { meta: meta as Record<string, unknown> } : {}) };
        },
        (err: unknown) => {
          this.pages.delete(uri);
          this.warn(`could not read the view ${uri}: ${(err as Error).message}`);
          return undefined;
        },
      );
      this.pages.set(uri, reading);
    }
    return reading;
  }

  // ── Resources ────────────────────────────────────────────────────────────
  //
  // The framework SERVED resources and could not consume them, which is an odd
  // asymmetry: resources are among the most-implemented server features, and an agent
  // pointed at a server that offers a document could hold every tool it exposed and
  // none of what it knows.
  //
  // How a read resource reaches an agent is the real decision, and the answer taken
  // here is: as knowledge, not as a tool result. A resource is context the application
  // attached because it decided the agent should have it — the same kind of thing as
  // what the agent has learned or been told — rather than something the model chose to
  // fetch mid-turn. So it is rendered as text and joined to the stable part of the
  // system prompt, alongside notes and procedures, ahead of anything written this
  // second. See `collectResources` for the rendering and for what still has to be wired.

  /** Every resource the server offers, following pagination. */
  async listResources(opts: McpRequestOptions = {}): Promise<McpResource[]> {
    const found = await this.page<McpResource>("resources/list", "resources", {}, opts);
    return found.filter((resource) => typeof resource?.uri === "string");
  }

  /** Read one resource, as the blocks the server sent. */
  async readResource(uri: string, opts: McpRequestOptions = {}): Promise<McpResourceContents[]> {
    const result = (await this.rpc("resources/read", { uri }, opts)) as
      | { contents?: McpResourceContents[] }
      | undefined;
    return (result?.contents ?? []).filter(Boolean);
  }

  /**
   * Read one resource as text an agent can carry.
   *
   * A binary resource is described rather than decoded: base64 in a prompt is a large
   * number of tokens spent on something no model can read, and the honest rendering of
   * an image here is a line saying an image is there.
   */
  async readResourceText(uri: string, opts: McpRequestOptions = {}): Promise<string> {
    const contents = await this.readResource(uri, opts);
    return contents
      .map((block) => {
        if (typeof block.text === "string") return block.text;
        if (typeof block.blob === "string") {
          const bytes = Math.floor((block.blob.length * 3) / 4);
          return `[${block.mimeType ?? "binary"}, ${bytes} bytes, not text]`;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  // ── Prompts ──────────────────────────────────────────────────────────────

  /** Every prompt the server offers, following pagination. */
  async listPrompts(opts: McpRequestOptions = {}): Promise<McpPrompt[]> {
    const found = await this.page<McpPrompt>("prompts/list", "prompts", {}, opts);
    return found.filter((prompt) => typeof prompt?.name === "string");
  }

  /**
   * Fill in a prompt and get its messages back, flattened to text.
   *
   * A prompt is a conversation the server wrote, not a string: it can be several turns,
   * and which turn is whose changes what it means. So the roles survive, and only the
   * content blocks are flattened — an embedded resource keeps its text, and anything
   * binary is described.
   */
  async getPrompt(
    name: string,
    args: Record<string, unknown> = {},
    opts: McpRequestOptions = {},
  ): Promise<McpPromptResult> {
    const result = (await this.rpc("prompts/get", { name, arguments: args }, opts)) as
      | { description?: string; messages?: { role?: string; content?: unknown }[] }
      | undefined;

    const messages: McpPromptMessage[] = (result?.messages ?? []).map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      text: (Array.isArray(message.content) ? message.content : [message.content])
        .map(blockText)
        .filter(Boolean)
        .join("\n")
        .trim(),
    }));

    return { description: result?.description, messages };
  }

  /**
   * Autocomplete one argument of a prompt or a resource template.
   *
   * Included because it is the same request shape as everything above and answers a
   * question a person actually has when filling a form. A server that does not
   * implement it answers an error, which is reported as no suggestions rather than as a
   * failure: not knowing what to suggest is a normal outcome of asking.
   */
  async complete(
    ref: { type: "ref/prompt"; name: string } | { type: "ref/resource"; uri: string },
    argument: { name: string; value: string },
    opts: McpRequestOptions = {},
  ): Promise<McpCompletion> {
    const result = (await this.rpc("completion/complete", { ref, argument }, opts).catch(() => undefined)) as
      | { completion?: McpCompletion }
      | undefined;
    const completion = result?.completion;
    return {
      values: Array.isArray(completion?.values) ? completion.values.filter((v) => typeof v === "string") : [],
      total: typeof completion?.total === "number" ? completion.total : undefined,
      hasMore: completion?.hasMore === true,
    };
  }

  /**
   * Follow a task to its end and return what the tool call would have returned.
   *
   * Polling is the whole mechanism: this revision has no stream to resume, so a call that
   * outlives its connection is one the server turned into a task, and every look at it is
   * an ordinary request that can be made again after any failure of the one before.
   *
   * The lifetime is counted from when the task was received and not from the server's
   * `createdAt`, because the two clocks need not agree and the difference is one round
   * trip. Past it the server has discarded the task, so there is nothing left to ask.
   */
  private async follow(tool: string, created: TaskState, opts: McpCallOptions): Promise<unknown> {
    const service = this.service.name;
    const taskId = created.taskId;
    if (typeof taskId !== "string" || !taskId) {
      throw new Error(`service "${service}" answered ${tool} with a task that has no taskId, so there is nothing to poll`);
    }
    const received = Date.now();
    const ttl = typeof created.ttlMs === "number" && created.ttlMs >= 0 ? created.ttlMs : undefined;

    /** Best effort, and bounded: the server may be the thing that stopped answering. */
    const cancel = (): Promise<unknown> =>
      this.rpc("tasks/cancel", { taskId }, { signal: AbortSignal.timeout(TASK_CANCEL_MS) }).catch(() => undefined);

    let steps = 0;
    let last: string | undefined;
    const report = (state: TaskState): void => {
      const message = typeof state.statusMessage === "string" ? state.statusMessage : undefined;
      const line = `${String(state.status)}: ${message ?? ""}`;
      if (!opts.onProgress || line === last) return;
      last = line;
      // A count of what was reported, with no total: a task says where it is, not how
      // far through.
      opts.onProgress({ progress: (steps += 1), message: message ?? `task is ${String(state.status)}` });
    };

    const interval = (state: TaskState, fallback: number): number =>
      typeof state.pollIntervalMs === "number" && state.pollIntervalMs >= 0 ? state.pollIntervalMs : fallback;
    let wait = interval(created, TASK_POLL_MS);
    report(created);

    // Pushed, where the server will push: the task's whole state arrives on a
    // subscription each time it changes, and nothing is asked in between. A server that
    // does not offer that says so once and is polled from then on, as is one whose
    // stream ends before the task does.
    const pushed: TaskState[] = [];
    let wake: () => void = () => undefined;
    let live: McpSubscription | undefined;
    if (!this.pollOnly) {
      try {
        const subscription = await this.listen(
          { taskIds: [taskId] },
          (note) => {
            if (note.method !== "notifications/tasks" || note.params.taskId !== taskId) return;
            pushed.push(note.params as TaskState);
            wake();
          },
          { signal: opts.signal },
        );
        if (subscription.acknowledged.taskIds?.includes(taskId)) {
          live = subscription;
          void subscription.closed.then((how) => {
            live = undefined;
            wake();
            return how;
          });
        } else subscription.close();
      } catch (err) {
        if (opts.signal?.aborted) {
          await cancel();
          throw cancelled(service, "tools/call", opts.signal);
        }
        if (unoffered(err)) this.pollOnly = true;
      }
    }
    /** Input requests already answered, so a server slow to move on is not answered twice. */
    const answered = new Set<string>();
    /** Whether the task has been asked about since the subscription opened. */
    let looked = false;

    try {
      // A task that was already past `working` when it was created is asked about at
      // once: its result is on `tasks/get`, not on the answer that announced it.
      let pause = created.status === "working";
      for (;;) {
        const left = ttl === undefined ? Infinity : received + ttl - Date.now();
        if (left <= 0) {
          throw new Error(
            `service "${service}": the task for ${tool} was still not finished when its lifetime ended ` +
              `(ttlMs ${ttl}), and the server discards a task then. Call the tool again; if it needs longer ` +
              `than that, the server's operator has to allow tasks a longer lifetime.`,
          );
        }

        let state = pushed.shift();
        if (!state) {
          if (live && looked) {
            // Nothing to ask: the next thing to happen is a push, the stream ending, the
            // task's time running out, or the caller giving up.
            await until(
              new Promise<void>((resolve) => {
                wake = resolve;
              }),
              left,
              opts.signal,
            );
            continue;
          }
          // With a subscription just opened the task is asked about once, at once: it may
          // have moved between being created and being listened for, and a change that
          // happened before anyone was listening is never pushed.
          if (pause && !live) {
            await sleep(Math.min(wait, left), opts.signal);
            if (ttl !== undefined && Date.now() >= received + ttl) continue;
          }
          state = ((await this.rpc("tasks/get", { taskId }, { signal: opts.signal })) ?? {}) as TaskState;
          looked = true;
        }
        pause = true;
        report(state);

        switch (state.status) {
          case "completed":
            return state.result;
          case "failed": {
            const said = (state.error as { message?: unknown } | undefined)?.message ?? state.statusMessage;
            // A failure carried as a tool result goes down the path every tool error takes.
            if (said === undefined && state.result !== undefined) return state.result;
            throw new Error(typeof said === "string" && said ? said : `tool ${tool} failed, and the server did not say why`);
          }
          case "cancelled":
            throw new Error(
              `service "${service}" cancelled the task for ${tool}` +
                (typeof state.statusMessage === "string" && state.statusMessage ? `: ${state.statusMessage}` : ""),
            );
          case "input_required": {
            const requests = (state.inputRequests ?? {}) as Record<string, unknown>;
            const fresh = Object.fromEntries(Object.entries(requests).filter(([key]) => !answered.has(key)));
            // Asked and already answered: the server has not caught up yet. Keep following.
            if (Object.keys(requests).length && !Object.keys(fresh).length) break;
            if (Object.keys(fresh).length && this.answerable(fresh)) {
              const responses = await this.answer("tools/call", { name: tool }, fresh);
              for (const key of Object.keys(fresh)) answered.add(key);
              await this.rpc("tasks/update", { taskId, inputResponses: responses }, { signal: opts.signal });
              break;
            }
            const asked = Object.keys(requests);
            // What the server said it is waiting for, when it named no request.
            if (!asked.length && typeof state.statusMessage === "string") asked.push(state.statusMessage);
            await cancel();
            throw new InputRequired(service, "tools/call", asked);
          }
          case "working":
            break;
          default:
            throw new Error(
              `service "${service}" reported the task for ${tool} as "${String(state.status)}", which is not a task status this client recognises`,
            );
        }
        // The server's own figure is a floor; past it the waits lengthen, to a cap.
        wait = Math.min(Math.max(wait * TASK_POLL_GROWTH, interval(state, 0)), Math.max(TASK_POLL_CAP_MS, interval(state, 0)));
      }
    } catch (err) {
      if (!opts.signal?.aborted) throw err;
      // The caller stopped waiting. `notifications/cancelled` is not for tasks, and
      // closing a connection stops nothing: the task has to be told.
      await cancel();
      throw cancelled(service, "tools/call", opts.signal);
    } finally {
      live?.close();
    }
  }

  /** Call a tool and flatten its content blocks to text. */
  async call(
    tool: string,
    args: Record<string, unknown>,
    opts: McpCallOptions = {},
  ): Promise<string> {
    const result = await this.invoke(tool, args, opts);

    const text = (result?.content ?? [])
      .map((block) => mediaIn(block, opts.media) ?? (block.type === "text" ? (block.text ?? "") : JSON.stringify(block)))
      .join("\n")
      .trim();

    if (result?.isError) throw new Error(text || `tool ${tool} reported an error`);

    // The view the tool declared, if this client's host renders them and somebody is
    // taking them. After the error check: a failed call has nothing to show.
    const ui = this.uis.get(tool);
    if (ui?.resourceUri && this.host.apps && opts.ui) {
      const page = await this.viewPage(ui.resourceUri);
      if (page) {
        opts.ui({
          service: this.service.name,
          tool,
          resourceUri: ui.resourceUri,
          mimeType: UI_MIME,
          html: page.html,
          ...(page.meta ? { meta: page.meta } : {}),
          toolInput: args,
          toolResult: { ...(result as Record<string, unknown>) },
        });
      }
    }

    // A server that declared an `outputSchema` returns its answer TWICE: once as
    // prose in `content` for a person or a model to read, and once as data in
    // `structuredContent`. Reading only the prose and re-stringifying it throws away
    // the typed copy the server went to the trouble of producing — and hands the model
    // a rendering of a value instead of the value.
    //
    // The spec requires a server sending `structuredContent` to also send `content`
    // for backwards compatibility, so the prose is not a fallback to prefer; it is the
    // duplicate. Where both exist the structured form wins, serialised canonically so
    // what the model reads is the data rather than someone's idea of how to print it.
    if (result?.structuredContent !== undefined) {
      return JSON.stringify(result.structuredContent);
    }
    return text || "(no output)";
  }

  /**
   * Call a tool and return what the server returned, as it returned it.
   *
   * `call` is this with the blocks flattened for a model. A view is not a model: it is
   * handed a tool's result in the protocol's own shape, so the bridge that serves views
   * calls this.
   */
  async invoke(
    tool: string,
    args: Record<string, unknown>,
    opts: McpCallOptions = {},
  ): Promise<McpToolResult | undefined> {
    const params: Record<string, unknown> = { name: tool, arguments: args };
    // `_meta` is MCP's reserved sideband for exactly this: a compliant server can
    // dedupe a retried side effect on the key without any schema change, and one
    // that ignores `_meta` sees the call it always saw.
    const sideband = {
      ...(opts.idempotencyKey ? { "praecise/idempotencyKey": opts.idempotencyKey } : {}),
      ...traceMeta(opts.trace),
    };
    if (Object.keys(sideband).length) params._meta = sideband;
    const answered = await this.rpc("tools/call", params, {
      signal: opts.signal,
      onProgress: opts.onProgress,
      // The schema is what says which arguments the server wants mirrored into headers.
      // Absent — a call to a tool nobody listed — nothing is mirrored, which is correct:
      // a header this client invented would fail the server's own body comparison.
      schema: this.schemas.get(tool),
    });
    // A server may answer with a task instead of a result. Followed to its end, it
    // yields the result the call would have returned, and everything below is the same.
    return ((answered as { resultType?: unknown } | undefined)?.resultType === "task"
      ? await this.follow(tool, answered as TaskState, opts)
      : answered) as McpToolResult | undefined;
  }
}

/** What `tools/call` answers with, as the protocol shapes it. */
export interface McpToolResult {
  content?: { type: string; text?: string }[];
  /** Typed result, alongside the human-readable blocks. */
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

/**
 * Whether a failure to subscribe means the server does not offer subscriptions at all:
 * it refused the method, ended the request without acknowledging it, or never
 * acknowledged. Such a server is asked once. Any other failure may not happen next time.
 */
function unoffered(err: unknown): boolean {
  const failure = err as { code?: number; unoffered?: boolean } | undefined;
  return failure?.code === METHOD_NOT_FOUND || failure?.unoffered === true;
}

/** A subscription filter as a server sent it back, keeping only what a filter can hold. */
function filterOf(raw: unknown): McpSubscriptionFilter {
  const said = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const strings = (value: unknown): string[] | undefined =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : undefined;
  const resources = strings(said.resourceSubscriptions);
  const tasks = strings(said.taskIds);
  return {
    ...(said.toolsListChanged === true ? { toolsListChanged: true } : {}),
    ...(said.promptsListChanged === true ? { promptsListChanged: true } : {}),
    ...(said.resourcesListChanged === true ? { resourcesListChanged: true } : {}),
    ...(resources ? { resourceSubscriptions: resources } : {}),
    ...(tasks ? { taskIds: tasks } : {}),
  };
}

/** A skill entry, if this is one: an address, a named and described frontmatter, a file list. */
function skillOf(raw: unknown): McpSkill | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const entry = raw as { uri?: unknown; frontmatter?: unknown; resources?: unknown };
  const front = entry.frontmatter as Record<string, unknown> | undefined;
  if (typeof entry.uri !== "string" || !entry.uri || !front || typeof front !== "object") return undefined;
  if (typeof front.name !== "string" || typeof front.description !== "string") return undefined;
  if (entry.resources === "dynamic") {
    return { uri: entry.uri, frontmatter: front as McpSkill["frontmatter"], resources: "dynamic" };
  }
  if (!Array.isArray(entry.resources)) return undefined;
  const files: McpSkillFile[] = [];
  for (const file of entry.resources as { uri?: unknown; digest?: unknown; size?: unknown }[]) {
    if (typeof file?.uri !== "string" || typeof file.digest !== "string" || typeof file.size !== "number") return undefined;
    if (!/^sha256:[0-9a-f]{64}$/.test(file.digest) || !Number.isInteger(file.size) || file.size < 0) return undefined;
    files.push({ uri: file.uri, digest: file.digest, size: file.size });
  }
  // The manifest must hold the skill's own SKILL.md: it is what the entry is an entry for.
  if (!files.some((file) => file.uri === entry.uri)) return undefined;
  return { uri: entry.uri, frontmatter: front as McpSkill["frontmatter"], resources: files };
}

/** A handler's answer, if it is one of the three the protocol has. */
function checkAction(service: string, said: ElicitResult): ElicitResult {
  if (said?.action === "accept" || said?.action === "decline" || said?.action === "cancel") return said;
  throw new Error(
    `the elicitation handler answered "${service}" with action ${JSON.stringify((said as { action?: unknown } | undefined)?.action ?? null)}; ` +
      `it must be "accept", "decline" or "cancel"`,
  );
}

/**
 * Where an accepted form's values do not fit the schema the server asked for, if they
 * do not.
 *
 * The protocol keeps these schemas flat on purpose: an object of strings, numbers,
 * booleans and choices, no nesting. That is small enough to check here without a
 * validator, and it is checked before anything is sent: a server that asked for an
 * integer between 1 and 10 should not be handed a paragraph because a handler was
 * careless.
 */
export function elicitedFault(schema: Record<string, unknown>, content: Record<string, unknown> | undefined): string | undefined {
  const values = content ?? {};
  if (typeof values !== "object" || Array.isArray(values)) return "the content must be an object of field values";
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  for (const required of Array.isArray(schema.required) ? (schema.required as unknown[]) : []) {
    if (typeof required === "string" && values[required] === undefined) return `"${required}" is required`;
  }
  for (const [key, value] of Object.entries(values)) {
    const field = properties[key];
    if (!field) return `"${key}" is not a field of the form`;
    const choices = (list: unknown): unknown[] | undefined =>
      Array.isArray(list)
        ? list.map((choice) => (choice && typeof choice === "object" ? (choice as { const?: unknown }).const : choice))
        : undefined;
    if (field.type === "array") {
      if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return `"${key}" must be a list of choices`;
      const items = (field.items ?? {}) as Record<string, unknown>;
      const allowed = choices(items.enum) ?? choices(items.anyOf) ?? choices(items.oneOf);
      const stray = allowed ? value.find((entry) => !allowed.includes(entry)) : undefined;
      if (stray !== undefined) return `"${key}" holds "${String(stray)}", which is not one of its choices`;
      if (typeof field.minItems === "number" && value.length < field.minItems) return `"${key}" needs at least ${field.minItems}`;
      if (typeof field.maxItems === "number" && value.length > field.maxItems) return `"${key}" takes at most ${field.maxItems}`;
    } else if (field.type === "string") {
      if (typeof value !== "string") return `"${key}" must be text`;
      const allowed = choices(field.enum) ?? choices(field.oneOf);
      if (allowed && !allowed.includes(value)) return `"${key}" must be one of its choices`;
      if (typeof field.minLength === "number" && value.length < field.minLength) return `"${key}" is shorter than ${field.minLength}`;
      if (typeof field.maxLength === "number" && value.length > field.maxLength) return `"${key}" is longer than ${field.maxLength}`;
    } else if (field.type === "number" || field.type === "integer") {
      if (typeof value !== "number" || !Number.isFinite(value)) return `"${key}" must be a number`;
      if (field.type === "integer" && !Number.isInteger(value)) return `"${key}" must be a whole number`;
      if (typeof field.minimum === "number" && value < field.minimum) return `"${key}" is below ${field.minimum}`;
      if (typeof field.maximum === "number" && value > field.maximum) return `"${key}" is above ${field.maximum}`;
    } else if (field.type === "boolean") {
      if (typeof value !== "boolean") return `"${key}" must be true or false`;
    } else {
      return `"${key}" is declared as ${JSON.stringify(field.type ?? null)}, which a form cannot hold`;
    }
  }
  return undefined;
}

/**
 * Wait for something to happen, for no longer than `ms`, unless the caller stops waiting.
 * Resolves either way; only an abort rejects.
 */
function until(happened: Promise<void>, ms: number, signal?: AbortSignal): Promise<void> {
  // A timer cannot be set further out than this, and a task may be kept longer.
  const capped = Math.min(ms, 2 ** 31 - 1);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const settle = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      resolve();
    };
    const stop = (): void => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    const timer = setTimeout(settle, capped);
    signal?.addEventListener("abort", stop, { once: true });
    void happened.then(settle);
  });
}

/** Wait, unless the caller stops waiting first. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const stop = (): void => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal?.addEventListener("abort", stop, { once: true });
  });
}

/** An abort turned into an error that says which call stopped and why. */
function cancelled(service: string, method: string, signal?: AbortSignal): Error {
  const reason =
    signal?.reason instanceof Error
      ? signal.reason.message
      : typeof signal?.reason === "string"
        ? signal.reason
        : undefined;
  return new Error(`MCP ${service} ${method} was cancelled${reason ? `: ${reason}` : ""}`);
}

/**
 * A name segment a model is allowed to say back.
 *
 * Function names on every tool-calling API in use are `[A-Za-z0-9_-]`, and a service is
 * named by its author for people — "risk model", "back-testing harness". Joining those
 * two facts naively produced `risk model__forecast`, which no model can emit as a call:
 * it is not a name the grammar admits. The failure had no error anywhere. The model wrote
 * something shaped like a call, the harness did not recognise it as one, and the run
 * finished with prose where a tool result should have been. Eleven of twelve services in
 * one deployment were unreachable this way, and nothing said so.
 *
 * Runs of invalid characters collapse to a single `-`, so "risk  model" and "risk model"
 * do not become two different tools, and the result is trimmed so a leading space cannot
 * produce a name starting with `-`.
 */
export const serviceSegment = (segment: string): string =>
  segment.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * Namespaced name a model sees for a service's tool.
 *
 * The service half is sanitised; the tool half is not, because it comes from the server's
 * own tool declaration, where it is already required to be callable. Sanitising that too
 * would paper over a server genuinely misdeclaring its tools.
 */
export const toolName = (service: string, tool: string): string =>
  `${serviceSegment(service)}${SEPARATOR}${tool}`;

/**
 * Split a namespaced tool name back into service and tool.
 *
 * The service returned is the sanitised form — the only form the model was ever shown.
 * Callers holding a map keyed by the author's spelling must resolve through
 * {@link resolveService} rather than by direct lookup.
 */
export function splitToolName(name: string): { service: string; tool: string } | undefined {
  const at = name.indexOf(SEPARATOR);
  if (at <= 0) return undefined;
  return { service: name.slice(0, at), tool: name.slice(at + SEPARATOR.length) };
}

/**
 * Find the entry a model meant, given the sanitised service name it used.
 *
 * The exact key is tried first, so a service whose name was already callable resolves
 * without a scan and behaves exactly as it did before. Only a name that could not have
 * survived sanitisation intact reaches the comparison.
 *
 * Ambiguity is a refusal rather than a guess: if two services sanitise to the same name,
 * calling either would be choosing on the author's behalf, and the author is the only one
 * who can say which they meant.
 */
export function resolveService<T>(entries: Map<string, T>, service: string): T | undefined {
  const exact = entries.get(service);
  if (exact !== undefined) return exact;
  const matches = [...entries.entries()].filter(([key]) => serviceSegment(key) === service);
  const only = matches.length === 1 ? matches[0] : undefined;
  return only?.[1];
}

/**
 * Whether a service needs a credential before it is worth contacting.
 *
 * A launched server takes its secrets from the environment it inherits — that is why
 * `resolveServices` does not demand one for it. Skipping every service without an
 * `apiKey` therefore skipped every stdio server that did not happen to have a matching
 * `<NAME>_API_KEY` set, with a note blaming a credential the author was never asked
 * for. The whole stdio transport was unreachable through this path.
 */
const reachable = (service: ResolvedService): boolean =>
  Boolean(service.apiKey) ||
  Boolean(service.command?.length) ||
  service.openapi !== undefined ||
  // A service that gets its token from a grant has no static credential to be missing.
  service.oauth !== undefined;

/**
 * An HTTP API described by OpenAPI, presented as something with the same shape as an
 * MCP client so that everything above it does not have to know which it is holding.
 *
 * The alternative — a second branch in the harness for "is this an MCP service or an
 * API service" — would put the distinction in every caller, and the callers do not care.
 * What they want is a named thing with tools that can be called.
 */
export class ApiClient {
  private readonly operations = new Map<string, Operation>();
  readonly warnings: string[] = [];

  private readonly service: ResolvedService;

  private readonly fetchImpl: typeof fetch = fetch;

  constructor(

    service: ResolvedService,

    fetchImpl: typeof fetch = fetch

  ) {

    this.service = service;

    this.fetchImpl = fetchImpl;
}

  get name(): string {
    return this.service.name;
  }

  /** Nothing to close: an API is requests, not a connection or a process. */
  close(): void {}

  async listTools(): Promise<McpTool[]> {
    const document =
      typeof this.service.openapi === "string"
        ? await this.fetchDocument(this.service.openapi)
        : this.service.openapi;

    const { operations, notes } = operationsFrom(document, { baseUrl: this.service.baseUrl });
    this.warnings.push(...notes.map((note) => `service "${this.service.name}": ${note}`));
    for (const operation of operations) this.operations.set(operation.name, operation);

    return operations.map((operation) => ({
      name: operation.name,
      description: operation.description,
      inputSchema: operation.parameters,
    }));
  }

  /** Fetch the description. A document that will not load is the whole service failing. */
  private async fetchDocument(url: string): Promise<unknown> {
    const response = await this.fetchImpl(url, { headers: { accept: "application/json" } });
    if (!response.ok) {
      throw new Error(`could not read the OpenAPI description at ${url} (${response.status})`);
    }
    return (await response.json()) as unknown;
  }

  /** Kept for symmetry with `McpClient`; the schemas are already held. */
  remember(_tools: McpTool[]): void {}

  async call(tool: string, args: Record<string, unknown>, opts: McpCallOptions = {}): Promise<string> {
    const operation = this.operations.get(tool);
    if (!operation) throw new Error(`service "${this.service.name}" has no operation named "${tool}"`);

    const headers: Record<string, string> = {};
    if (this.service.apiKey) {
      if (this.service.auth === "header" && this.service.header) headers[this.service.header] = this.service.apiKey;
      else headers.authorization = `Bearer ${this.service.apiKey}`;
    }

    const { text, isError } = await callOperation(operation, args, {
      fetch: this.fetchImpl,
      headers,
      signal: opts.signal,
    });
    // Same rule as a tool result: an API saying "no such id" is something the model can
    // correct, so it comes back as an error the model reads rather than one that ends
    // the turn.
    if (isError) throw new Error(text);
    return text;
  }
}

/** What `collectTools` may be told beyond which services to ask. */
export interface CollectOptions {
  /** What the app can do on a client's behalf. Passed to every MCP client made here. */
  host?: McpHost;
  /**
   * Called with a service's name when it says its tool list changed. Only services
   * marked `watch` are listened to, since each costs a connection held open.
   */
  changed?: (service: string) => void;
  /** Clients already open, by service name, to be listed again instead of opened again. */
  reuse?: Map<string, ToolSource>;
}

/**
 * Connect to every configured service and collect their tools. A service that
 * is unreachable or missing its credential is skipped with a note rather than
 * failing the request — losing one integration should not take the agent down.
 */
export async function collectTools(
  services: ResolvedService[],
  fetchImpl: typeof fetch = fetch,
  options: CollectOptions = {},
): Promise<{
  schemas: ToolSchema[];
  clients: Map<string, ToolSource>;
  notes: string[];
}> {
  const schemas: ToolSchema[] = [];
  const clients = new Map<string, ToolSource>();
  const notes: string[] = [];

  await Promise.all(
    services.map(async (service) => {
      if (!reachable(service)) {
        notes.push(`service "${service.name}" skipped: ${service.credential} is not set`);
        return;
      }
      // An OpenAPI service and an MCP service differ in how tools are discovered and
      // called, and in nothing else that matters here. One already open is listed again
      // on the connection it has: a launched server is not launched twice to be asked
      // the same question.
      const client: ToolSource =
        options.reuse?.get(service.name) ??
        (service.openapi !== undefined
          ? new ApiClient(service, fetchImpl)
          : new McpClient(service, fetchImpl, undefined, options.host));
      try {
        const tools = await client.listTools();
        // Kept so a later `call` can mirror the tool's declared headers without
        // re-listing: discovery is the only place the schemas are already in hand.
        client.remember(tools);
        clients.set(service.name, client);
        if (service.watch && options.changed && client instanceof McpClient) {
          const changed = options.changed;
          const agreed = await client.watch(() => changed(service.name));
          if (!agreed) {
            notes.push(
              `service "${service.name}" is marked \`watch\` and does not send tool-list changes, so its tools are listed once`,
            );
          }
        }
        for (const tool of tools) {
          // A tool a server marked for views only is not a model's to call, and a model
          // is not shown it. The server said who it is for; that holds whether or not
          // anything here renders the view.
          if (tool.ui && !tool.ui.visibility.includes("model")) continue;
          schemas.push({
            name: toolName(service.name, tool.name),
            description: tool.description,
            parameters: tool.inputSchema,
            effect: effectOf(tool.annotations),
          });
        }
        notes.push(...client.warnings);
      } catch (err) {
        notes.push(`service "${service.name}" unavailable: ${(err as Error).message}`);
      }
    }),
  );

  return { schemas, clients, notes };
}

/**
 * Read the resources an agent's services were told to attach, rendered as knowledge.
 *
 * CONSTRAINT: this is deliberately NOT folded into `collectTools`, and deliberately not
 * cached.
 *
 * Tool discovery answers "what can this agent do", which changes when somebody deploys
 * something and is fine to hold for the life of a process. A resource answers "what is
 * true right now" — the open incidents, the current price list — and a cached copy of
 * that is worse than not having it, because an agent quoting a stale document sounds
 * exactly as confident as one quoting a fresh one. So this costs one round trip per
 * attached resource per request, and that cost is the feature.
 *
 * A service that lists `resources: ["*"]` gets everything the server offers, which is a
 * real risk of a large prompt; the count and the size are the author's to decide by
 * naming URIs instead, and a failure to read one is a note rather than a dead request.
 */
export async function collectResources(
  services: ResolvedService[],
  clients: Map<string, ToolSource>,
): Promise<{ text: string; notes: string[] }> {
  const blocks: string[] = [];
  const notes: string[] = [];

  for (const service of services) {
    const wanted = service.resources ?? [];
    if (!wanted.length) continue;

    const found = clients.get(service.name);
    if (!found) {
      notes.push(`service "${service.name}": resources not read, the service was unavailable`);
      continue;
    }
    // Resources are an MCP concept. An OpenAPI description has no equivalent — there is
    // nothing a document publishes that an author could have meant here — so saying so is
    // better than silently attaching nothing to a prompt that was written expecting it.
    if (!(found instanceof McpClient)) {
      notes.push(`service "${service.name}" is an HTTP API and publishes no resources to attach`);
      continue;
    }
    const client = found;

    // Only what this call provokes. The client keeps its warnings for its whole life,
    // and `collectTools` has already reported the ones discovery produced — repeating
    // them here would make one truncated list look like two.
    const before = client.warnings.length;
    const uris = wanted.filter((uri) => uri !== "*");
    if (wanted.includes("*")) {
      try {
        const listed = await client.listResources();
        for (const resource of listed) if (!uris.includes(resource.uri)) uris.push(resource.uri);
      } catch (err) {
        notes.push(`service "${service.name}": could not list resources: ${(err as Error).message}`);
      }
    }

    for (const uri of uris) {
      try {
        const text = await client.readResourceText(uri);
        if (text) blocks.push(`# ${service.name} — ${uri}\n${text}`);
      } catch (err) {
        notes.push(`service "${service.name}": could not read ${uri}: ${(err as Error).message}`);
      }
    }
    notes.push(...client.warnings.slice(before));
  }

  return { text: blocks.join("\n\n"), notes };
}
