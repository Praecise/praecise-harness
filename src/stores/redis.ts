/**
 * A store on Redis or Valkey.
 *
 * The same rows as every other backend, kept the way a key-value server keeps things:
 * each row is a hash under its id, and beside the rows are sorted sets that order ids
 * by time — one for everything, one per scope — which is what answers "the newest in
 * this scope" without reading anything else. That much is plain keys, and it is all
 * that is assumed: it runs on any Redis from 6.2 and on any Valkey.
 *
 * What a server has beyond that is asked when the connection opens (`HELLO`, then
 * `COMMAND INFO` for the commands themselves, which is true whether they came built
 * in or from a module) and used where it is found:
 *
 *   vector sets (Redis 8)  — a row's vector also goes into a vector set, and nearest
 *                            rows are found by `VSIM` instead of read and compared here
 *   time series            — a reading also goes into a time series, and a bucketed
 *                            range is answered by `TS.RANGE`
 *   JSON                   — what is kept beside a row's text is a JSON document the
 *                            server can address by path, rather than a string in a hash
 *
 * Each of these is kept *beside* the rows, never instead of them, so the plain path is
 * always there and always right. Where one is missing the connection says so, and what
 * it does instead, in `capabilities.detail`.
 *
 * Three things this backend does not do, said here rather than discovered:
 *
 * There is no text index, so `search` reads a scope and compares — the path the
 * in-memory backend takes. (The query engine could index it; that is not built.)
 *
 * A transaction is `MULTI`/`EXEC`: writes made inside one are held and sent together,
 * so they all happen or none do, and nobody sees half. But the server cannot roll
 * back, so a read inside a transaction does not see that transaction's own writes.
 *
 * `query` takes a command, not SQL: `store.query("ZCARD", ["praecise:ids"])`.
 */

import { SERIES } from "./models.js";
import { pairsOf, Resp, RespError, respOptionsFrom, type Arg, type Reply } from "./resp.js";
import type {
  Bucket,
  Buckets,
  Capabilities,
  Connection,
  ConnectOptions,
  Driver,
  Faster,
  Item,
  Ranked,
  ResultSet,
  Window,
} from "./types.js";

/** What every key this driver makes begins with, unless the url says otherwise (`?prefix=`). */
const PREFIX = "praecise";

/** A row as it is held, with what is needed to take it out of everything it is in. */
interface Row {
  item: Item;
  /** The vector, as it is stored: little-endian 32-bit floats, base64. */
  vector?: string;
  /** Its `meta` is a JSON document beside it rather than a field of it. */
  json: boolean;
}

/** Writes waiting on a transaction: the ones that must happen together, and the mirrors. */
interface Pending {
  hard: Arg[][];
  soft: Arg[][];
}

const AGGREGATORS: Record<Buckets["aggregate"], string> = {
  mean: "avg",
  min: "min",
  max: "max",
  sum: "sum",
  count: "count",
  first: "first",
  last: "last",
};

const toBase64 = (vector: readonly number[]): string =>
  Buffer.from(Float32Array.from(vector).buffer).toString("base64");

function fromBase64(stored: string): Float32Array {
  const bytes = Buffer.from(stored, "base64");
  // Copied, so the floats start on a boundary whatever the buffer pool handed back.
  return new Float32Array(Uint8Array.from(bytes).buffer, 0, Math.floor(bytes.byteLength / 4));
}

/** Cosine similarity, mapped from -1..1 onto 0..1 so every rank reads the same way. */
function cosine(a: readonly number[], b: Float32Array): number {
  const width = Math.min(a.length, b.length);
  let dot = 0;
  let left = 0;
  let right = 0;
  for (let i = 0; i < width; i++) {
    dot += a[i]! * b[i]!;
    left += a[i]! * a[i]!;
    right += b[i]! * b[i]!;
  }
  if (!left || !right) return 0;
  return (dot / Math.sqrt(left * right) + 1) / 2;
}

/** Whether a vector points anywhere. One that does not has no nearest anything. */
const points = (vector: readonly number[]): boolean => vector.some((one) => one !== 0);

/** Whether the caller asked about a subset a vector set cannot be asked about. */
const narrowed = (window: Window): boolean =>
  window.id !== undefined || window.since !== undefined || window.by !== undefined;

