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
import { parseChallenge, type Challenge } from "./oauth.js";
import { traceMeta, type TraceContext } from "./trace.js";
import type { Effect } from "../define.js";
import type { ToolSchema } from "./types.js";
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

/**
 * What this client can do, declared on every request.
 *
 * Empty is the honest answer and also a load-bearing one: a server MUST NOT rely on a
 * capability the client did not declare, and MUST refuse with
 * `MissingRequiredClientCapability` rather than proceeding on an assumption. Declaring
 * capabilities we do not implement would convert that clean refusal into a hang.
 */
const CLIENT_CAPABILITIES: Record<string, unknown> = {};

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
 * Required on exactly three methods. Sending it elsewhere is not harmless: a server
 * validates headers against the body and rejects a mismatch, so a name attached to a
 * request whose body has no such field is a `HeaderMismatch` waiting to happen.
 */
export function nameFor(method: string, params?: Record<string, unknown>): string | undefined {
  if (!params) return undefined;
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
  const data = (error.data ?? {}) as { supported?: unknown; requiredCapabilities?: unknown };
  if (error.code === UNSUPPORTED_VERSION) {
    const supported = Array.isArray(data.supported) ? data.supported.join(", ") : "none stated";
    return new Error(
      `service "${service}" does not speak MCP ${PROTOCOL_VERSION} (it offers: ${supported}). ` +
        `This client implements ${PROTOCOL_VERSION} only — the server needs upgrading.`,
    );
  }
  if (error.code === MISSING_CAPABILITY) {
    const wanted = Array.isArray(data.requiredCapabilities) ? data.requiredCapabilities.join(", ") : "unstated";
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
 * `resultType: "input_required"` means the server wants sampling, elicitation, or a roots
 * list before it can finish — the multi-round-trip pattern that replaced server-initiated
 * requests. This client declares no capabilities, so a conforming server should never send
 * one; a server that does anyway gets a named failure rather than having its interim
 * result read as the final one, which is the specific way this fails silently.
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
        `This client declares no sampling, elicitation or roots capability, so it has nothing to answer with.`,
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

  constructor(

    service: ResolvedService,

    fetchImpl: typeof fetch = fetch,

    authorize?: Authorize

  ) {

    this.service = service;

    this.fetchImpl = fetchImpl;

    this.authorize = authorize;

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

  /** Stop a launched server. A spawned process outlives good intentions. */
  close(): void {
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

  /** Route a notification the server sent us. Progress is the only kind we act on. */
  private notified(method: string, params: unknown): void {
    if (method !== "notifications/progress") return;
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

  private async rpc(
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
    const meta: Record<string, unknown> = {
      ...((params?._meta as Record<string, unknown>)),
      "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
      "io.modelcontextprotocol/clientCapabilities": CLIENT_CAPABILITIES,
      "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
    };

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

  private async http(
    id: number,
    method: string,
    body: unknown,
    params: Record<string, unknown>,
    opts: McpRequestOptions & { notify?: boolean; schema?: unknown; retried?: boolean },
  ): Promise<unknown> {
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
        return this.http(id, method, body, params, { ...opts, retried: true });
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
    if (kind === "input_required") {
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
      });
    }
    return usable;
  }

  /** The input schema of a named tool, remembered so calls can mirror its headers. */
  private readonly schemas = new Map<string, unknown>();

  /** Record schemas as they are listed, so `call` can mirror without listing again. */
  remember(tools: McpTool[]): void {
    for (const tool of tools) this.schemas.set(tool.name, tool.inputSchema);
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

  /** Call a tool and flatten its content blocks to text. */
  async call(
    tool: string,
    args: Record<string, unknown>,
    opts: McpCallOptions = {},
  ): Promise<string> {
    const params: Record<string, unknown> = { name: tool, arguments: args };
    // `_meta` is MCP's reserved sideband for exactly this: a compliant server can
    // dedupe a retried side effect on the key without any schema change, and one
    // that ignores `_meta` sees the call it always saw.
    const sideband = {
      ...(opts.idempotencyKey ? { "praecise/idempotencyKey": opts.idempotencyKey } : {}),
      ...traceMeta(opts.trace),
    };
    if (Object.keys(sideband).length) params._meta = sideband;
    const result = (await this.rpc("tools/call", params, {
      signal: opts.signal,
      onProgress: opts.onProgress,
      // The schema is what says which arguments the server wants mirrored into headers.
      // Absent — a call to a tool nobody listed — nothing is mirrored, which is correct:
      // a header this client invented would fail the server's own body comparison.
      schema: this.schemas.get(tool),
    })) as
      | {
          content?: { type: string; text?: string }[];
          /** Typed result, alongside the human-readable blocks. */
          structuredContent?: unknown;
          isError?: boolean;
        }
      | undefined;

    const text = (result?.content ?? [])
      .map((block) => (block.type === "text" ? (block.text ?? "") : JSON.stringify(block)))
      .join("\n")
      .trim();

    if (result?.isError) throw new Error(text || `tool ${tool} reported an error`);

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

/** Namespaced name a model sees for a service's tool. */
export const toolName = (service: string, tool: string): string =>
  `${service}${SEPARATOR}${tool}`;

/** Split a namespaced tool name back into service and tool. */
export function splitToolName(name: string): { service: string; tool: string } | undefined {
  const at = name.indexOf(SEPARATOR);
  if (at <= 0) return undefined;
  return { service: name.slice(0, at), tool: name.slice(at + SEPARATOR.length) };
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
  Boolean(service.apiKey) || Boolean(service.command?.length) || service.openapi !== undefined;

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

/**
 * Connect to every configured service and collect their tools. A service that
 * is unreachable or missing its credential is skipped with a note rather than
 * failing the request — losing one integration should not take the agent down.
 */
export async function collectTools(
  services: ResolvedService[],
  fetchImpl: typeof fetch = fetch,
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
      // called, and in nothing else that matters here.
      const client: ToolSource =
        service.openapi !== undefined ? new ApiClient(service, fetchImpl) : new McpClient(service, fetchImpl);
      try {
        const tools = await client.listTools();
        // Kept so a later `call` can mirror the tool's declared headers without
        // re-listing: discovery is the only place the schemas are already in hand.
        client.remember(tools);
        clients.set(service.name, client);
        for (const tool of tools) {
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
