/**
 * A conversation over one connection, rather than one request after another.
 *
 * Voice is the reason this exists, and it is not a request shape: nothing is asked and
 * then answered. A connection is opened, both sides send when they have something, the
 * model may be cut off mid-sentence, and a tool call arrives in the middle of a reply
 * that goes on around it. None of that fits `ChatAdapter`, so it is a seam of its own
 * with the same rule as the wires: a protocol is an opener registered under a name, and
 * the framework names no model and no address.
 *
 *   registerSession("my-protocol", async (request) => { … return session; });
 *
 * An opener returns a `WireSession` — the protocol's events in one vocabulary, plus the
 * one thing only a protocol knows how to do, which is hand a tool's result back. What an
 * app is given is a `Session` built over that by the runtime, where a tool call has
 * already been through the guard and run by the time the app hears of it.
 */

import type { Attachment, ChatResponse, Stop, ToolCall, ToolSchema, Usage } from "../types.js";

/** The little of a WebSocket this needs, so that a test can stand in its own. */
export interface Socket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: never) => void): void;
}

/**
 * How a socket is made. Node's own `WebSocket` is one of these: it takes the headers a
 * server-side connection authenticates with as a second argument, which a browser's does not.
 */
export type SocketConstructor = new (url: string, options?: { headers?: Record<string, string> }) => Socket;

/** What an opener is given: the endpoint as the app configured it, and what the session is for. */
export interface SessionRequest {
  model: string;
  /** The endpoint's ordinary address, which a protocol's own is usually found from. */
  baseUrl: string;
  /** The WebSocket address, where the app named one. */
  url?: string;
  apiKey: string;
  credentialHeader?: string;
  headers?: Record<string, string>;
  /** Session settings the protocol has names for and this does not, under what the opener builds. */
  body?: Record<string, unknown>;
  system: string;
  tools?: ToolSchema[];
  /** What the model answers in. Speech unless said. */
  output?: "audio" | "text";
  voice?: string;
  signal?: AbortSignal;
  WebSocket: SocketConstructor;
}

/** What is sent into a session at one moment. */
export interface SessionInput {
  /** Something typed. Ends the turn unless `done` is false. */
  text?: string;
  /**
   * A stretch of sound, in the form `Session.audio.input` names. Sound is a stream, so
   * a stretch does not end the turn: the endpoint hears where speech stops, or is told
   * with `done: true`.
   */
  audio?: string;
  /** Pictures to look at, and anything a reader can render for the model to read. */
  attachments?: Attachment[];
  /** Whether this is the end of what is being said. */
  done?: boolean;
}

/**
 * What happens in a session, in the order it happens.
 *
 * `text` is what the model writes and `audio` what it says; `transcript` is what was
 * said aloud by either side, written down, where the endpoint offers that. A `turn` is
 * the model's: it starts, and it ends or is interrupted. `speech` is the endpoint
 * hearing the person start or stop, which is when to stop playing what the model was
 * saying.
 */
export type SessionEvent =
  | { kind: "text"; text: string }
  | { kind: "audio"; data: string; mime: string }
  | { kind: "transcript"; of: "input" | "output"; text: string }
  | { kind: "speech"; state: "started" | "stopped" }
  | { kind: "turn"; state: "started" | "ended" | "interrupted"; stop?: Stop }
  /** A tool is being called. From an opener, a request to call it; from the runtime, the call under way. */
  | { kind: "tool"; call: ToolCall }
  | { kind: "tool result"; name: string; failed: boolean }
  /** The app said not to make that call, and the model was told why. */
  | { kind: "refused"; name: string; why: string }
  /** What a turn cost. */
  | { kind: "usage"; usage: ChatResponse["usage"] }
  | { kind: "note"; text: string }
  | { kind: "error"; error: string }
  | { kind: "closed"; why?: string };

/** The forms sound travels in, each a media type: `audio/pcm;rate=24000` is 16-bit mono PCM at that rate. */
export interface SessionAudio {
  input: string;
  output: string;
}

/**
 * A live conversation. Read it with `for await`; it ends when the connection does.
 */
export interface Session extends AsyncIterable<SessionEvent> {
  /** The forms sound is sent and received in. */
  readonly audio: SessionAudio;
  /** What the session has cost so far. */
  readonly usage: Usage;
  send(input: SessionInput): void;
  /**
   * Stop the model where it is. `heard` is how many milliseconds of its current speech
   * were actually played, for an endpoint that can forget the rest.
   */
  interrupt(heard?: number): void;
  close(): Promise<void>;
}

/** A session as a protocol provides it: the same, plus handing a tool's result back. */
export interface WireSession extends Omit<Session, "usage"> {
  /** Answer a call the model made. `cancelled` calls are dropped by the session itself. */
  answer(call: ToolCall, result: string): void;
}

export type SessionOpener = (request: SessionRequest) => Promise<WireSession>;

const OPENERS = new Map<string, SessionOpener>();
const BUILT_IN = new Set<string>();

/**
 * Teach the framework a session protocol.
 *
 * Under the name of the wire whose endpoints speak it, so an endpoint that `speaks` that
 * wire opens sessions with it; or under a name of its own, written in
 * `realtime.speaks`. The ones that ship are not replaceable, for the reason the wires
 * are not.
 */
export function registerSession(name: string, opener: SessionOpener): void {
  if (!name || !name.trim()) throw new Error("a session protocol needs a name");
  if (BUILT_IN.has(name)) throw new Error(`"${name}" is a session protocol this framework ships. Register yours under a different name and write it in \`realtime.speaks\`.`);
  if (typeof opener !== "function") throw new Error(`session protocol "${name}" must be a function taking a SessionRequest`);
  OPENERS.set(name, opener);
}

