/**
 * One socket, speaking the protocol directly.
 *
 * This exists so that reaching a real database costs nothing to install. A
 * client is a few hundred lines of framing and one authentication exchange;
 * requiring an app to install one — and to keep it current, and to hold whatever
 * else it depends on — is a larger imposition than writing it down here.
 *
 * Statements go over the extended protocol, which is what makes a value a bound
 * value rather than text spliced into a sentence. Nothing above this file
 * concatenates anything into SQL, and this file will not either: a parameter is
 * always sent as a parameter, and the only untyped strings that reach the server
 * are the statements the framework itself wrote and whatever the author passed
 * to `run`.
 *
 * One connection carries one statement at a time, so work is queued rather than
 * interleaved. That is the protocol's own rule, not a simplification.
 */

import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { connect as connectTcp, type Socket } from "node:net";
import { connect as connectTls } from "node:tls";

/** How the connection is addressed, once the url has been read. */
export interface WireOptions {
  host: string;
  port: number;
  user: string;
  password?: string;
  database: string;
  /** `disable` never encrypts, `verify-full` also checks the certificate. */
  ssl: "disable" | "prefer" | "require" | "verify-full";
  /** Milliseconds to wait for the socket and the handshake. */
  timeoutMs: number;
}

/** The connection while it is held, for work that must not be interleaved. */
export interface Held {
  query(sql: string, params?: readonly unknown[]): Promise<WireResult>;
  exec(sql: string): Promise<WireResult>;
}

export interface WireResult {
  columns: string[];
  rows: unknown[][];
  /** Rows the statement changed, where changing rows is what it did. */
  changed?: number;
}

const PROTOCOL = 196_608; // 3.0
const SSL_REQUEST = 80_877_103;

interface Frame {
  type: string;
  body: Buffer;
}

interface Field {
  name: string;
  oid: number;
}

/** Read a message the way the protocol writes one: length-prefixed, in order. */
class Cursor {
  private at = 0;
  private readonly body: Buffer;
  constructor(
    body: Buffer,
  ) {
    this.body = body;
  }

  int16(): number {
    const value = this.body.readInt16BE(this.at);
    this.at += 2;
    return value;
  }

  int32(): number {
    const value = this.body.readInt32BE(this.at);
    this.at += 4;
    return value;
  }

  /** A run of bytes ending in a zero, which is how the protocol writes text. */
  text(): string {
    const end = this.body.indexOf(0, this.at);
    const value = this.body.toString("utf8", this.at, end);
    this.at = end + 1;
    return value;
  }

  bytes(length: number): Buffer {
    const value = this.body.subarray(this.at, this.at + length);
    this.at += length;
    return value;
  }

  get done(): boolean {
    return this.at >= this.body.length;
  }
}

/** Build a message body, then stamp its own length into the front of it. */
class Packet {
  private readonly parts: Buffer[] = [];

  text(value: string): this {
    this.parts.push(Buffer.from(`${value}\0`, "utf8"));
    return this;
  }

  int16(value: number): this {
    const part = Buffer.alloc(2);
    part.writeInt16BE(value);
    this.parts.push(part);
    return this;
  }

  int32(value: number): this {
    const part = Buffer.alloc(4);
    part.writeInt32BE(value);
    this.parts.push(part);
    return this;
  }

  raw(value: Buffer): this {
    this.parts.push(value);
    return this;
  }

  /** Framed as the server expects: a type byte, a length, and the body. */
  sealed(type?: string): Buffer {
    const body = Buffer.concat(this.parts);
    const head = Buffer.alloc(type ? 5 : 4);
    let at = 0;
    if (type) head.write(type, at++, "latin1");
    head.writeInt32BE(body.length + 4, at);
    return Buffer.concat([head, body]);
  }
}

/** What the server said went wrong, in its own words. */
function errorFrom(body: Buffer): Error {
  const fields = new Map<string, string>();
  const cursor = new Cursor(body);
  while (!cursor.done) {
    const key = cursor.bytes(1).toString("latin1");
    if (key === "\0") break;
    fields.set(key, cursor.text());
  }
  const message = fields.get("M") ?? "the database refused the statement";
  const detail = fields.get("D");
  const error = new Error(detail ? `${message} — ${detail}` : message);
  (error as Error & { code?: string }).code = fields.get("C");
  return error;
}

// ── Values ─────────────────────────────────────────────────────────────────

const BOOL = 16;
const BYTEA = 17;
const INT8 = 20;
const INT2 = 21;
const INT4 = 23;
const JSON_ = 114;
const FLOAT4 = 700;
const FLOAT8 = 701;
const JSONB = 3802;