/** A reply as rows, for the author's own command. */
function shaped(reply: Reply): ResultSet {
  if (reply === null) return { columns: ["value"], rows: [] };
  if (reply instanceof Map || (Array.isArray(reply) && reply.length === 0)) {
    return { columns: ["key", "value"], rows: pairsOf(reply).map(([key, value]) => [key, value]) };
  }
  if (Array.isArray(reply)) return { columns: ["value"], rows: reply.map((one) => [one]) };
  return { columns: ["value"], rows: [[reply]] };
}

class RedisConnection implements Connection {
  private ability: Capabilities;
  private pending?: Pending;
  /** Nearest rows are asked of a vector set rather than read and compared here. */
  private indexed = false;
  /** Readings are mirrored into a time series. */
  private mirrored = false;
  /** `meta` is kept as a JSON document. */
  private documents = false;
  /** How wide the vectors in the vector sets are, once that is known. */
  private width?: number;

  private readonly resp: Resp;
  private readonly prefix: string;
  private readonly readOnly: boolean;

  constructor(resp: Resp, prefix: string, readOnly: boolean) {
    this.resp = resp;
    this.prefix = prefix;
    this.readOnly = readOnly;
    this.ability = {
      // There is no statement here and nothing bound. The store divides this by six to
      // decide how many rows travel in one write, so it is two hundred rows a block:
      // enough to make a batch one round trip, and not so many that the server, which
      // runs a block without letting anyone else in, is held for long.
      maxBindValues: 1_200,
      fullText: false,
      vectors: true,
      returning: false,
      // Not `sql`: `query` here takes a command. Not `graph`: there is nothing to walk with.
      serves: ["vector", "document", "timeseries"],
    };
  }

  get capabilities(): Capabilities {
    return this.ability;
  }

  // ── Keys ──

  private get all(): string {
    return `${this.prefix}:ids`;
  }
  private rowKey(id: string): string {
    return `${this.prefix}:item:${id}`;
  }
  private scopeKey(scope: string): string {
    return `${this.prefix}:scope:${scope}`;
  }
  private metaKey(id: string): string {
    return `${this.prefix}:meta:${id}`;
  }
  /** The vector set for a scope, or the one that holds every row's. */
  private vectorKey(scope?: string): string {
    return scope === undefined ? `${this.prefix}:vec` : `${this.prefix}:vec:${scope}`;
  }
  private seriesKey(scope: string): string {
    return `${this.prefix}:ts:${scope}`;
  }

  // ── Opening ──

  async install(): Promise<void> {
    // Nothing to make: a key exists when it is first written.
  }

  /**
   * Ask what this server has, and decide what to use of it.
   *
   * `COMMAND INFO` is asked about the commands themselves, because that is the
   * question: a capability that arrived in the core, in a module, or in a fork that
   * renamed nothing all answer it the same way. What `HELLO` said is kept for the
   * sentence an operator reads.
   */
  async settle(options: ConnectOptions): Promise<void> {
    const wanted = ["VADD", "VSIM", "VREM", "TS.ADD", "TS.RANGE", "TS.DEL", "JSON.SET", "JSON.GET"];
    const [info] = await this.resp.pipeline([["COMMAND", "INFO", ...wanted]]);
    const known = Array.isArray(info) ? info : [];
    const has = (...names: string[]): boolean =>
      names.every((name) => {
        const entry = known[wanted.indexOf(name)];
        return entry !== null && entry !== undefined && !(entry instanceof RespError);
      });

    const notes: string[] = [];
    const server = this.resp.hello.get("server");
    const version = this.resp.hello.get("version");
    notes.push(
      server
        ? `${String(server)} ${String(version ?? "")}`.trim() + `, RESP${this.resp.protocol}`
        : `a server that does not answer HELLO, spoken to in RESP${this.resp.protocol}`,
    );

    this.indexed = has("VADD", "VSIM", "VREM");
    this.width = options.dimensions && options.dimensions > 0 ? options.dimensions : undefined;
    if (this.indexed) {
      const [held] = await this.resp.pipeline([["VDIM", this.vectorKey()]]);
      if (typeof held === "number" && this.width !== undefined && held !== this.width) {
        // An index of another width would refuse every write. The rows still hold
        // their vectors, so they are compared here and the index is left alone.
        this.indexed = false;
        notes.push(
          `vectors are read and compared here (the vector set already holds ${held} dimensions and ` +
            `this store declares ${this.width} — delete ${this.vectorKey()}* to have it rebuilt as rows are written)`,
        );
      } else {
        if (typeof held === "number") this.width = held;
        notes.push("vectors are ordered by the server (vector sets), except where the window narrows by time, writer or id");
      }
    } else {
      notes.push("vectors are read and compared here (this server has no vector sets; they arrive with Redis 8)");
    }

    this.mirrored = has("TS.ADD", "TS.RANGE", "TS.DEL");
    notes.push(
      this.mirrored
        ? "a bucketed series is answered by the server (time series), checked against the rows by count"
        : "a series is read and bucketed here (this server has no time series commands)",
    );

    this.documents = has("JSON.SET", "JSON.GET");
    notes.push(
      this.documents
        ? "what is kept beside a row is a JSON document the server can address by path"
        : "what is kept beside a row is a JSON string in its hash (this server has no JSON commands)",
    );
    notes.push("text is searched by reading the scope: there is no text index here");

    const faster: Faster[] = this.mirrored ? ["buckets"] : [];
    this.ability = {
      ...this.ability,
      vectorSearch: this.indexed ? "index" : "scan",
      faster,
      detail: notes.join("; "),
    };
  }

