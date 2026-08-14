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
import type { ToolSchema } from "./types.js";

/** The revision we speak when calling out. Kept level with the one we serve. */
/**
 * The MCP revision this speaks — the newest one it ACTUALLY implements, which is not the
 * newest that exists.
 *
 * The revision after this one removed `initialize` outright: a modern client carries its
 * protocol version, capabilities and client info in `_meta` on every request, and asks
 * `server/discover` instead of shaking hands. This implementation shakes hands, so
 * claiming the newer revision would be a false statement on the wire — and per the
 * spec's own compatibility matrix a legacy client against a modern server fails anyway,
 * so the lie would buy nothing and cost the diagnosis.
 *
 * Do not bump this without implementing what the bump claims. When that work happens it
 * is a probe-and-fall-back on both sides: on stdio, call `server/discover` and treat a
 * timeout or an unrecognised error as legacy; on HTTP, attempt a modern request and read
 * the body of a 400 to tell a modern refusal from an old server.
 */
const PROTOCOL_VERSION = "2025-11-25";
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

export class McpClient {
  /** Set when this service is a launched program rather than an endpoint. */
  private readonly stdio?: StdioTransport;
  private sessionId?: string;
  private initialized = false;
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

  constructor(
    private readonly service: ResolvedService,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
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

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
    };
    if (this.service.apiKey) {
      if (this.service.auth === "header" && this.service.header) {
        headers[this.service.header] = this.service.apiKey;
      } else {
        headers.authorization = `Bearer ${this.service.apiKey}`;
      }
    }
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
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
    opts: McpRequestOptions & { notify?: boolean } = {},
  ): Promise<unknown> {
    const id = this.nextId++;
    let sent = params;
    let token: string | undefined;

    if (opts.onProgress && !opts.notify) {
      token = `praecise/${this.nextToken++}`;
      // `_meta.progressToken` is the spec's own sideband, so a server that does not
      // implement progress sees the request it always saw.
      const meta = { ...((params?._meta as Record<string, unknown>) ?? {}), progressToken: token };
      sent = { ...(params ?? {}), _meta: meta };
      this.listening.set(token, { report: opts.onProgress, id });
    }

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
        return await this.stdio.request(id, method, sent, {
          signal: opts.signal,
          label: `MCP ${this.service.name} ${method}`,
        });
      }

      return await this.http(id, method, body, opts);
    } finally {
      if (token) this.listening.delete(token);
    }
  }

  private async http(
    id: number,
    method: string,
    body: unknown,
    opts: McpRequestOptions & { notify?: boolean },
  ): Promise<unknown> {
    if (opts.signal?.aborted) throw cancelled(this.service.name, method, opts.signal);

    const response = await this.fetchImpl(this.service.url as string, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      // Honoured by any real fetch. The stream is closed independently below, because
      // cancellation on HTTP has to hold even against a caller-supplied fetch that
      // ignores the signal it was handed.
      signal: opts.signal,
    });

    const session = response.headers.get("mcp-session-id");
    if (session) this.sessionId = session;

    if (!response.ok) {
      throw new Error(
        `MCP ${this.service.name} ${method} failed (${response.status}): ` +
          `${(await response.text().catch(() => "")).slice(0, 200)}`,
      );
    }
    if (opts.notify) return undefined;

    const streamed = response.headers.get("content-type")?.includes("text/event-stream");
    if (streamed && response.body) return this.stream(response.body, id, method, opts.signal);

    const text = await response.text();
    if (!text.trim()) return undefined;

    const payload = streamed ? this.walk(text) : (JSON.parse(text) as RpcResponse);
    if (payload?.error) {
      throw new Error(`MCP ${this.service.name} ${method}: ${payload.error.message}`);
    }
    return payload?.result;
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
          if (payload.error) {
            throw new Error(`MCP ${this.service.name} ${method}: ${payload.error.message}`);
          }
          return payload.result;
        }
      }
      // A last frame without its blank-line terminator is still an answer.
      const trailing = payloadOf(buffer);
      if (trailing && isReply(trailing)) {
        if (trailing.error) {
          throw new Error(`MCP ${this.service.name} ${method}: ${trailing.error.message}`);
        }
        return trailing.result;
      }
      throw new Error(`MCP ${this.service.name} ${method}: stream ended without a reply (id ${id})`);
    } finally {
      signal?.removeEventListener("abort", stop);
      reader.releaseLock?.();
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    await this.rpc("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "praecise", version: "0.1.0" },
    });
    // Best-effort: some servers do not implement the notification.
    await this.rpc("notifications/initialized", {}, { notify: true }).catch(() => undefined);
    this.initialized = true;
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
    await this.ensureInitialized();
    const tools = await this.page<McpTool>("tools/list", "tools", {}, opts);
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
    }));
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
    await this.ensureInitialized();
    const found = await this.page<McpResource>("resources/list", "resources", {}, opts);
    return found.filter((resource) => typeof resource?.uri === "string");
  }

  /** Read one resource, as the blocks the server sent. */
  async readResource(uri: string, opts: McpRequestOptions = {}): Promise<McpResourceContents[]> {
    await this.ensureInitialized();
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
    await this.ensureInitialized();
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
    await this.ensureInitialized();
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
    await this.ensureInitialized();
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
    await this.ensureInitialized();
    const params: Record<string, unknown> = { name: tool, arguments: args };
    // `_meta` is MCP's reserved sideband for exactly this: a compliant server can
    // dedupe a retried side effect on the key without any schema change, and one
    // that ignores `_meta` sees the call it always saw.
    if (opts.idempotencyKey) params._meta = { "praecise/idempotencyKey": opts.idempotencyKey };
    const result = (await this.rpc("tools/call", params, {
      signal: opts.signal,
      onProgress: opts.onProgress,
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
  Boolean(service.apiKey) || Boolean(service.command?.length);

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
  clients: Map<string, McpClient>;
  notes: string[];
}> {
  const schemas: ToolSchema[] = [];
  const clients = new Map<string, McpClient>();
  const notes: string[] = [];

  await Promise.all(
    services.map(async (service) => {
      if (!reachable(service)) {
        notes.push(`service "${service.name}" skipped: ${service.credential} is not set`);
        return;
      }
      const client = new McpClient(service, fetchImpl);
      try {
        const tools = await client.listTools();
        clients.set(service.name, client);
        for (const tool of tools) {
          schemas.push({
            name: toolName(service.name, tool.name),
            description: tool.description,
            parameters: tool.inputSchema,
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
  clients: Map<string, McpClient>,
): Promise<{ text: string; notes: string[] }> {
  const blocks: string[] = [];
  const notes: string[] = [];

  for (const service of services) {
    const wanted = service.resources ?? [];
    if (!wanted.length) continue;

    const client = clients.get(service.name);
    if (!client) {
      notes.push(`service "${service.name}": resources not read, the service was unavailable`);
      continue;
    }

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
