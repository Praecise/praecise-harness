/**
 * Many requests handed over at once, to be answered when the endpoint gets to them.
 *
 * Several endpoints will take a pile of requests, work through it off-peak and charge
 * less for the trouble. What goes in the pile is exactly what would have been sent one
 * at a time, and what comes out is exactly what would have come back — so nothing here
 * knows what a request or a reply looks like. A wire is asked to build its request and
 * is stopped at the moment it would have sent it; the reply, when the batch is done, is
 * handed to the same wire as though the endpoint had just answered. Every wire that
 * exists, and every one an app registers, can therefore be batched without a line of it
 * changing, and a batched reply is read by the same code that reads a live one.
 *
 * What does differ per endpoint is the pile itself: how it is handed over, how it is
 * asked after, how the answers are fetched. That is a `BatchDriver`, registered under
 * the wire's name. Each one here was written from the vendor's documentation as it
 * stood on 2026-11-13.
 *
 * A request in a batch is still one turn of a conversation. An agent that calls a tool
 * gets its reply from one batch, runs the tool as it always does — guard and all — and
 * its next turn goes into the next batch, with every other agent's next turn.
 */

import type { ChatAdapter, ChatRequest, ChatResponse } from "../types.js";
import { ProviderError } from "../types.js";
import { send, type Endpoint } from "./http.js";

/** One request, as its wire would have sent it. */
export interface BatchItem {
  /** Names the request within its batch. Letters, digits, `-` and `_`. */
  id: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** What the endpoint made of one request: the status and body it would have answered with. */
export interface BatchResult {
  status: number;
  body: unknown;
}

export interface BatchDriver {
  /** The most one batch may hold. */
  limit: { items: number; bytes: number };
  /** Hand the requests over. What comes back is whatever `poll` and `cancel` need to find them again. */
  submit(endpoint: Endpoint, items: BatchItem[]): Promise<unknown>;
  /** Ask after a batch: nothing while it is under way, every result by request id once it is not. */
  poll(endpoint: Endpoint, handle: unknown, items: BatchItem[]): Promise<Map<string, BatchResult> | undefined>;
  /** Tell the endpoint nobody is waiting any more. */
  cancel?(endpoint: Endpoint, handle: unknown): Promise<void>;
}

const MB = 1024 * 1024;

const jsonOf = async <Payload>(response: Response): Promise<Payload> => (await response.json()) as Payload;

/** One JSON value per line, skipping blank lines and anything that is not JSON. */
function lines<Line>(text: string): Line[] {
  const out: Line[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Line);
    } catch {
      // A line that does not parse is a result nobody can be given; its request is
      // reported as unanswered rather than the whole batch as broken.
    }
  }
  return out;
}

// ── messages ────────────────────────────────────────────────────────────────

/** The status each kind of error would have come back with, had the request been sent alone. */
const MESSAGES_STATUS: Record<string, number> = {
  invalid_request_error: 400,
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  overloaded_error: 529,
};

interface MessagesBatch {
  id?: string;
  processing_status?: string;
  results_url?: string | null;
}

interface MessagesLine {
  custom_id?: string;
  result?: { type?: string; message?: unknown; error?: { error?: { type?: string } } };
}

/**
 * `POST {messages}/batches` with every request as `{ custom_id, params }`; asked after
 * at `{messages}/batches/{id}` until `processing_status` is `ended`; results as one JSON
 * line per request at `results_url`, in no particular order, each `succeeded` with the
 * message, `errored` with the error, or `canceled` or `expired` with nothing.
 */
