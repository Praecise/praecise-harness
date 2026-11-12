/**
 * One socket to a Redis or a Valkey, speaking RESP directly.
 *
 * For the reason the Postgres client is written out rather than installed: the
 * protocol is a page — a type byte, a length or a line, and the bytes — and a client
 * library is a dependency to keep current for the sake of that page.
 *
 * The connection asks for RESP3 with `HELLO 3`, which is also where it authenticates
 * and learns what it is speaking to. RESP3 says what a reply *is* — a map is a map, a
 * double is a double, a boolean is a boolean — where RESP2 flattens all of them into
 * arrays and strings a caller has to know how to read back. A server too old to
 * answer `HELLO` is spoken to in RESP2 instead; every reply type of both is read here,
 * and the handful of places the two differ are handled where the replies are used.
 *
 * Commands go out in order and replies come back in the same order, so several may be
 * sent at once and matched to their answers by position. That is the protocol's
 * pipelining, and it is what makes a hundred small commands cost one round trip.
 *
 * Arguments are always sent as length-prefixed strings. Nothing is ever spliced into a
 * command line, so there is no value a caller can pass that the server reads as syntax.
 */

import { connect as connectTcp, type Socket } from "node:net";
import { connect as connectTls } from "node:tls";

/** How the connection is addressed, once the url has been read. */
export interface RespOptions {
  host: string;
  port: number;
  /** Speak TLS from the first byte, as `rediss://` and `valkeys://` ask. */
  tls: boolean;
  username?: string;
  password?: string;
  /** Which numbered database to select, where one was named. */
  database?: number;
  /** Milliseconds to wait for the socket. */
  timeoutMs: number;
}

/** An error the server answered with, as distinct from the connection failing. */
export class RespError extends Error {
  /** The word the error began with: `ERR`, `WRONGTYPE`, `NOPERM`. */
  readonly code: string;
  constructor(message: string) {
    super(message);
    this.name = "RespError";
    this.code = message.split(" ", 1)[0] ?? "ERR";
  }
}

/** Anything a server can answer with, read into the nearest thing this language has. */
export type Reply = string | number | boolean | null | Reply[] | Map<Reply, Reply> | RespError;

/** One argument of a command. Numbers are sent as their digits. */
export type Arg = string | number;

const CRLF = Buffer.from("\r\n");