  // ── Reading ──

  private refuseWrites(): void {
    if (this.readOnly) throw new Error("this store is open read-only");
  }

  /** The rows under these ids, in the order asked, leaving out any that are not there. */
  private async rows(ids: readonly string[]): Promise<Row[]> {
    if (!ids.length) return [];
    const replies = await this.resp.pipeline(ids.map((id) => ["HGETALL", this.rowKey(id)]));
    const rows: Row[] = [];
    replies.forEach((reply, index) => {
      if (reply instanceof RespError) throw reply;
      const fields = new Map(pairsOf(reply).map(([key, value]) => [String(key), String(value)]));
      if (!fields.has("body")) return;
      const item: Item = { id: ids[index]!, text: fields.get("body")!, at: Number(fields.get("at") ?? 0) };
      const scope = fields.get("scope");
      const writer = fields.get("writer");
      const redacted = fields.get("redacted");
      const meta = fields.get("meta");
      if (scope !== undefined) item.scope = scope;
      if (writer !== undefined) item.by = writer;
      if (redacted !== undefined) item.redactedAt = Number(redacted);
      if (meta !== undefined) item.meta = parsed(meta);
      rows.push({ item, vector: fields.get("vector"), json: fields.get("mj") === "1" });
    });

    // The ones whose record is a document of its own are read in a second trip.
    const apart = rows.filter((row) => row.json);
    if (apart.length) {
      const documents = await this.resp.pipeline(apart.map((row) => ["JSON.GET", this.metaKey(row.item.id)]));
      apart.forEach((row, index) => {
        const document = documents[index];
        if (typeof document === "string") row.item.meta = parsed(document);
      });
    }
    return rows;
  }

  /** The rows in a window, newest first. */
  private async rowsIn(window: Window): Promise<Row[]> {
    const fits = (row: Row): boolean =>
      (window.scope === undefined || row.item.scope === window.scope) &&
      (window.since === undefined || row.item.at >= window.since) &&
      (window.by === undefined || row.item.by === window.by);

    if (window.id !== undefined) return (await this.rows([window.id])).filter(fits);

    const key = window.scope === undefined ? this.all : this.scopeKey(window.scope);
    const range: Arg[] = ["ZRANGE", key, "+inf", window.since ?? "-inf", "BYSCORE", "REV"];
    const ids = async (offset: number, count: number): Promise<string[]> => {
      const reply = await this.resp.command(...range, ...(count > 0 ? ["LIMIT", offset, count] : []));
      return Array.isArray(reply) ? reply.map(String) : [];
    };

    // The sorted set narrows by scope and by time. Who wrote a row is on the row, so
    // a window that asks is read a page at a time until it has what it was asked for.
    if (window.by === undefined) return (await this.rows(await ids(0, window.limit))).filter(fits);
    const found: Row[] = [];
    const page = window.limit > 0 ? Math.max(100, window.limit * 2) : 0;
    for (let offset = 0; ; offset += page) {
      const batch = await ids(offset, page);
      for (const row of await this.rows(batch)) {
        if (fits(row)) found.push(row);
        if (window.limit > 0 && found.length >= window.limit) return found;
      }
      if (!page || batch.length < page) return found;
    }
  }

