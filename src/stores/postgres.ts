/**
 * The other backend that ships with the framework.
 *
 * Same table, same four operations, a different dialect underneath — which is
 * the whole point of the split: nothing above this file changes when a store
 * moves from a file to a server. What does change is where the work happens.
 * Text search here is a real index the database maintains, not a scan.
 *
 * Vectors take whichever of two paths the server can actually offer, and the
 * connection says which one it took. Where the `vector` extension is installed
 * and the store declared a width, embeddings live in a real `vector(n)` column,
 * `<=>` does the ordering, and an HNSW index answers it. Where it is not, every
 * stored vector is read and compared here — correct, and wrong for millions of
 * rows. Both are honest; only one of them is fast, and which one is in force is
 * in `capabilities`, because a fallback nobody can see is one that gets
 * discovered as a latency graph six months later.
 *
 * The path is chosen from what the table *is*, not from what this tried to make
 * it. An adopter who already has rows in a `bytea` column keeps the comparison
 * here even after installing the extension, because silently reading a column
 * that no longer holds their vectors would lose rows rather than speed them up.
 *
 * A `timeseries` store on a server with TimescaleDB is partitioned by time,
 * using only the Apache-2.0 half of that extension: `create_hypertable` and
 * nothing else. Compression, continuous aggregates, retention and the job
 * scheduler are the source-available half, and a framework that reached for
 * them would be handing its adopters a licence they did not choose.
 *
 * Text handed to search is treated as words rather than as a query to parse, so
 * an apostrophe returns results instead of a syntax error, and nothing a caller
 * types is ever read as an operator.
 */

import type { StoreKind } from "../define.js";
import type {
  Capabilities,
  Connection,
  ConnectOptions,
  Driver,
  Item,
  Ranked,
  ResultSet,
  Window,
} from "./types.js";
import { Wire, wireOptionsFrom, type Held } from "./wire.js";

const ITEMS = "praecise_items";
const COLUMNS = "id, scope, body, meta, at, writer, redacted";

/** `simple` stems nothing, so a stored word is the word that was stored. */
const DICTIONARY = "simple";

/**
 * A week, in the units the `at` column counts in.
 *
 * A hypertable partitioned on an integer column has no unit to guess from, so
 * the span of one chunk has to be said out loud. A week keeps a busy store's
 * chunks countable and a quiet one's from being a chunk per row.
 */
const CHUNK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * What one table of text, json, a time and an optional vector can honestly be.
 *
 * Not `graph`. There are no edges here, nothing to traverse them with, and
 * pretending otherwise would mean an app declaring a graph and getting a list.
 */
const SERVES: readonly StoreKind[] = ["sql", "vector", "document", "timeseries"];

/**
 * The table, with the two things that are not fixed spelled in.
 *
 * `vector` is `bytea` or `vector(n)` depending on what the server can do, and
 * the key widens to carry `at` when the rows are going to be partitioned by it,
 * because a hypertable will not accept a unique index that does not.
 */
const schemaFor = (vector: string, key: string): string => `
CREATE TABLE IF NOT EXISTS ${ITEMS} (
  id     text NOT NULL,
  scope  text,
  body   text NOT NULL,
  meta   jsonb,
  vector ${vector},
  at     bigint NOT NULL,
  writer text,
  redacted bigint,
  PRIMARY KEY (${key})
);
CREATE INDEX IF NOT EXISTS ${ITEMS}_recent ON ${ITEMS} (scope, at DESC);
CREATE INDEX IF NOT EXISTS ${ITEMS}_text
  ON ${ITEMS} USING gin (to_tsvector('${DICTIONARY}', body));
`;

/** Cosine, and only cosine: it is the reading every other part of this uses. */
const HNSW = `CREATE INDEX IF NOT EXISTS ${ITEMS}_vector
  ON ${ITEMS} USING hnsw (vector vector_cosine_ops)`;

const HYPERTABLE = `SELECT create_hypertable('${ITEMS}', 'at',
  chunk_time_interval => ${CHUNK_MS}, if_not_exists => TRUE)`;

const CAPABILITIES: Capabilities = {
  // The protocol counts parameters in a signed 16-bit field, and this is what
  // that leaves once the count itself is accounted for.
  maxBindValues: 65_535,
  fullText: true,
  vectors: true,
  returning: true,
  serves: SERVES,
};

/** Bind a value and answer with the placeholder that now refers to it. */
const bind = (params: unknown[], value: unknown): string => `$${params.push(value)}`;