const messagesBatch: BatchDriver = {
  limit: { items: 100_000, bytes: 200 * MB },
  async submit(endpoint, items) {
    const { url, headers } = items[0]!;
    const batch = await jsonOf<MessagesBatch>(
      await send("messages", endpoint, `${url}/batches`, {
        headers,
        body: JSON.stringify({ requests: items.map((item) => ({ custom_id: item.id, params: item.body })) }),
      }),
    );
    if (!batch.id) throw new Error("the endpoint took the batch and returned no id for it");
    return { at: `${url}/batches/${batch.id}`, headers };
  },
  async poll(endpoint, handle) {
    const { at, headers } = handle as { at: string; headers: Record<string, string> };
    const batch = await jsonOf<MessagesBatch>(await send("messages", endpoint, at, { headers }));
    if (batch.processing_status !== "ended") return undefined;
    const text = await (await send("messages", endpoint, batch.results_url ?? `${at}/results`, { headers })).text();
    const results = new Map<string, BatchResult>();
    for (const line of lines<MessagesLine>(text)) {
      if (!line.custom_id) continue;
      const kind = line.result?.type;
      if (kind === "succeeded") results.set(line.custom_id, { status: 200, body: line.result?.message });
      else if (kind === "errored") {
        results.set(line.custom_id, { status: MESSAGES_STATUS[line.result?.error?.error?.type ?? ""] ?? 500, body: line.result?.error });
      } else {
        // Cancelled, or not reached before the batch ran out of time. Neither is the
        // endpoint being busy, so neither is a status that would be waited out.
        results.set(line.custom_id, { status: kind === "expired" ? 408 : 499, body: { error: `the batch ended with this request ${kind ?? "unanswered"}` } });
      }
    }
    return results;
  },
  async cancel(endpoint, handle) {
    const { at, headers } = handle as { at: string; headers: Record<string, string> };
    await send("messages", endpoint, `${at}/cancel`, { method: "POST", headers });
  },
};

// ── responses and chat ──────────────────────────────────────────────────────

interface StoredBatch {
  id?: string;
  status?: string;
  output_file_id?: string | null;
  error_file_id?: string | null;
  errors?: unknown;
}

interface StoredLine {
  custom_id?: string;
  response?: { status_code?: number; body?: unknown } | null;
  error?: { code?: string; message?: string } | null;
}

const withoutContentType = (headers: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== "content-type"));

/**
 * The batch API both of these shapes share: the requests go up as a file of JSON lines
 * (`{ custom_id, method, url, body }`, stored with purpose `batch`), a batch is made
 * from the file for one endpoint path, and it is asked after until its status is one of
 * the four it ends in. The answers are a file of lines too — `{ custom_id, response:
 * { status_code, body }, error }` — with the requests that failed in a second file.
 *
 * `path` is the path the batch API knows the surface by, which is fixed by the API
 * and is not where the app's endpoint happens to be mounted.
 */
function storedBatch(wire: string, suffix: string): BatchDriver {
  const path = `/v1${suffix}`;
  interface Handle {
    root: string;
    id: string;
    headers: Record<string, string>;
  }
  return {
    limit: { items: 50_000, bytes: 180 * MB },
    async submit(endpoint, items) {
      const { url, headers } = items[0]!;
      const root = url.endsWith(suffix) ? url.slice(0, -suffix.length) : url.replace(/\/[^/]*$/, "");
      const form = new FormData();
      form.append("purpose", "batch");
      form.append(
        "file",
        new Blob([items.map((item) => JSON.stringify({ custom_id: item.id, method: "POST", url: path, body: item.body })).join("\n")], { type: "application/jsonl" }),
        "batch.jsonl",
      );
      const file = await jsonOf<{ id?: string }>(await send(wire, endpoint, `${root}/files`, { headers: withoutContentType(headers), body: form }));
      if (!file.id) throw new Error("the endpoint stored the batch's requests and returned no id for the file");
      const batch = await jsonOf<StoredBatch>(
        await send(wire, endpoint, `${root}/batches`, {
          headers,
          body: JSON.stringify({ input_file_id: file.id, endpoint: path, completion_window: "24h" }),
        }),
      );
      if (!batch.id) throw new Error("the endpoint took the batch and returned no id for it");
      return { root, id: batch.id, headers } satisfies Handle;
    },
    async poll(endpoint, handle) {
      const { root, id, headers } = handle as Handle;
      const batch = await jsonOf<StoredBatch>(await send(wire, endpoint, `${root}/batches/${id}`, { headers: withoutContentType(headers) }));
      if (!["completed", "failed", "expired", "cancelled"].includes(batch.status ?? "")) return undefined;
      // `failed` is the file of requests not passing validation: nothing was run.
      if (batch.status === "failed") throw new ProviderError(wire, 400, JSON.stringify(batch.errors ?? "the batch failed validation"));
      const results = new Map<string, BatchResult>();
      for (const file of [batch.output_file_id, batch.error_file_id]) {
        if (!file) continue;
        const text = await (await send(wire, endpoint, `${root}/files/${file}/content`, { headers: withoutContentType(headers) })).text();
        for (const line of lines<StoredLine>(text)) {
          if (!line.custom_id) continue;
          if (line.response?.status_code) results.set(line.custom_id, { status: line.response.status_code, body: line.response.body });
          else results.set(line.custom_id, { status: line.error?.code === "batch_expired" ? 408 : 500, body: { error: line.error ?? "no response" } });
        }
      }
      return results;
    },
    async cancel(endpoint, handle) {
      const { root, id, headers } = handle as Handle;
      await send(wire, endpoint, `${root}/batches/${id}/cancel`, { method: "POST", headers: withoutContentType(headers) });
    },
  };
}