  async list(window: Window): Promise<Item[]> {
    return (await this.rowsIn(window)).map((row) => row.item);
  }

  /**
   * There is no index here, which is why `fullText` is false and the store above
   * never calls this. It answers anyway, with the honest scan.
   */
  async match(terms: string, window: Window): Promise<Ranked[]> {
    const wanted = (terms.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => word.length > 2);
    if (!wanted.length) return [];
    const ranked: Ranked[] = [];
    for (const { item } of await this.rowsIn({ ...window, limit: -1 })) {
      const text = item.text.toLowerCase();
      const hits = wanted.filter((word) => text.includes(word)).length;
      if (hits) ranked.push({ ...item, rank: hits / wanted.length });
    }
    ranked.sort((a, b) => b.rank - a.rank);
    return window.limit > 0 ? ranked.slice(0, window.limit) : ranked;
  }

  async near(vector: number[], window: Window): Promise<Ranked[]> {
    if (!points(vector)) return [];
    if (this.indexed && window.limit > 0 && !narrowed(window)) return this.nearest(vector, window);

    const ranked: Ranked[] = [];
    for (const row of await this.rowsIn({ ...window, limit: -1 })) {
      if (!row.vector) continue;
      ranked.push({ ...row.item, rank: cosine(vector, fromBase64(row.vector)) });
    }
    ranked.sort((a, b) => b.rank - a.rank);
    return window.limit > 0 ? ranked.slice(0, window.limit) : ranked;
  }

  /**
   * The same question, asked of the server.
   *
   * `VSIM` scores from 1 for identical to 0 for opposite, which is the reading the
   * comparison here produces, so a store that moves onto the index does not also move
   * its scores. A scope has a vector set of its own, so a narrowed question is asked of
   * exactly the rows it is about rather than asked of everything and filtered after.
   */
  private async nearest(vector: number[], window: Window): Promise<Ranked[]> {
    const reply = await this.resp.command(
      "VSIM",
      this.vectorKey(window.scope),
      "VALUES",
      vector.length,
      ...vector,
      "WITHSCORES",
      "COUNT",
      window.limit,
    );
    const scored = new Map(pairsOf(reply).map(([id, score]) => [String(id), Number(score)]));
    const rows = await this.rows([...scored.keys()]);
    return rows
      .filter((row) => row.vector !== undefined)
      .map((row) => ({ ...row.item, rank: scored.get(row.item.id) ?? 0 }))
      .sort((a, b) => b.rank - a.rank);
  }

  /**
   * A bucketed range, answered by the time series beside the rows — when it can be
   * vouched for.
   *
   * The series is a mirror, and a mirror can be behind: a row written by a connection
   * to a server that had no time series, a reading before 1970 that a series cannot
   * hold. So the number of samples the series aggregated is checked against the number
   * of rows the scope holds over the same span, and when they differ this declines and
   * the rows are read instead. The check is one more command in the same round trip.
   */
  async buckets(buckets: Buckets): Promise<Bucket[] | undefined> {
    if (!this.mirrored) return undefined;
    const from = buckets.from === undefined ? "-" : Math.max(0, Math.ceil(buckets.from));
    const to = buckets.to === undefined ? "+" : Math.ceil(buckets.to) - 1;
    if (typeof to === "number" && to < 0) return undefined;
    const key = this.seriesKey(buckets.scope);
    const range = (how: string): Arg[] => ["TS.RANGE", key, from, to, "AGGREGATION", how, buckets.width];

    const [held, counted, answered] = await this.resp.pipeline([
      ["ZCOUNT", this.scopeKey(buckets.scope), buckets.from ?? "-inf", buckets.to === undefined ? "+inf" : `(${buckets.to}`],
      range("count"),
      range(AGGREGATORS[buckets.aggregate]),
    ]);
    if (!Array.isArray(counted) || !Array.isArray(answered) || typeof held !== "number") return undefined;

    const pairs = (reply: Reply[]): Bucket[] =>
      reply.flatMap((pair): Bucket[] => (Array.isArray(pair) ? [{ at: Number(pair[0]), value: Number(pair[1]) }] : []));
    const samples = pairs(counted).reduce((total, bucket) => total + bucket.value, 0);
    if (samples !== held) return undefined;
    return pairs(answered);
  }