function narrow(window: Window, params: unknown[], prefix = ""): string[] {
  const clauses: string[] = [];
  if (window.id !== undefined) clauses.push(`${prefix}id = ${bind(params, window.id)}`);
  if (window.scope !== undefined) clauses.push(`${prefix}scope = ${bind(params, window.scope)}`);
  if (window.since !== undefined) clauses.push(`${prefix}at >= ${bind(params, window.since)}`);
  if (window.by !== undefined) clauses.push(`${prefix}writer = ${bind(params, window.by)}`);
  return clauses;
}

const where = (clauses: string[]): string => (clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "");

/** A limit at or below zero means the whole window, which this dialect spells out. */
const limitOf = (limit: number, params: unknown[]): string =>
  limit > 0 ? `LIMIT ${bind(params, limit)}` : "LIMIT ALL";

/** Words to look for, never a query to parse. */
function terms(text: string): string {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.join(" | ");
}

function toItem(row: unknown[]): Item {
  const [id, scope, body, meta, at, writer, redacted] = row;
  const item: Item = { id: String(id), text: String(body), at: Number(at) };
  if (scope !== null && scope !== undefined) item.scope = String(scope);
  if (meta && typeof meta === "object") item.meta = meta as Record<string, unknown>;
  if (writer !== null && writer !== undefined) item.by = String(writer);
  if (redacted !== null && redacted !== undefined) item.redactedAt = Number(redacted);
  return item;
}

function toVector(blob: unknown): Float32Array | undefined {
  if (!(blob instanceof Uint8Array)) return undefined;
  return new Float32Array(blob.buffer, blob.byteOffset, Math.floor(blob.byteLength / 4));
}

const toBlob = (vector: number[] | undefined): Uint8Array | undefined =>
  vector ? new Uint8Array(Float32Array.from(vector).buffer) : undefined;

/**
 * A vector as the extension reads one.
 *
 * Its text form is `[1,2,3]`, and text is the representation every type in this
 * protocol already agrees on — so the value travels as a bound parameter with
 * no new encoding, no new type oid, and nothing spliced into a statement. The
 * transport was free; only the SQL had to be written.
 */
const literal = (vector: readonly number[] | undefined): string | undefined =>
  vector?.length ? `[${vector.join(",")}]` : undefined;

/** Whether a vector points anywhere. One that does not has no nearest anything. */
const points = (vector: readonly number[]): boolean => vector.some((one) => one !== 0);

/**
 * Why the fast path is not in force, said as the thing to do about it.
 *
 * There are three reasons and they want three different answers, so one line
 * saying "using the fallback" would be the least useful true sentence available.
 */