/** For the protocols that ship: registered once, and not replaceable after. */
export function shipSession(name: string, opener: SessionOpener): void {
  OPENERS.set(name, opener);
  BUILT_IN.add(name);
}

/** The names sessions can be opened under, for an error message or a diagnostic. */
export const knownSessions = (): string[] => [...OPENERS.keys()];

/** Resolve a protocol by name, naming what is known when it is not. */
export function sessionFor(name: string): SessionOpener {
  const opener = OPENERS.get(name);
  if (!opener) {
    throw new Error(
      `no session protocol called "${name}". This framework opens sessions for ${knownSessions().map((known) => `"${known}"`).join(", ") || "none"}. ` +
        `Add your own with registerSession("${name}", opener) before the app loads, or name one in \`realtime.speaks\`.`,
    );
  }
  return opener;
}

// ── What every protocol does the same way ────────────────────────────────────

/**
 * Events in the order they were pushed, read by one reader at its own pace.
 *
 * A socket delivers when it likes and a reader reads when it can, so what arrives in
 * between is kept. Ending it ends the iteration once what was kept has been read.
 */
export class Events<Event> implements AsyncIterable<Event> {
  private readonly kept: Event[] = [];
  private waiting?: (result: IteratorResult<Event>) => void;
  private ended = false;

  push(event: Event): void {
    if (this.ended) return;
    if (this.waiting) {
      const resume = this.waiting;
      this.waiting = undefined;
      resume({ value: event, done: false });
    } else this.kept.push(event);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.waiting?.({ value: undefined, done: true });
    this.waiting = undefined;
  }

  get done(): boolean {
    return this.ended;
  }

  [Symbol.asyncIterator](): AsyncIterator<Event> {
    return {
      next: () => {
        if (this.kept.length) return Promise.resolve({ value: this.kept.shift()!, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resume) => {
          this.waiting = resume;
        });
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

/** A frame as text, whichever of the forms a socket delivers one in. */
export async function frameText(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.text();
  return String(data ?? "");
}

/** How long a connection may take to be ready before the endpoint counts as not there. */
const OPEN_MS = 30_000;

export interface Line {
  /** Send one JSON message. */
  say(message: Record<string, unknown>): void;
  close(): void;
  /** Whether the connection has ended, whoever ended it. */
  readonly closed: boolean;
}

/**
 * Open a socket and hand each message it delivers, parsed, to `hear`, in order.
 *
 * Returns at once, so that whoever hears the first message already holds the line it
 * came down. `opened` resolves when the socket is open; `ready` is for the protocol to
 * call when its own opening exchange is done, which resolves `settled`. Both reject if
 * the socket closes or errors, the caller cancels, or thirty seconds pass, before that.
 */
export function connect(
  request: SessionRequest,
  url: string,
  headers: Record<string, string>,
  hear: (message: Record<string, unknown>) => void,
  ended: (why?: string) => void,
): { line: Line; opened: Promise<void>; settled: Promise<void>; ready(): void; failed(error: Error): void } {
  const socket = new request.WebSocket(url, { headers: { ...headers, ...request.headers } });
  let closed = false;
  let ready!: () => void;
  let failed!: (error: Error) => void;
  const settled = new Promise<void>((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  // Nobody may be waiting on it by the time it fails, and that is not an error of its own.
  settled.catch(() => undefined);

  const finish = (why?: string): void => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", cancel);
    failed(new Error(why ? `the session ended before it was ready: ${why}` : "the session ended before it was ready"));
    ended(why);
  };
  const line: Line = {
    say: (message) => {
      if (!closed) socket.send(JSON.stringify(message));
    },
    close: () => {
      try {
        socket.close(1000);
      } catch {
        // Already gone, which is what was wanted.
      }
      finish();
    },
    get closed() {
      return closed;
    },
  };
  const cancel = (): void => {
    line.close();
  };
  const timer = setTimeout(() => {
    failed(new Error(`the endpoint did not open a session within ${OPEN_MS}ms`));
    line.close();
  }, OPEN_MS);
  void settled.then(() => clearTimeout(timer), () => clearTimeout(timer));
  if (request.signal?.aborted) cancel();
  else request.signal?.addEventListener("abort", cancel, { once: true });

  // Frames are parsed one after another: a binary frame is read asynchronously, and the
  // one behind it must not overtake it.
  let chain: Promise<void> = Promise.resolve();
  const heard = async (data: unknown): Promise<void> => {
    let message: unknown;
    try {
      message = JSON.parse(await frameText(data));
    } catch {
      return;
    }
    if (typeof message === "object" && message !== null && !closed) hear(message as Record<string, unknown>);
  };
  socket.addEventListener("message", ((event: { data: unknown }) => {
    chain = chain.then(() => heard(event.data));
  }) as (event: never) => void);
  socket.addEventListener("close", ((event: { code?: number; reason?: string }) => {
    void chain.then(() => finish(event?.reason || (event?.code && event.code !== 1000 ? `closed with code ${event.code}` : undefined)));
  }) as (event: never) => void);
  socket.addEventListener("error", ((event: { message?: string; error?: Error }) => {
    void chain.then(() => finish(event?.error?.message ?? event?.message ?? "the connection failed"));
  }) as (event: never) => void);

  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", (() => resolve()) as (event: never) => void);
    settled.catch(reject);
  });
  opened.catch(() => undefined);
  return { line, opened, settled, ready, failed };
}

/** A base address as a WebSocket one: the same host, the secure scheme where the base was secure. */
export function socketBase(baseUrl: string): URL {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "http:" || url.protocol === "ws:" ? "ws:" : "wss:";
  return url;
}