// ── contents ────────────────────────────────────────────────────────────────

interface Operation {
  name?: string;
  done?: boolean;
  metadata?: { state?: string; output?: { inlinedResponses?: unknown } };
  error?: { code?: number; message?: string };
  response?: { inlinedResponses?: unknown };
  dest?: { inlinedResponses?: unknown };
  output?: { inlinedResponses?: unknown };
}

interface Inlined {
  response?: unknown;
  error?: { code?: number; message?: string };
  metadata?: { key?: string };
}

/** The HTTP status the canonical error code this vendor reports would have arrived as. */
const STATUS_OF_CODE: Record<number, number> = { 3: 400, 5: 404, 7: 403, 8: 429, 9: 400, 13: 500, 14: 503, 16: 401 };

/**
 * `POST …/models/{model}:batchGenerateContent` with the requests inline, each beside a
 * `metadata.key`; answered with an operation named `batches/…`, asked after at that name
 * until it is `done` or its state is one that ends. The answers come back inline, each a
 * `response` or an `error`. The documentation does not say they are in the order asked
 * and does not show the key echoed, so a key is used where one comes back and the
 * position where it does not.
 *
 * The model is part of the address on this wire, so a batch holds one model's requests.
 */
const contentsBatch: BatchDriver = {
  limit: { items: 10_000, bytes: 18 * MB },
  async submit(endpoint, items) {
    const { url, headers } = items[0]!;
    const [address = "", query = ""] = url.split("?");
    const operation = await jsonOf<Operation>(
      await send("contents", endpoint, `${address.replace(/:generateContent$/, ":batchGenerateContent")}?${query}`, {
        headers,
        body: JSON.stringify({
          batch: {
            display_name: `praecise-${items.length}`,
            input_config: { requests: { requests: items.map((item) => ({ request: item.body, metadata: { key: item.id } })) } },
          },
        }),
      }),
    );
    if (!operation.name) throw new Error("the endpoint took the batch and returned no name for it");
    return { at: `${address.replace(/\/models\/[^/]*$/, "")}/${operation.name}`, query, headers };
  },
  async poll(endpoint, handle, items) {
    const { at, query, headers } = handle as { at: string; query: string; headers: Record<string, string> };
    const operation = await jsonOf<Operation>(await send("contents", endpoint, `${at}?${query}`, { headers }));
    const state = operation.metadata?.state ?? "";
    const ended = /(SUCCEEDED|FAILED|CANCELLED|EXPIRED)$/.test(state);
    if (!operation.done && !ended) return undefined;
    if (operation.error || /(FAILED|CANCELLED|EXPIRED)$/.test(state)) {
      throw new ProviderError("contents", STATUS_OF_CODE[operation.error?.code ?? 0] ?? 500, JSON.stringify(operation.error ?? { state }));
    }
    const found = operation.response?.inlinedResponses ?? operation.metadata?.output?.inlinedResponses ?? operation.dest?.inlinedResponses ?? operation.output?.inlinedResponses;
    const nested = (found as { inlinedResponses?: unknown } | undefined)?.inlinedResponses;
    const list = (Array.isArray(found) ? found : Array.isArray(nested) ? nested : []) as Inlined[];
    const results = new Map<string, BatchResult>();
    for (const [position, entry] of list.entries()) {
      const id = entry.metadata?.key ?? items[position]?.id;
      if (!id) continue;
      results.set(id, entry.error ? { status: STATUS_OF_CODE[entry.error.code ?? 0] ?? 500, body: { error: entry.error } } : { status: 200, body: entry.response });
    }
    return results;
  },
  async cancel(endpoint, handle) {
    const { at, query, headers } = handle as { at: string; query: string; headers: Record<string, string> };
    await send("contents", endpoint, `${at}:cancel?${query}`, { method: "POST", headers });
  },
};

