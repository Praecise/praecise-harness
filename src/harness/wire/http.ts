/**
 * What every wire does the same way, written once.
 *
 * The five shapes differ in what a request and a reply LOOK like. They do not differ in
 * how a request is put on the network: a clock on it, the provider's own fields merged
 * underneath, a refusal turned into a `ProviderError` that says how long to wait, and a
 * stream watched between frames. That used to live in the `chat` wire alone, so four of
 * the five could be held open indefinitely by an endpoint that accepted a connection and
 * then said nothing. A behaviour that is right for one wire and absent from the others is
 * not a feature of that wire; it is a gap in the rest.
 */

import type { Attachment, ChatRequest, Stop } from "../types.js";
import { ProviderError } from "../types.js";
import { events } from "./sse.js";

/**
 * How long a stream may go quiet before the endpoint counts as gone.
 *
 * Measured between FRAMES rather than over the whole answer, because a long answer
 * arriving steadily is the endpoint working and a short answer that stopped halfway is
 * the endpoint hung, and only the gap between frames tells those apart.
 */
const IDLE_MS = 45_000;

/**
 * How long a request that will arrive in one piece may take.
 *
 * Nothing is observable until it lands, so the only honest clock is one on the whole
 * thing. Generous, because a thinking model with a full budget does take minutes.
 */
const TOTAL_MS = 240_000;

/** A clock's length, overridable per deployment, ignoring anything that is not a positive number. */
function clockMs(name: string, fallback: number): number {
  const ms = Number(process.env[name]);
  return Number.isFinite(ms) && ms > 0 ? ms : fallback;
}

/**
 * A deadline that can be pushed forward, composed with whatever the caller already holds.
 *
 * Composed rather than substituted: a caller that passed a signal is still entitled to
 * cancel. Which of the two ended the request is kept — the caller's own cancellation is
 * theirs to handle, and only the clock's is turned into a provider failure.
 */
export class Clock {
  readonly signal: AbortSignal;
  readonly ms: number;
  private readonly wire: string;
  private readonly why: string;
  private readonly own = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private fired = false;

  constructor(wire: string, ms: number, why: string, caller?: AbortSignal) {
    this.wire = wire;
    this.ms = ms;
    this.why = why;
    this.signal = caller ? AbortSignal.any([caller, this.own.signal]) : this.own.signal;
  }

  /** Start the countdown, or start it again from now. */
  arm(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.fired = true;
      this.own.abort();
    }, this.ms);
  }

  stop(): void {
    clearTimeout(this.timer);
  }

  /** Whether it was this clock that ended the request rather than the caller. */
  get expired(): boolean {
    return this.fired;
  }

  /**
   * The failure a timeout is reported as: the shape a dead endpoint already produces,
   * status and all, so the ladder crosses to the next model rather than learning a
   * second way to hear the same fact.
   */
  expiry(): ProviderError {
    return new ProviderError(this.wire, 0, `${this.why} within ${this.ms}ms`);
  }
}

/** The clock a request runs under: between frames when it streams, on the whole when it does not. */
export function clockFor(wire: string, request: ChatRequest): Clock {
  return request.onText
    ? new Clock(wire, clockMs("PRAECISE_WIRE_IDLE_MS", IDLE_MS), "the endpoint sent nothing further", request.signal)
    : new Clock(wire, clockMs("PRAECISE_WIRE_TOTAL_MS", TOTAL_MS), "the endpoint did not answer", request.signal);
}

/**
 * How long an endpoint asked to be left alone, in milliseconds.
 *
 * Three spellings are in use: seconds, an HTTP date, and a millisecond header some
 * gateways add because a second is too coarse for a rate limit that clears in fifty.
 */
export function retryAfterOf(headers: Headers): number | undefined {
  const fine = Number(headers.get("retry-after-ms"));
  if (Number.isFinite(fine) && fine > 0) return fine;
  const said = headers.get("retry-after");
  if (!said) return undefined;
  const seconds = Number(said);
  if (Number.isFinite(seconds)) return seconds > 0 ? seconds * 1000 : undefined;
  const until = Date.parse(said);
  return Number.isFinite(until) && until > Date.now() ? until - Date.now() : undefined;
}

/**
 * Send one request, on a clock, and hand back the response and the clock it is under.
 *
 * The provider's declared `body` sits UNDER what the wire built, so a field in a config
 * can fill a gap the protocol does not name and cannot replace the model or the
 * conversation. The clock is returned still running: a streamed reply is read under it,
 * and whoever reads the reply stops it.
 */