/** A command as the protocol frames one: an array of bulk strings. */
export function encodeCommand(args: readonly Arg[]): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`)];
  for (const arg of args) {
    const bytes = Buffer.from(String(arg), "utf8");
    parts.push(Buffer.from(`$${bytes.length}\r\n`), bytes, CRLF);
  }
  return Buffer.concat(parts);
}

/** Thrown inside the reader when a reply is not all here yet. Never leaves this file. */
const INCOMPLETE = Symbol("incomplete");

/**
 * Read one reply from the front of a buffer.
 *
 * Answers with the reply and where the next one starts, or nothing when the bytes for
 * a whole reply have not arrived. `push` is set for the out-of-band messages RESP3
 * sends that answer no command, so the caller can drop them rather than hand them to
 * whoever is waiting.
 */
export function readReply(buffer: Buffer, from = 0): { reply: Reply; next: number; push: boolean } | undefined {
  let at = from;

  const line = (): string => {
    const end = buffer.indexOf(CRLF, at);
    if (end < 0) throw INCOMPLETE;
    const text = buffer.toString("utf8", at, end);
    at = end + 2;
    return text;
  };

  const bulk = (length: number): string => {
    if (buffer.length < at + length + 2) throw INCOMPLETE;
    const text = buffer.toString("utf8", at, at + length);
    at += length + 2;
    return text;
  };

  const double = (text: string): number =>
    text === "inf" ? Infinity : text === "-inf" ? -Infinity : text === "nan" ? Number.NaN : Number(text);

  const read = (): { reply: Reply; push: boolean } => {
    if (at >= buffer.length) throw INCOMPLETE;
    const type = String.fromCharCode(buffer[at]!);
    at += 1;
    const head = line();

    switch (type) {
      case "+":
        return { reply: head, push: false };
      case "-":
        return { reply: new RespError(head), push: false };
      case ":": {
        const value = Number(head);
        // Past this a count is no longer a count, so the digits are kept.
        return { reply: Number.isSafeInteger(value) ? value : head, push: false };
      }
      case "$":
      case "!":
      case "=": {
        const length = Number(head);
        if (length < 0) return { reply: null, push: false };
        const text = bulk(length);
        if (type === "!") return { reply: new RespError(text), push: false };
        // A verbatim string says what it is in its first three bytes and a colon.
        return { reply: type === "=" ? text.slice(4) : text, push: false };
      }
      case "_":
        return { reply: null, push: false };
      case "#":
        return { reply: head === "t", push: false };
      case ",":
        return { reply: double(head), push: false };
      case "(":
        return { reply: head, push: false };
      case "*":
      case "~":
      case ">": {
        const count = Number(head);
        if (count < 0) return { reply: null, push: false };
        const items: Reply[] = [];
        for (let i = 0; i < count; i++) items.push(read().reply);
        return { reply: items, push: type === ">" };
      }
      case "%":
      case "|": {
        const count = Number(head);
        const map = new Map<Reply, Reply>();
        for (let i = 0; i < count; i++) {
          const key = read().reply;
          map.set(key, read().reply);
        }
        // An attribute is a note about the reply that follows it, not a reply.
        return type === "|" ? read() : { reply: map, push: false };
      }
      default:
        throw new Error(`the server sent a reply of a kind this does not know ("${type}")`);
    }
  };

  try {
    const { reply, push } = read();
    return { reply, next: at, push };
  } catch (error) {
    if (error === INCOMPLETE) return undefined;
    throw error;
  }
}

/**
 * A map reply as pairs, whichever protocol wrote it.
 *
 * RESP3 sends a map; RESP2 sends the same thing as a flat list of key, value, key,
 * value. A caller that wants the pairs should not have to know which it was sent.
 */
export function pairsOf(reply: Reply): [Reply, Reply][] {
  if (reply instanceof Map) return [...reply.entries()];
  if (!Array.isArray(reply)) return [];
  const pairs: [Reply, Reply][] = [];
  for (let i = 0; i + 1 < reply.length; i += 2) pairs.push([reply[i]!, reply[i + 1]!]);
  return pairs;
}

interface Waiting {
  resolve: (reply: Reply) => void;
  reject: (error: Error) => void;
}

export class Resp {
  private socket?: Socket;
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private readonly waiting: Waiting[] = [];
  private broken?: Error;
  /** Which protocol the connection settled on. */
  private spoken: 2 | 3 = 2;
  /** What `HELLO` said about the server, where it answered. */
  private said: Map<string, Reply> = new Map();

  private readonly options: RespOptions;

  private constructor(options: RespOptions) {
    this.options = options;
  }

  static async open(options: RespOptions): Promise<Resp> {
    const resp = new Resp(options);
    await resp.handshake();
    return resp;
  }

  /** 3 where the server answered `HELLO 3`, 2 where it could not. */
  get protocol(): 2 | 3 {
    return this.spoken;
  }

  /** What the server said it is: `server`, `version`, `mode`, `modules`. Empty on RESP2. */
  get hello(): ReadonlyMap<string, Reply> {
    return this.said;
  }

  private fail(error: Error): void {
    this.broken ??= error;
    for (const waiting of this.waiting.splice(0)) waiting.reject(error);
  }

  private listen(socket: Socket): void {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => {
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
      try {
        for (;;) {
          const read = readReply(this.buffer);
          if (!read) break;
          this.buffer = this.buffer.subarray(read.next);
          // A push answers nothing, so nobody waiting is handed it.
          if (!read.push) this.waiting.shift()?.resolve(read.reply);
        }
      } catch (error) {
        this.fail(error as Error);
        socket.destroy();
      }
    });
    socket.on("error", (error: Error) => this.fail(error));
    socket.on("close", () => this.fail(new Error("the server closed the connection")));
  }

  private async handshake(): Promise<void> {
    const { username, password, database } = this.options;
    this.listen(await openSocket(this.options));

    // One command that switches protocol, authenticates and says what is on the other
    // end. A server from before it existed answers with an error, and is then spoken
    // to the old way.
    const hello: Arg[] = ["HELLO", 3];
    if (password !== undefined) hello.push("AUTH", username ?? "default", password);
    const [greeting] = await this.pipeline([hello]);
    if (greeting instanceof RespError) {
      if (/WRONGPASS|NOAUTH|invalid (username-password|password)/i.test(greeting.message)) throw greeting;
      if (password !== undefined) {
        await this.command(...(username ? ["AUTH", username, password] : ["AUTH", password]));
      }
    } else {
      this.spoken = 3;
      this.said = new Map(pairsOf(greeting ?? null).map(([key, value]) => [String(key), value]));
    }
    if (database) await this.command("SELECT", database);
  }

  /**
   * Several commands in one write, answered in the order they were sent.
   *
   * An error the server answers with is handed back in its place rather than thrown,
   * because the commands after it were still run and their answers are still owed.
   */
  pipeline(commands: readonly (readonly Arg[])[]): Promise<Reply[]> {
    if (!commands.length) return Promise.resolve([]);
    if (this.broken) return Promise.reject(this.broken);
    const replies = commands.map(
      () =>
        new Promise<Reply>((resolve, reject) => {
          this.waiting.push({ resolve, reject });
        }),
    );
    this.socket?.write(Buffer.concat(commands.map(encodeCommand)));
    return Promise.all(replies);
  }

  /** One command. An error the server answers with is thrown. */
  async command(...args: Arg[]): Promise<Reply> {
    const [reply] = await this.pipeline([args]);
    if (reply instanceof RespError) throw reply;
    return reply ?? null;
  }

  /**
   * Several commands the server runs as one, with nothing of anyone else's in between.
   *
   * This is `MULTI` and `EXEC`, and it is worth saying what that is not: a command
   * that fails once the block is running does not undo the ones before it. The first
   * such failure is thrown here, after the fact, so a caller hears about it.
   */
  async atomic(commands: readonly (readonly Arg[])[]): Promise<Reply[]> {
    if (!commands.length) return [];
    const replies = await this.pipeline([["MULTI"], ...commands, ["EXEC"]]);
    const queued = replies.slice(0, -1).find((reply) => reply instanceof RespError);
    if (queued instanceof RespError) throw queued;
    const done = replies[replies.length - 1];
    if (done instanceof RespError) throw done;
    if (!Array.isArray(done)) throw new Error("the server did not run the commands it was sent as one");
    const failed = done.find((reply) => reply instanceof RespError);
    if (failed instanceof RespError) throw failed;
    return done;
  }

  async close(): Promise<void> {
    if (!this.socket || this.broken) return;
    this.broken = new Error("this connection was closed");
    this.socket.end();
  }
}

function openSocket(options: RespOptions): Promise<Socket> {
  const { host, port, timeoutMs } = options;
  return new Promise((resolve, reject) => {
    const socket: Socket = options.tls ? connectTls({ host, port, servername: host }) : connectTcp({ host, port });
    socket.setNoDelay(true);
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error(`${host}:${port} did not answer within ${timeoutMs}ms`));
    });
    socket.once(options.tls ? "secureConnect" : "connect", () => {
      socket.setTimeout(0);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

/** A connection string, read into the parts a socket needs. */
export function respOptionsFrom(url: string, timeoutMs = 10_000): RespOptions {
  const parsed = new URL(url);
  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  if (!["redis", "rediss", "valkey", "valkeys"].includes(scheme)) {
    throw new Error(`"${scheme}" is not a scheme this client opens: use redis, rediss, valkey, or valkeys`);
  }
  const path = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (path && !/^\d+$/.test(path)) {
    throw new Error(`"${path}" is not a database: the path of a redis url is a number, or nothing`);
  }
  return {
    host: decodeURIComponent(parsed.hostname) || "localhost",
    port: Number(parsed.port || 6379),
    tls: scheme === "rediss" || scheme === "valkeys",
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    database: path ? Number(path) : undefined,
    timeoutMs,
  };
}