const DRIVERS = new Map<string, BatchDriver>([
  ["messages", messagesBatch],
  ["responses", storedBatch("responses", "/responses")],
  ["chat", storedBatch("chat", "/chat/completions")],
  ["contents", contentsBatch],
  // `interactions` has none: its vendor's batch API takes `generateContent` requests only.
]);

const BUILT_IN: ReadonlySet<string> = new Set(DRIVERS.keys());

/**
 * Teach the framework how a wire of your own takes a batch.
 *
 * Registered under the wire's name, beside `registerWire`. The ones that ship are not
 * replaceable, for the reason the wires are not.
 */
export function registerBatch(wire: string, driver: BatchDriver): void {
  if (!wire || !wire.trim()) throw new Error("a batch driver is registered under the name of the wire it batches for");
  if (BUILT_IN.has(wire)) throw new Error(`"${wire}" is a shape this framework ships, and so is how it is batched. Register yours under your own wire's name.`);
  if (typeof driver?.submit !== "function" || typeof driver.poll !== "function") throw new Error(`the batch driver for "${wire}" needs \`submit\` and \`poll\``);
  DRIVERS.set(wire, driver);
}

/** The wires that can be batched, for a diagnostic. */
export const knownBatches = (): string[] => [...DRIVERS.keys()];

// ── A wire, stopped before it sends and resumed with an answer ───────────────

class Stopped extends Error {
  readonly sent: Omit<BatchItem, "id">;
  constructor(sent: Omit<BatchItem, "id">) {
    super("stopped before sending");
    this.sent = sent;
  }
}