  // ── Writing ──

  /** Whether a row is a reading a time series can hold. */
  private reading(item: Item): number | undefined {
    const value = item.meta?.value;
    return this.mirrored &&
      item.scope?.startsWith(SERIES) &&
      !item.redactedAt &&
      typeof value === "number" &&
      Number.isFinite(value) &&
      Number.isSafeInteger(item.at) &&
      item.at >= 0
      ? value
      : undefined;
  }

  /** Everything that takes a row out of everything it is in. */
  private unkeep(row: Row, into: Pending): void {
    const { id, scope } = row.item;
    into.hard.push(["DEL", this.rowKey(id)], ["ZREM", this.all, id]);
    if (scope !== undefined) into.hard.push(["ZREM", this.scopeKey(scope), id]);
    if (row.json) into.hard.push(["DEL", this.metaKey(id)]);
    this.unindex(row, into);
  }

  /** Take a row out of what is kept beside the rows: the vector sets and the series. */
  private unindex(row: Row, into: Pending): void {
    const { id, scope } = row.item;
    if (this.indexed && row.vector !== undefined) {
      into.hard.push(["VREM", this.vectorKey(), id]);
      if (scope !== undefined) into.hard.push(["VREM", this.vectorKey(scope), id]);
    }
    if (scope !== undefined && this.reading(row.item) !== undefined) {
      into.soft.push(["TS.DEL", this.seriesKey(scope), row.item.at, row.item.at]);
    }
  }

  async put(items: Item[], vectors: (number[] | undefined)[]): Promise<void> {
    this.refuseWrites();
    if (!items.length) return;

    // A vector set holds one width. Checked before anything is written, because the
    // server cannot undo the rows that went in ahead of the one it refused.
    if (this.indexed) {
      for (const vector of vectors) {
        if (!vector?.length) continue;
        this.width ??= vector.length;
        if (vector.length !== this.width) {
          throw new Error(
            `this store's vectors are ${this.width} wide and one of these is ${vector.length} — ` +
              `a store holds vectors of one width`,
          );
        }
      }
    }

    const before = new Map((await this.rows(items.map((item) => item.id))).map((row) => [row.item.id, row]));
    const writes: Pending = { hard: [], soft: [] };

    items.forEach((item, index) => {
      // Replacing is taking out and putting in, as one piece of work: a row whose
      // scope or time moved must not be left behind where it used to be.
      const old = before.get(item.id);
      if (old) this.unkeep(old, writes);

      const vector = vectors[index]?.length ? vectors[index] : undefined;
      const fields: Arg[] = ["body", item.text, "at", item.at];
      if (item.scope !== undefined) fields.push("scope", item.scope);
      if (item.by !== undefined) fields.push("writer", item.by);
      if (vector) fields.push("vector", toBase64(vector));
      if (item.meta && this.documents) {
        fields.push("mj", "1");
        writes.hard.push(["JSON.SET", this.metaKey(item.id), "$", JSON.stringify(item.meta)]);
      } else if (item.meta) {
        fields.push("meta", JSON.stringify(item.meta));
      }
      writes.hard.push(["HSET", this.rowKey(item.id), ...fields], ["ZADD", this.all, item.at, item.id]);
      if (item.scope !== undefined) writes.hard.push(["ZADD", this.scopeKey(item.scope), item.at, item.id]);

      if (vector && this.indexed && points(vector)) {
        // Unquantized: the default squeezes each number into eight bits, and a score
        // read off that is near the cosine rather than the cosine.
        const added = (key: string): Arg[] => ["VADD", key, "VALUES", vector.length, ...vector, item.id, "NOQUANT"];
        writes.hard.push(added(this.vectorKey()));
        if (item.scope !== undefined) writes.hard.push(added(this.vectorKey(item.scope)));
      }

      const value = this.reading(item);
      if (value !== undefined && item.scope !== undefined) {
        writes.soft.push(["TS.ADD", this.seriesKey(item.scope), item.at, value, "ON_DUPLICATE", "LAST"]);
      }
    });

    await this.commit(writes);
  }