/** A value as text, which is the one representation every type agrees on. */
function encode(value: unknown): Buffer | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (typeof value === "boolean") return Buffer.from(value ? "t" : "f");
  if (typeof value === "number" || typeof value === "bigint") return Buffer.from(String(value));
  if (value instanceof Uint8Array) return Buffer.from(`\\x${Buffer.from(value).toString("hex")}`);
  if (value instanceof Date) return Buffer.from(value.toISOString());
  return Buffer.from(JSON.stringify(value), "utf8");
}

function decode(raw: Buffer, oid: number): unknown {
  const text = raw.toString("utf8");
  switch (oid) {
    case BOOL:
      return text === "t";
    case BYTEA:
      return Uint8Array.from(Buffer.from(text.slice(2), "hex"));
    case INT2:
    case INT4:
    case FLOAT4:
    case FLOAT8:
      return Number(text);
    case INT8: {
      const value = Number(text);
      // Past this, a count is no longer a count, so the digits are kept.
      return Number.isSafeInteger(value) ? value : text;
    }
    case JSON_:
    case JSONB:
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    default:
      return text;
  }
}

// ── Authentication ─────────────────────────────────────────────────────────

const MECHANISM = "SCRAM-SHA-256";

/** The exchange that proves a password without either side sending it. */
class Scram {
  private readonly nonce = randomBytes(18).toString("base64");
  private salted?: Buffer;
  private auth?: string;
  private readonly password: string;
  constructor(
    password: string,
  ) {
    this.password = password;
  }

  get first(): string {
    return `n,,n=,r=${this.nonce}`;
  }

  /** Answer the server's challenge, keeping what is needed to check its reply. */
  final(challenge: string): string {
    const parts = new Map(
      challenge.split(",").map((part) => [part.slice(0, 1), part.slice(2)] as const),
    );
    const serverNonce = parts.get("r") ?? "";
    const salt = Buffer.from(parts.get("s") ?? "", "base64");
    const rounds = Number(parts.get("i") ?? 4096);
    if (!serverNonce.startsWith(this.nonce)) {
      throw new Error("the database answered a challenge nobody sent");
    }

    this.salted = pbkdf2Sync(this.password, salt, rounds, 32, "sha256");
    const clientKey = createHmac("sha256", this.salted).update("Client Key").digest();
    const storedKey = createHash("sha256").update(clientKey).digest();

    const withoutProof = `c=biws,r=${serverNonce}`;
    this.auth = `n=,r=${this.nonce},${challenge},${withoutProof}`;
    const signature = createHmac("sha256", storedKey).update(this.auth).digest();

    const proof = Buffer.alloc(clientKey.length);
    for (let i = 0; i < clientKey.length; i++) proof[i] = clientKey[i]! ^ signature[i]!;
    return `${withoutProof},p=${proof.toString("base64")}`;
  }

  /** The server proves itself in turn, and a mismatch is not a warning. */
  check(reply: string): void {
    if (!this.salted || !this.auth) throw new Error("the exchange finished out of order");
    const claimed = Buffer.from(reply.slice(reply.indexOf("v=") + 2), "base64");
    const serverKey = createHmac("sha256", this.salted).update("Server Key").digest();
    const expected = createHmac("sha256", serverKey).update(this.auth).digest();
    if (claimed.length !== expected.length || !timingSafeEqual(claimed, expected)) {
      throw new Error("the database could not prove it is the one holding this password");
    }
  }
}

// ── The connection ─────────────────────────────────────────────────────────

export class Wire {
  private socket?: Socket;
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private readonly inbox: Frame[] = [];
  private waiting?: { resolve: (frame: Frame) => void; reject: (error: Error) => void };
  private broken?: Error;
  /** One statement at a time, because that is what one connection carries. */
  private turn: Promise<unknown> = Promise.resolve();

  private readonly options: WireOptions;

  private constructor(options: WireOptions) {
    this.options = options;
  }

  static async open(options: WireOptions): Promise<Wire> {
    const wire = new Wire(options);
    await wire.handshake();
    return wire;
  }

  // ── Framing ──

  private take(frame: Frame): void {
    if (this.waiting) {
      const { resolve } = this.waiting;
      this.waiting = undefined;
      resolve(frame);
      return;
    }
    this.inbox.push(frame);
  }

  private fail(error: Error): void {
    this.broken ??= error;
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.reject(error);
  }