/** What a wire would send for a request, without sending it. */
export async function requestOf(adapter: ChatAdapter, request: ChatRequest): Promise<Omit<BatchItem, "id">> {
  const stop = (async (url: RequestInfo | URL, init?: RequestInit) => {
    throw new Stopped({
      url: String(url),
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
  }) as typeof fetch;
  try {
    await adapter({ ...request, onText: undefined, signal: undefined, fetch: stop });
  } catch (error) {
    if (error instanceof Stopped) return error.sent;
    throw error;
  }
  throw new Error("the wire answered without sending anything, so there is nothing to batch");
}

/** What a wire makes of an answer, as though the endpoint had just given it. */
export function replyOf(adapter: ChatAdapter, request: ChatRequest, result: BatchResult): Promise<ChatResponse> {
  const answer = (async () =>
    new Response(typeof result.body === "string" ? result.body : JSON.stringify(result.body ?? {}), {
      status: result.status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  return adapter({ ...request, onText: undefined, signal: undefined, fetch: answer });
}

// ── The pile ────────────────────────────────────────────────────────────────

export interface BatchOptions {
  /**
   * Milliseconds before a batch is first asked after. Each time it is still under way
   * the wait doubles, up to a minute. Default five seconds.
   */
  poll?: number;
  /** Milliseconds a batch may take before it is cancelled and its requests fail. Default a day. */
  within?: number;
  /**
   * Milliseconds a request waits for the others before the pile is handed over anyway.
   * A pile goes as soon as every ask is waiting on it, so this is only how long one slow
   * tool may hold the rest up. Default two seconds.
   */
  linger?: number;
  /** Cancels the batches under way and fails what was waiting on them. */
  signal?: AbortSignal;
  /** Told when a batch is handed over and when it comes back, for a progress line. */
  onBatch?: (event: { wire: string; requests: number; state: "submitted" | "done" | "direct" | "failed" }) => void;
  /** How a wait is waited. Replaceable so a test does not. */
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const POLL_MS = 5_000;
const POLL_MOST_MS = 60_000;
const WITHIN_MS = 24 * 60 * 60 * 1000;
const LINGER_MS = 2_000;

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resume, reject) => {
    if (signal?.aborted) return reject(signal.reason instanceof Error ? signal.reason : new Error("cancelled"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resume();
    }, ms);
    const stop = (): void => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("cancelled"));
    };
    signal?.addEventListener("abort", stop, { once: true });
  });
}

interface Waiting {
  wire: string;
  adapter: ChatAdapter;
  request: ChatRequest;
  sent: Omit<BatchItem, "id">;
  bytes: number;
  since: number;
  seat: Seat;
  resolve(reply: ChatResponse): void;
  reject(error: unknown): void;
}

/** One ask's place at the pile: how the pile knows whether everyone is waiting on it. */
export class Seat {
  /** Requests of this ask's that are in the pile or in a batch. */
  waiting = 0;
  gone = false;
  private readonly batcher: Batcher;

  constructor(batcher: Batcher) {
    this.batcher = batcher;
  }

  /** Put a request on the pile, or send it now where its wire has no batch API. */
  chat(wire: string, adapter: ChatAdapter, request: ChatRequest): Promise<ChatResponse> {
    return this.batcher.add(this, wire, adapter, request);
  }

  /** This ask is finished, one way or the other. */
  leave(): void {
    this.gone = true;
    this.batcher.look();
  }
}

/**
 * Collects the requests of many asks and hands them over together.
 *
 * Each ask runs as it always does and has no idea it is in a batch: its request to a
 * model simply takes longer to come back. The pile is handed over once every ask still
 * running is waiting on it — which is the moment nothing more can be added — and what
 * each endpoint is given is one batch per model it is asked for.
 */
export class Batcher {
  private readonly options: BatchOptions;
  private readonly seats = new Set<Seat>();
  private queue: Waiting[] = [];
  /** Endpoints that answered a batch as though they have no batch API at all. */
  private readonly without = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private looking = false;

  constructor(options: BatchOptions = {}) {
    this.options = options;
  }

  seat(): Seat {
    const seat = new Seat(this);
    this.seats.add(seat);
    return seat;
  }

  private placeOf(wire: string, request: ChatRequest): string {
    return `${wire}\u0000${request.baseUrl}\u0000${request.apiKey}`;
  }

  async add(seat: Seat, wire: string, adapter: ChatAdapter, request: ChatRequest): Promise<ChatResponse> {
    const driver = DRIVERS.get(wire);
    if (!driver || this.without.has(this.placeOf(wire, request))) return adapter(request);
    const sent = await requestOf(adapter, request);
    return new Promise<ChatResponse>((resolve, reject) => {
      seat.waiting++;
      const settled = <Value>(pass: (value: Value) => void) => (value: Value): void => {
        seat.waiting--;
        pass(value);
        this.look();
      };
      this.queue.push({
        wire,
        adapter,
        request,
        sent,
        bytes: JSON.stringify(sent.body).length,
        since: Date.now(),
        seat,
        resolve: settled(resolve),
        reject: settled(reject),
      });
      this.look();
    });
  }

  /** See whether the pile should go, a moment from now so that requests made together go together. */
  look(): void {
    if (this.looking) return;
    this.looking = true;
    setTimeout(() => {
      this.looking = false;
      this.decide();
    }, 0);
  }

  private decide(): void {
    clearTimeout(this.timer);
    for (const seat of this.seats) if (seat.gone) this.seats.delete(seat);
    if (!this.queue.length) return;
    const linger = this.options.linger ?? LINGER_MS;
    const oldest = Math.min(...this.queue.map((entry) => entry.since));
    const everyone = [...this.seats].every((seat) => seat.waiting > 0);
    const waited = Date.now() - oldest;
    if (everyone || waited >= linger) return this.flush();
    this.timer = setTimeout(() => this.decide(), linger - waited);
  }

  private flush(): void {
    const groups = new Map<string, Waiting[]>();
    for (const entry of this.queue.splice(0)) {
      // The address is part of the key because on some wires it names the model.
      const key = `${this.placeOf(entry.wire, entry.request)}\u0000${entry.sent.url}`;
      const group = groups.get(key);
      if (group) group.push(entry);
      else groups.set(key, [entry]);
    }
    for (const group of groups.values()) {
      const { limit } = DRIVERS.get(group[0]!.wire)!;
      let chunk: Waiting[] = [];
      let bytes = 0;
      for (const entry of group) {
        if (chunk.length && (chunk.length >= limit.items || bytes + entry.bytes > limit.bytes)) {
          void this.run(chunk);
          chunk = [];
          bytes = 0;
        }
        chunk.push(entry);
        bytes += entry.bytes;
      }
      if (chunk.length) void this.run(chunk);
    }
  }

  /** One batch, from handing it over to handing each ask its reply. */
  private async run(entries: Waiting[]): Promise<void> {
    const first = entries[0]!;
    const { wire } = first;
    const driver = DRIVERS.get(wire)!;
    const signal = this.options.signal;
    const endpoint: Endpoint = {
      baseUrl: first.request.baseUrl,
      apiKey: first.request.apiKey,
      credentialHeader: first.request.credentialHeader,
      // The wire has already put the provider's headers on what it built.
      fetch: first.request.fetch,
      signal,
    };
    const items: BatchItem[] = entries.map((entry, at) => ({ id: `r${at}`, ...entry.sent }));
    const wait = this.options.wait ?? pause;
    const tell = (state: "submitted" | "done" | "direct" | "failed"): void => this.options.onBatch?.({ wire, requests: entries.length, state });

    let handle: unknown;
    try {
      handle = await driver.submit(endpoint, items);
    } catch (error) {
      if (error instanceof ProviderError && [404, 405, 501].includes(error.status)) {
        // No such path: this endpoint speaks the shape and has no batch API. Each
        // request is sent as it would have been, and its ask is told why.
        this.without.add(this.placeOf(wire, first.request));
        tell("direct");
        for (const entry of entries) {
          entry.adapter(entry.request).then(
            (reply) => entry.resolve({ ...reply, notes: [...(reply.notes ?? []), "this endpoint has no batch API, so the request was sent on its own; set `batch: false` on the endpoint to skip the attempt"] }),
            entry.reject,
          );
        }
        return;
      }
      tell("failed");
      for (const entry of entries) entry.reject(error);
      return;
    }
    tell("submitted");

    try {
      const deadline = Date.now() + (this.options.within ?? WITHIN_MS);
      let results: Map<string, BatchResult> | undefined;
      for (let interval = this.options.poll ?? POLL_MS; !results; interval = Math.min(interval * 2, Math.max(POLL_MOST_MS, this.options.poll ?? 0))) {
        if (Date.now() > deadline) throw new ProviderError(wire, 0, `the batch had not finished within ${this.options.within ?? WITHIN_MS}ms`);
        await wait(interval, signal);
        results = await driver.poll(endpoint, handle, items);
      }
      tell("done");
      for (const [at, entry] of entries.entries()) {
        const result = results.get(items[at]!.id);
        if (!result) {
          entry.reject(new ProviderError(wire, 0, "the batch ended without an answer to this request"));
          continue;
        }
        replyOf(entry.adapter, entry.request, result).then(entry.resolve, entry.reject);
      }
    } catch (error) {
      tell("failed");
      // Whatever stopped the waiting, nobody is waiting now.
      await driver.cancel?.({ ...endpoint, signal: undefined }, handle).catch(() => undefined);
      for (const entry of entries) entry.reject(error);
    }
  }
}