export async function post(
  wire: string,
  request: ChatRequest,
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<{ response: Response; clock: Clock }> {
  const clock = clockFor(wire, request);
  clock.arm();
  try {
    const response = await request.fetch(url, {
      method: "POST",
      headers: { ...headers, ...request.headers },
      body: JSON.stringify(request.body ? { ...request.body, ...body } : body),
      signal: clock.signal,
    });
    if (!response.ok) {
      throw new ProviderError(wire, response.status, await response.text(), retryAfterOf(response.headers));
    }
    return { response, clock };
  } catch (error) {
    clock.stop();
    // An abort raised by the clock is this endpoint failing to answer. One raised by the
    // caller's own signal is the caller cancelling, and is left as what it is.
    if (clock.expired && !(error instanceof ProviderError)) throw clock.expiry();
    throw error;
  }
}

/**
 * Where a request that is not a conversation goes: the endpoint a wire already talks to.
 *
 * An upload, a batch and a poll are sent to the same place under the same credential as
 * the conversation they serve, so they are described by the same few fields a
 * `ChatRequest` carries — which is why a `ChatRequest` is one of these as it stands.
 */
export interface Endpoint {
  baseUrl: string;
  apiKey: string;
  credentialHeader?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  fetch: typeof fetch;
}

/**
 * Send something other than a conversation, on a clock, and hand back the whole reply.
 *
 * The body is read before this returns, so the clock covers all of it and what comes
 * back can be read at leisure. A refusal is a `ProviderError`, as it is for a
 * conversation, and the provider's declared headers go on last, as they do there.
 */
export async function send(
  wire: string,
  endpoint: Endpoint,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: BodyInit } = {},
): Promise<Response> {
  const clock = new Clock(wire, clockMs("PRAECISE_WIRE_TOTAL_MS", TOTAL_MS), "the endpoint did not answer", endpoint.signal);
  clock.arm();
  try {
    const response = await endpoint.fetch(url, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { ...init.headers, ...endpoint.headers },
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: clock.signal,
    });
    if (!response.ok) {
      throw new ProviderError(wire, response.status, await response.text(), retryAfterOf(response.headers));
    }
    const bytes = await response.arrayBuffer();
    return new Response(bytes.byteLength ? bytes : null, { status: response.status, headers: response.headers });
  } catch (error) {
    if (clock.expired && !(error instanceof ProviderError)) throw clock.expiry();
    throw error;
  } finally {
    clock.stop();
  }
}

/** The credential as a bearer, or in the header the provider named, or not at all. */
export function bearer(endpoint: Endpoint): Record<string, string> {
  if (!endpoint.apiKey) return {};
  return endpoint.credentialHeader
    ? { [endpoint.credentialHeader]: endpoint.apiKey }
    : { authorization: `Bearer ${endpoint.apiKey}` };
}

/** Read a buffered reply under the clock it was sent on, then stop the clock. */
export async function whole<Payload>(response: Response, clock: Clock): Promise<Payload> {
  try {
    return (await response.json()) as Payload;
  } catch (error) {
    if (clock.expired) throw clock.expiry();
    throw error;
  } finally {
    clock.stop();
  }
}

/**
 * The frames of a streamed reply, with the idle clock started again at each one.
 *
 * A frame is evidence the endpoint is still working. A stream that goes quiet for longer
 * than the clock allows ends as the clock's failure, not as whatever the socket said.
 */
export async function* frames(response: Response, clock: Clock): AsyncGenerator<unknown> {
  try {
    for await (const frame of events(response.body)) {
      clock.arm();
      yield frame;
    }
  } catch (error) {
    if (clock.expired) throw clock.expiry();
    throw error;
  } finally {
    clock.stop();
  }
}

/** Whether a reply was actually streamed, whatever was asked for. */
export const streamed = (response: Response): boolean =>
  !(response.headers.get("content-type") ?? "").includes("application/json");

/**
 * Why a reply ended, in the one vocabulary the runtime reads.
 *
 * Every endpoint names these differently — `max_tokens`, `length`, `MAX_TOKENS`,
 * `max_output_tokens` are one fact in four spellings — and a runtime that compared
 * against one vendor's word saw every other vendor's refusal as an answer. The native
 * word still travels as `finishReason`; this is what decisions are made on.
 */
export function stopOf(native: string | undefined, called: boolean): Stop | undefined {
  if (called) return "tools";
  if (!native) return undefined;
  const said = native.toLowerCase();
  if (/refus|declin/.test(said)) return "refusal";
  if (/safety|filter|blocklist|prohibited|recitation|spii|moderation/.test(said)) return "filter";
  if (/max_tokens|max_output_tokens|length|context_window|timeout/.test(said)) return "length";
  if (/pause|continuation|requires_action|in_progress/.test(said)) return "paused";
  if (/malformed|unexpected_tool|too_many_tool|failed|error|cancel/.test(said)) return "error";
  return "end";
}

/** A data URL for an attachment that arrived as bytes, for the wires that take one. */
export const dataUrl = (attachment: Attachment): string =>
  attachment.url ?? `data:${attachment.mime};base64,${attachment.data ?? ""}`;

/** Whether an attachment is something to look at rather than something to read. */
export const isImage = (attachment: Attachment): boolean => attachment.mime.startsWith("image/");