function vectorless(width: number, has: { vector: boolean; offered: boolean }, holds: string): string {
  if (!has.vector) {
    const missing = has.offered
      ? `the "vector" extension is not installed`
      : `this server has no "vector" extension to install — add the pgvector package first`;
    return `vectors are read and compared here (${missing}; \`CREATE EXTENSION vector\` — one ` +
      `statement, no restart — moves the ordering into the database)`;
  }
  if (width <= 0) {
    return `vectors are read and compared here (the "vector" extension is installed, but a ` +
      `vector column needs a width — declare \`dimensions\` on the store)`;
  }
  return `vectors are read and compared here (the "vector" extension is installed, but this ` +
    `table already holds them as ${holds || "another type"} — a new table, or a migration of ` +
    `that column, would take the index)`;
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

/**
 * What this driver needs of whatever it is speaking to.
 *
 * `Wire` is one of these and is the only one in production. It is named
 * separately because the interesting half of this file is the SQL it decides to
 * write, and a statement can be read without a server to send it to.
 */
export interface Server extends Held {
  lock<T>(work: (held: Held) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

class PostgresConnection implements Connection {
  private ability: Capabilities = CAPABILITIES;
  /** Set while a transaction holds the connection, so its work stays inside it. */
  private held?: Held;

  /** What the `vector` column is being made as — not what it turned out to be. */
  private column = "bytea";
  /** What the primary key is being made as, for the same reason. */
  private key = "id";
  /** Vectors are ordered by the database rather than read and compared here. */
  private indexed = false;
  /** The key carries `at`, so an id is no longer a row on its own. */
  private wide = false;

  constructor(
    private readonly server: Server,
    private readonly readOnly: boolean,
  ) {}

  get capabilities(): Capabilities {
    return this.ability;
  }

  private get on(): Held {
    return this.held ?? this.server;
  }

  async install(): Promise<void> {
    if (this.readOnly) return;
    await this.on.exec(schemaFor(this.column, this.key));
  }

  /**
   * Find out what this server can do, ask it for the best table it can hold,
   * and then look at what it actually holds.
   *
   * The last step is the one that matters. Everything before it is intent, and
   * `CREATE TABLE IF NOT EXISTS` quietly keeps an older table's shape — so a
   * driver that trusted its own statement would emit `<=>` against a column
   * full of `bytea` and lose every row an adopter had.
   */
  async settle(options: ConnectOptions): Promise<void> {
    const notes: string[] = [];
    const width = options.dimensions ?? 0;
    const has = await this.extensions();

    // Only where the author declared a vector store, and only when the server
    // already offers the extension. One statement, no restart — but installing
    // something database-wide off the back of a store declaration is far enough
    // as it is, and doing it uninvited would be further.
    if (width > 0 && !has.vector && has.offered && !this.readOnly) {
      has.vector = await this.on
        .exec("CREATE EXTENSION IF NOT EXISTS vector")
        .then(() => true)
        .catch((error: unknown) => {
          notes.push(
            `the "vector" extension is available here but could not be created ` +
              `(${(error as Error).message}) — run \`CREATE EXTENSION vector\` as a user allowed to`,
          );
          return false;
        });
    }

    this.column = width > 0 && has.vector ? `vector(${width})` : "bytea";
    this.key = options.of === "timeseries" && has.timescale ? "id, at" : "id";
    await this.install();

    const holds = await this.columnType();
    this.indexed = holds.startsWith("vector(");
    this.wide = (await this.keyColumns()).includes("at");

    if (this.indexed) {
      notes.push(`vectors are ordered by the database (a ${holds} column)`);
      if (!this.readOnly) {
        await this.on.exec(HNSW).catch((error: unknown) => {
          notes.push(`without an HNSW index (${(error as Error).message}), so every row is read`);
        });
      }
    } else {
      notes.push(vectorless(width, has, holds));
    }

    if (options.of === "timeseries") notes.push(await this.partition(has.timescale));

    this.ability = {
      ...CAPABILITIES,
      vectorSearch: this.indexed ? "index" : "scan",
      detail: notes.join("; "),
    };
  }

  /** What is installed, and what could be, in one round trip. */
  private async extensions(): Promise<{ vector: boolean; timescale: boolean; offered: boolean }> {
    const counted = await this.on
      .query(
        `SELECT (SELECT count(*) FROM pg_extension WHERE extname = 'vector') AS vector,
                (SELECT count(*) FROM pg_extension WHERE extname = 'timescaledb') AS timescale,
                (SELECT count(*) FROM pg_available_extensions WHERE name = 'vector') AS offered`,
      )
      // A server that will not show its catalogues is a server with nothing
      // extra, as far as anything here can tell.
      .catch(() => ({ rows: [] as unknown[][] }));
    const [row] = counted.rows;
    return {
      vector: Number(row?.[0] ?? 0) > 0,
      timescale: Number(row?.[1] ?? 0) > 0,
      offered: Number(row?.[2] ?? 0) > 0,
    };
  }

  /** What the `vector` column really is: `bytea`, `vector(4)`, or nothing yet. */
  private async columnType(): Promise<string> {
    const found = await this.on
      .query(
        `SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a
         WHERE a.attrelid = to_regclass($1) AND a.attname = 'vector' AND NOT a.attisdropped`,
        [ITEMS],
      )
      .catch(() => ({ rows: [] as unknown[][] }));
    return String(found.rows[0]?.[0] ?? "");
  }

  /** Which columns the primary key is over, which decides how a write replaces. */
  private async keyColumns(): Promise<string[]> {
    const found = await this.on
      .query(
        `SELECT a.attname FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
         WHERE i.indrelid = to_regclass($1) AND i.indisprimary`,
        [ITEMS],
      )
      .catch(() => ({ rows: [] as unknown[][] }));
    return found.rows.map((row) => String(row[0]));
  }

  /**
   * Partition by time, where the server can and the store said it should.
   *
   * Nothing is migrated: converting a table that already has rows takes a lock
   * for as long as the copy takes, and taking one during a connect is not a
   * decision a framework gets to make on an operator's behalf. An existing
   * table says so instead, and says what to do about it.
   */
  private async partition(timescale: boolean): Promise<string> {
    if (!timescale) {
      return `time is a plain indexed column (install timescaledb — it needs ` +
        `\`shared_preload_libraries = 'timescaledb'\` and a restart — to partition by it)`;
    }
    if (this.readOnly) return "time is not partitioned from a read-only connection";
    if (!this.wide) {
      return `time is a plain indexed column: this table's primary key is over ${ITEMS}.id ` +
        `alone, and a hypertable cannot have a unique index that leaves out the column it ` +
        `partitions on — a new table, or a migration to a key over (id, at), would take it`;
    }
    return this.on
      .query(HYPERTABLE)
      .then(() => "time is partitioned into weekly chunks (timescaledb)")
      .catch((error: unknown) => `time is a plain indexed column (${(error as Error).message})`);
  }

  async put(items: Item[], vectors: (number[] | undefined)[]): Promise<void> {
    if (!items.length) return;
    if (!this.wide) return this.write(items, vectors, "id");

    // A key that carries time cannot say "this id is here once", so the id is
    // cleared first and written again as one piece of work. Without it a row
    // whose time moved would sit alongside the row it was meant to replace.
    await this.transaction(async () => {
      const params: unknown[] = [];
      const ids = items.map((item) => bind(params, item.id)).join(", ");
      await this.on.query(`DELETE FROM ${ITEMS} WHERE id IN (${ids})`, params);
      await this.write(items, vectors, "id, at");
    });
  }

  private async write(
    items: Item[],
    vectors: (number[] | undefined)[],
    conflict: string,
  ): Promise<void> {
    const params: unknown[] = [];
    const values = items.map(
      (item, index) =>
        `(${bind(params, item.id)}, ${bind(params, item.scope ?? null)}, ` +
        `${bind(params, item.text)}, ${bind(params, item.meta ? JSON.stringify(item.meta) : null)}, ` +
        `${bind(params, this.carry(vectors[index]))}, ${bind(params, item.at)}, ` +
        `${bind(params, item.by ?? null)})`,
    );
    await this.on.query(
      `INSERT INTO ${ITEMS} (id, scope, body, meta, vector, at, writer) VALUES ${values.join(", ")}
       ON CONFLICT (${conflict}) DO UPDATE SET
         scope = EXCLUDED.scope, body = EXCLUDED.body, meta = EXCLUDED.meta,
         vector = EXCLUDED.vector, at = EXCLUDED.at, writer = EXCLUDED.writer`,
      params,
    );
  }

  /** However this column takes a vector: four bytes a number, or its text form. */
  private carry(vector: number[] | undefined): string | Uint8Array | null {
    if (!vector) return null;
    return (this.indexed ? literal(vector) : toBlob(vector)) ?? null;
  }

  async list(window: Window): Promise<Item[]> {
    const params: unknown[] = [];
    const clauses = narrow(window, params);
    const result = await this.on.query(
      `SELECT ${COLUMNS} FROM ${ITEMS}${where(clauses)} ORDER BY at DESC ${limitOf(window.limit, params)}`,
      params,
    );
    return result.rows.map(toItem);
  }

  async match(text: string, window: Window): Promise<Ranked[]> {
    const query = terms(text);
    if (!query) return [];
    const params: unknown[] = [];
    const asked = bind(params, query);
    const clauses = narrow(window, params, "i.");
    const result = await this.on.query(
      `SELECT i.id, i.scope, i.body, i.meta, i.at, i.writer, i.redacted,
              ts_rank_cd(to_tsvector('${DICTIONARY}', i.body), q) AS rank
       FROM ${ITEMS} i, to_tsquery('${DICTIONARY}', ${asked}) q
       ${where([`to_tsvector('${DICTIONARY}', i.body) @@ q`, ...clauses])}
       ORDER BY rank DESC ${limitOf(window.limit, params)}`,
      params,
    );
    return result.rows.map((row) => ({ ...toItem(row), rank: Number(row[7]) }));
  }

  async near(vector: number[], window: Window): Promise<Ranked[]> {
    if (this.indexed) return this.nearest(vector, window);

    const params: unknown[] = [];
    const clauses = narrow(window, params);
    const result = await this.on.query(
      `SELECT ${COLUMNS}, vector FROM ${ITEMS}${where([...clauses, "vector IS NOT NULL"])}`,
      params,
    );
    const ranked: Ranked[] = [];
    for (const row of result.rows) {
      const stored = toVector(row[7]);
      if (!stored?.length) continue;
      ranked.push({ ...toItem(row), rank: cosine(vector, stored) });
    }
    ranked.sort((a, b) => b.rank - a.rank);
    return window.limit > 0 ? ranked.slice(0, window.limit) : ranked;
  }

  /**
   * The same question, asked of the database.
   *
   * `<=>` is cosine distance, from 0 to 2. The rank is `1 - d/2`, which is the
   * same number the comparison here produces for the same pair of vectors — so
   * a store that moves onto the index does not also move its scores, and a
   * threshold an app tuned against one path still means what it meant.
   *
   * An HNSW index is approximate, and a narrowed window makes it more so: the
   * planner may search the index and then drop what falls outside the scope,
   * which can answer with fewer rows than were asked for rather than with the
   * wrong ones. That is the trade the index is, and it is why the scan stays
   * where it is rather than being deleted.
   */
  private async nearest(vector: number[], window: Window): Promise<Ranked[]> {
    const asked = literal(vector);
    if (!asked || !points(vector)) return [];

    const params: unknown[] = [];
    const at = bind(params, asked);
    const clauses = narrow(window, params);
    const result = await this.on.query(
      `SELECT ${COLUMNS}, 1 - (vector <=> ${at}) / 2 AS rank
       FROM ${ITEMS}${where([...clauses, "vector IS NOT NULL"])}
       ORDER BY vector <=> ${at} ${limitOf(window.limit, params)}`,
      params,
    );
    return result.rows.map((row) => ({ ...toItem(row), rank: Number(row[7]) }));
  }

  async drop(window: Window): Promise<number> {
    const params: unknown[] = [];
    const clauses = narrow(window, params);
    const result = await this.on.query(
      `DELETE FROM ${ITEMS} WHERE id IN
         (SELECT id FROM ${ITEMS}${where(clauses)} ORDER BY at DESC ${limitOf(window.limit, params)})`,
      params,
    );
    return result.changed ?? 0;
  }

  async redact(window: Window, note: string, at: number): Promise<number> {
    const params: unknown[] = [];
    const left = bind(params, note);
    const when = bind(params, at);
    const clauses = narrow(window, params);
    // The vector goes with the text. A row that could still be found by what it
    // used to say has not been taken back, whatever its text now reads.
    const result = await this.on.query(
      `UPDATE ${ITEMS} SET body = ${left}, meta = NULL, vector = NULL, redacted = ${when} WHERE id IN
         (SELECT id FROM ${ITEMS}${where(clauses)} ORDER BY at DESC ${limitOf(window.limit, params)})`,
      params,
    );
    return result.changed ?? 0;
  }

  async run(sql: string, params: readonly unknown[] = []): Promise<ResultSet> {
    const result = await this.on.query(sql, params);
    return { columns: result.columns, rows: result.rows, changed: result.changed };
  }

  async transaction<T>(work: () => Promise<T>): Promise<T> {
    // Already inside one: a savepoint, so a caller that wraps its own work does
    // not silently commit the work that wrapped it.
    if (this.held) return this.savepoint(this.held, work);

    return this.server.lock(async (held) => {
      this.held = held;
      try {
        await held.exec("BEGIN");
        const answer = await work();
        await held.exec("COMMIT");
        return answer;
      } catch (error) {
        await held.exec("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        this.held = undefined;
      }
    });
  }

  private async savepoint<T>(held: Held, work: () => Promise<T>): Promise<T> {
    await held.exec("SAVEPOINT praecise_nested");
    try {
      const answer = await work();
      await held.exec("RELEASE SAVEPOINT praecise_nested");
      return answer;
    } catch (error) {
      await held.exec("ROLLBACK TO SAVEPOINT praecise_nested").catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.server.close();
  }
}

/**
 * Everything the driver does once something is connected.
 *
 * Separated from opening a socket so that what this file decides — which
 * statements it writes, and why — can be read against a server that only
 * answers, without one having to be running.
 */
export async function openOn(server: Server, options: ConnectOptions): Promise<Connection> {
  const connection = new PostgresConnection(server, options.readOnly ?? false);
  if (options.readOnly) await server.exec("SET default_transaction_read_only = on");
  await connection.settle(options);
  return connection;
}

export const postgresDriver: Driver = {
  name: "postgres",
  async connect(options: ConnectOptions): Promise<Connection> {
    const wire = await Wire.open(wireOptionsFrom(options.url));
    try {
      return await openOn(wire, options);
    } catch (error) {
      // A connection nobody was handed back is a socket nobody can close.
      await wire.close().catch(() => undefined);
      throw error;
    }
  },
};