  private listen(socket: Socket): void {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => {
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
      while (this.buffer.length >= 5) {
        const length = this.buffer.readInt32BE(1);
        if (this.buffer.length < length + 1) break;
        this.take({
          type: this.buffer.toString("latin1", 0, 1),
          body: this.buffer.subarray(5, length + 1),
        });
        this.buffer = this.buffer.subarray(length + 1);
      }
    });
    socket.on("error", (error: Error) => this.fail(error));
    socket.on("close", () => this.fail(new Error("the database closed the connection")));
  }

  private next(): Promise<Frame> {
    const queued = this.inbox.shift();
    if (queued) return Promise.resolve(queued);
    if (this.broken) return Promise.reject(this.broken);
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
    });
  }

  private send(packet: Buffer): void {
    if (this.broken) throw this.broken;
    this.socket?.write(packet);
  }

  // ── Opening ──

  private async handshake(): Promise<void> {
    const { host, port, ssl, timeoutMs } = this.options;
    let socket = await openSocket(host, port, timeoutMs);

    if (ssl !== "disable") {
      socket.write(new Packet().int32(SSL_REQUEST).sealed());
      const answer = await firstByte(socket);
      if (answer === "S") {
        socket = await upgrade(socket, host, ssl === "verify-full", timeoutMs);
      } else if (ssl !== "prefer") {
        socket.destroy();
        throw new Error(
          `${host} will not encrypt this connection. Add \`?sslmode=prefer\` to the url if ` +
            `that is expected, or fix the server.`,
        );
      }
    }

    this.listen(socket);

    this.send(
      new Packet()
        .int32(PROTOCOL)
        .text("user")
        .text(this.options.user)
        .text("database")
        .text(this.options.database)
        .text("client_encoding")
        .text("UTF8")
        .raw(Buffer.from([0]))
        .sealed(),
    );

    await this.authenticate();
  }

  private async authenticate(): Promise<void> {
    let scram: Scram | undefined;

    for (;;) {
      const frame = await this.next();
      if (frame.type === "E") throw errorFrom(frame.body);
      if (frame.type === "Z") return;
      if (frame.type !== "R") continue; // status, keys, notices — nothing to answer

      const cursor = new Cursor(frame.body);
      const kind = cursor.int32();
      const password = this.options.password;

      if (kind === 0) continue; // accepted; wait for the ready signal
      if (!password) {
        throw new Error(`${this.options.host} asked for a password and none was in the url`);
      }

      if (kind === 3) {
        this.send(new Packet().text(password).sealed("p"));
      } else if (kind === 5) {
        const salt = cursor.bytes(4);
        const inner = md5(`${password}${this.options.user}`);
        this.send(new Packet().text(`md5${md5(Buffer.concat([Buffer.from(inner), salt]))}`).sealed("p"));
      } else if (kind === 10) {
        const offered: string[] = [];
        while (!cursor.done) {
          const name = cursor.text();
          if (!name) break;
          offered.push(name);
        }
        if (!offered.includes(MECHANISM)) {
          throw new Error(`${this.options.host} offered no authentication this can answer`);
        }
        scram = new Scram(password);
        const first = Buffer.from(scram.first, "utf8");
        this.send(new Packet().text(MECHANISM).int32(first.length).raw(first).sealed("p"));
      } else if (kind === 11 && scram) {
        this.send(new Packet().raw(Buffer.from(scram.final(frame.body.toString("utf8", 4)))).sealed("p"));
      } else if (kind === 12 && scram) {
        scram.check(frame.body.toString("utf8", 4));
      } else {
        throw new Error(`${this.options.host} asked for an authentication this cannot answer`);
      }
    }
  }

  // ── Statements ──

  /** Queue work so two callers cannot share one connection's turn. */
  private queued<T>(work: () => Promise<T>): Promise<T> {
    const mine = this.turn.then(work, work);
    this.turn = mine.catch(() => undefined);
    return mine;
  }

  /** A statement with bound values, which is the only way a value travels. */
  query(sql: string, params: readonly unknown[] = []): Promise<WireResult> {
    return this.queued(() => this.statement(sql, params));
  }

  /** Statements the framework wrote, run as one. Carries no values, by design. */
  exec(sql: string): Promise<WireResult> {
    return this.queued(() => this.simple(sql));
  }

  /**
   * Hold the connection for several statements.
   *
   * A transaction is only a transaction if nothing else runs inside it, and a
   * connection carries one statement at a time — so the turn is held for the
   * whole of the work rather than taken again for each part of it.
   */
  lock<T>(work: (held: Held) => Promise<T>): Promise<T> {
    return this.queued(() =>
      work({
        query: (sql, params) => this.statement(sql, params ?? []),
        exec: (sql) => this.simple(sql),
      }),
    );
  }

  private statement(sql: string, params: readonly unknown[]): Promise<WireResult> {
    return (async () => {
      const bind = new Packet().text("").text("").int16(0).int16(params.length);
      for (const value of params) {
        const encoded = encode(value);
        if (encoded === null) bind.int32(-1);
        else bind.int32(encoded.length).raw(encoded);
      }
      bind.int16(0);

      this.send(
        Buffer.concat([
          new Packet().text("").text(sql).int16(0).sealed("P"),
          bind.sealed("B"),
          // A describe names what it is describing with a bare byte, not a string.
          new Packet().raw(Buffer.from("P", "latin1")).text("").sealed("D"),
          new Packet().text("").int32(0).sealed("E"),
          new Packet().sealed("S"),
        ]),
      );
      return this.collect();
    })();
  }

  private simple(sql: string): Promise<WireResult> {
    this.send(new Packet().text(sql).sealed("Q"));
    return this.collect();
  }

  private async collect(): Promise<WireResult> {
    let fields: Field[] = [];
    const rows: unknown[][] = [];
    let changed: number | undefined;
    let failure: Error | undefined;

    for (;;) {
      const frame = await this.next();
      if (frame.type === "Z") break;

      if (frame.type === "T") {
        const cursor = new Cursor(frame.body);
        const count = cursor.int16();
        fields = Array.from({ length: count }, () => {
          const name = cursor.text();
          cursor.int32();
          cursor.int16();
          const oid = cursor.int32();
          cursor.int16();
          cursor.int32();
          cursor.int16();
          return { name, oid };
        });
      } else if (frame.type === "D") {
        const cursor = new Cursor(frame.body);
        const count = cursor.int16();
        rows.push(
          Array.from({ length: count }, (_, index) => {
            const length = cursor.int32();
            return length < 0 ? null : decode(cursor.bytes(length), fields[index]?.oid ?? 0);
          }),
        );
      } else if (frame.type === "C") {
        const tag = new Cursor(frame.body).text();
        const last = Number(tag.slice(tag.lastIndexOf(" ") + 1));
        if (Number.isFinite(last) && !tag.startsWith("SELECT")) changed = last;
      } else if (frame.type === "E") {
        // Read on to the ready signal so the connection is usable afterwards.
        failure ??= errorFrom(frame.body);
      }
    }

    if (failure) throw failure;
    return { columns: fields.map((field) => field.name), rows, changed };
  }

  async close(): Promise<void> {
    if (!this.socket || this.broken) return;
    try {
      this.send(new Packet().sealed("X"));
    } catch {
      // Already gone; there is nothing to say goodbye to.
    }
    this.socket.end();
    this.broken ??= new Error("this connection was closed");
  }
}