  async drop(window: Window): Promise<number> {
    this.refuseWrites();
    const rows = await this.rowsIn(window);
    const writes: Pending = { hard: [], soft: [] };
    for (const row of rows) this.unkeep(row, writes);
    await this.commit(writes);
    return rows.length;
  }

  async redact(window: Window, note: string, at: number): Promise<number> {
    this.refuseWrites();
    const rows = await this.rowsIn(window);
    const writes: Pending = { hard: [], soft: [] };
    for (const row of rows) {
      const key = this.rowKey(row.item.id);
      // The vector goes with the text, and so does what was kept beside it. A row that
      // can still be found by what it used to say has not been taken back.
      writes.hard.push(["HSET", key, "body", note, "redacted", at], ["HDEL", key, "meta", "mj", "vector"]);
      if (row.json) writes.hard.push(["DEL", this.metaKey(row.item.id)]);
      this.unindex(row, writes);
    }
    await this.commit(writes);
    return rows.length;
  }

  /** Send these now, or hold them for the transaction that is open. */
  private async commit(writes: Pending): Promise<void> {
    if (this.pending) {
      this.pending.hard.push(...writes.hard);
      this.pending.soft.push(...writes.soft);
      return;
    }
    await this.resp.atomic(writes.hard);
    // The mirrors are sent after and not held to: a series that is behind is found
    // out by `buckets`, which checks before it answers.
    if (writes.soft.length) await this.resp.pipeline(writes.soft);
  }

  async transaction<T>(work: () => Promise<T>): Promise<T> {
    const outer = this.pending === undefined;
    const held: Pending = this.pending ?? { hard: [], soft: [] };
    const mark = { hard: held.hard.length, soft: held.soft.length };
    this.pending = held;
    try {
      const answer = await work();
      if (outer) {
        this.pending = undefined;
        await this.commit(held);
      }
      return answer;
    } catch (error) {
      // Nothing was sent, so undoing is forgetting what was going to be: all of it for
      // the outermost, and back to where this one started for one inside another.
      if (outer) this.pending = undefined;
      else {
        held.hard.length = mark.hard;
        held.soft.length = mark.soft;
      }
      throw error;
    }
  }

  /**
   * The author's own command: its name, and then its arguments.
   *
   * `run("HGETALL", ["some:key"])`, or the whole of it in the first argument where
   * nothing in it has a space. Arguments are sent as arguments, never joined into a
   * line, so there is nothing in one that the server reads as another command.
   */
  async run(command: string, params: readonly unknown[] = []): Promise<ResultSet> {
    const words = command.trim().split(/\s+/).filter(Boolean);
    if (!words.length) throw new Error("a command needs a name: query(\"GET\", [key])");
    if (this.readOnly) {
      const [info] = await this.resp.pipeline([["COMMAND", "INFO", words[0]!]]);
      const flags = Array.isArray(info) && Array.isArray(info[0]) ? info[0][2] : undefined;
      if (!Array.isArray(flags) || flags.map(String).includes("write")) {
        throw new Error(`this store is open read-only, and ${words[0]!.toUpperCase()} is not known to only read`);
      }
    }
    return shaped(await this.resp.command(...words, ...params.map((param) => (typeof param === "number" ? param : String(param)))));
  }

  async close(): Promise<void> {
    await this.resp.close();
  }
}

function parsed(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    // Written by something other than this driver. The row is still an item.
    return undefined;
  }
}

/** Everything the driver does once something is connected. */
export async function openOnResp(resp: Resp, options: ConnectOptions): Promise<Connection> {
  let prefix = PREFIX;
  try {
    prefix = new URL(options.url).searchParams.get("prefix")?.trim() || PREFIX;
  } catch {
    // Not a url this can read a prefix out of; the default stands.
  }
  const connection = new RedisConnection(resp, prefix, options.readOnly ?? false);
  await connection.settle(options);
  return connection;
}

export const redisDriver: Driver = {
  name: "redis",
  async connect(options: ConnectOptions): Promise<Connection> {
    const resp = await Resp.open(respOptionsFrom(options.url));
    try {
      return await openOnResp(resp, options);
    } catch (error) {
      // A connection nobody was handed back is a socket nobody can close.
      await resp.close().catch(() => undefined);
      throw error;
    }
  },
};