const md5 = (input: string | Buffer): string => createHash("md5").update(input).digest("hex");

function openSocket(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp({ host, port });
    socket.setNoDelay(true);
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error(`${host}:${port} did not answer within ${timeoutMs}ms`));
    });
    socket.once("connect", () => {
      socket.setTimeout(0);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

/** The single byte that says whether the server will encrypt. */
function firstByte(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.once("data", (chunk: Buffer) => resolve(chunk.toString("latin1", 0, 1)));
  });
}

function upgrade(socket: Socket, host: string, verify: boolean, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const secure = connectTls({ socket, servername: host, rejectUnauthorized: verify });
    const timer = setTimeout(() => {
      secure.destroy();
      reject(new Error(`${host} did not finish encrypting within ${timeoutMs}ms`));
    }, timeoutMs);
    secure.once("secureConnect", () => {
      clearTimeout(timer);
      resolve(secure as unknown as Socket);
    });
    secure.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** A connection string, read into the parts a socket needs. */
export function wireOptionsFrom(url: string, timeoutMs = 10_000): WireOptions {
  const parsed = new URL(url);
  const mode = parsed.searchParams.get("sslmode") ?? "prefer";
  if (!["disable", "prefer", "require", "verify-full"].includes(mode)) {
    throw new Error(`"${mode}" is not an sslmode: use disable, prefer, require, or verify-full`);
  }
  return {
    host: decodeURIComponent(parsed.hostname) || "localhost",
    port: Number(parsed.port || 5432),
    user: decodeURIComponent(parsed.username) || "postgres",
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    database: decodeURIComponent(parsed.pathname.replace(/^\//, "")) || "postgres",
    ssl: mode as WireOptions["ssl"],
    timeoutMs,
  };
}
