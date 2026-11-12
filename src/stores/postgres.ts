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
import { FACTS } from "./models.js";
import { bucketStatement, factIndexes, walkStatement, wholeStart, type Dialect } from "./paths.js";
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
  Step,
  Walk,
  Window,
} from "./types.js";
import { Wire, wireOptionsFrom, type Held } from "./wire.js";

const ITEMS = "praecise_items";
const VALIDITY = "praecise_fact_validity";

/** The first server version with `uuidv7()` and `WITHOUT OVERLAPS`, as `server_version_num` counts. */
const PG18 = 180_000;

/** The most values one statement binds, which the protocol counts in sixteen bits. */
const MAX_BINDS = 65_535;

/**
 * How this dialect writes the two things the shared statements leave open.
 *
 * `meta` is `jsonb`, read with `->>`. The value at the edge of a group is an ordered
 * `array_agg`, which is standard SQL and needs no extension.
 */
export const POSTGRES_DIALECT: Dialect = {
  bind: (params, value) => `$${params.push(value)}`,
  text: (field) => `(meta->>'${field}')`,
  number: (field) => `(meta->>'${field}')::float8`,
  isNumber: (field) => `jsonb_typeof(meta->'${field}') = 'number'`,
  edge: (which) => `(array_agg(v ORDER BY at ${which === "first" ? "ASC" : "DESC"}))[1]`,
  start: wholeStart,
};

/**
 * The same, on a server with TimescaleDB.
 *
 * `time_bucket` over an integer column aligns to zero, which is the alignment the
 * arithmetic gives, so the windows are the same windows. It is used only where the
 * extension was found, because on a hypertable it is the spelling the planner knows
 * how to answer chunk by chunk — and it is in the Apache-2.0 half of the extension.
 */
const TIMESCALE_DIALECT: Dialect = {
  ...POSTGRES_DIALECT,
  start: (width) => `time_bucket(${width()}::bigint, at)`,
};

/**
 * Where a fact's validity is kept as a range the database can reason about.
 *
 * The facts themselves stay rows like any other. This holds one line per fact — what
 * it says and the period it says it of — under a key that is `WITHOUT OVERLAPS`, so
 * the same statement cannot be recorded as true over two periods that share a moment.
 * That is a rule about the data that no amount of care in a caller can enforce across
 * two connections, which is why it is the database that holds it where the database
 * can. The other key columns are text in a GiST index, which is what `btree_gist` is
 * for.
 */
const VALIDITY_SCHEMA = `
CREATE TABLE IF NOT EXISTS ${VALIDITY} (
  id        text NOT NULL UNIQUE,
  scope     text NOT NULL,
  subject   text NOT NULL,
  predicate text NOT NULL,
  object    text NOT NULL,
  valid     int8range NOT NULL,
  CONSTRAINT ${VALIDITY}_once PRIMARY KEY (scope, subject, predicate, object, valid WITHOUT OVERLAPS)
)`;

/** What the server reports when a `WITHOUT OVERLAPS` key refuses a row. */
const EXCLUSION_VIOLATION = "23P01";

/** A row that is a fact, read as what the validity table holds of it. */
function validityOf(item: Item): unknown[] | undefined {
  const meta = item.meta;
  if (!item.scope?.startsWith(FACTS) || !meta) return undefined;
  const { subject, predicate, object, validFrom, validTo } = meta;
  if (typeof subject !== "string" || typeof predicate !== "string" || typeof object !== "string") return undefined;
  const whole = (value: unknown): number | null => (typeof value === "number" ? Math.floor(value) : null);
  return [item.id, item.scope, subject, predicate, object, whole(validFrom), whole(validTo)];
}
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
  /** The protocol version the connection settled on, where whatever this is knows. */
  readonly protocol?: string;
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
  /** The validity table is there, so a fact's period is written beside the fact. */
  private valid = false;
  /** How a series is bucketed here: by arithmetic, or by `time_bucket` where it was found. */
  private dialect: Dialect = POSTGRES_DIALECT;
  private readonly server: Server;
  private readonly readOnly: boolean;
  constructor(
    server: Server,
    readOnly: boolean,
  ) {
    this.server = server;
    this.readOnly = readOnly;
  }

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

    // What the database answers for itself. A walk and a bucketed series are plain SQL
    // and are always in force; the rest depends on what this server turned out to be.
    const faster: Faster[] = ["walk", "buckets"];
    if (!this.readOnly) {
      for (const index of factIndexes(POSTGRES_DIALECT)) {
        await this.on.exec(index).catch((error: unknown) => {
          notes.push(`facts are walked without an index (${(error as Error).message})`);
        });
      }
    }
    this.dialect = has.timescale ? TIMESCALE_DIALECT : POSTGRES_DIALECT;
    notes.push(
      `relationships are walked and series are bucketed by the database` +
        (has.timescale ? " (time_bucket)" : ""),
    );

    if (has.version >= PG18) {
      this.mint = (count) => this.uuids(count);
      faster.push("ids");
      notes.push("ids are uuidv7(), made by the server");
      const validity = await this.constrain(has.gist);
      if (this.valid) faster.push("validity");
      notes.push(validity);
    } else if (has.version > 0) {
      notes.push(
        `ids are made here and a fact's validity is not constrained (uuidv7() and WITHOUT OVERLAPS ` +
          `arrive with PostgreSQL 18; this is ${Math.floor(has.version / 10_000)})`,
      );
    }
    if (this.server.protocol) notes.push(`protocol ${this.server.protocol}`);

    this.ability = {
      ...CAPABILITIES,
      vectorSearch: this.indexed ? "index" : "scan",
      faster,
      detail: notes.join("; "),
    };
  }

  /** This many ids, made by the server. Assigned in `settle`, and only on a server that has `uuidv7()`. */
  mint?: (count: number) => Promise<string[]>;

  /**
   * Version 7 UUIDs: a millisecond timestamp first, so ids made later sort later and
   * an index over them grows at one end instead of everywhere at once.
   */
  private async uuids(count: number): Promise<string[]> {
    const made = await this.on.query(`SELECT uuidv7()::text FROM generate_series(1, $1::int)`, [count]);
    return made.rows.map((row) => String(row[0]));
  }

  /**
   * Make the table that holds a fact's validity as a range, where this server can.
   *
   * Nothing is installed to make it possible. The key needs `btree_gist`, and creating
   * an extension database-wide because an agent might record a fact is not this
   * framework's call: where it is already there the constraint is used, and where it
   * is not the sentence says the one statement that would change that.
   *
   * Facts recorded before the table existed are not in it. Copying them in could fail
   * on the very overlaps the constraint is there to refuse, during a connect, so the
   * rule holds from here on and says so.
   */
  private async constrain(gist: boolean): Promise<string> {
    if (!gist) {
      return `a fact's validity is not constrained by the database (\`CREATE EXTENSION btree_gist\` — ` +
        `one statement, no restart — lets it refuse the same fact over two periods that overlap)`;
    }
    if (!this.readOnly) {
      const failed = await this.on
        .exec(VALIDITY_SCHEMA)
        .then(() => undefined)
        .catch((error: unknown) => (error as Error).message);
      if (failed) return `a fact's validity is not constrained by the database (${failed})`;
    }
    const found = await this.on
      .query(`SELECT to_regclass($1) IS NOT NULL`, [VALIDITY])
      .catch(() => ({ rows: [] as unknown[][] }));
    this.valid = found.rows[0]?.[0] === true;
    return this.valid
      ? "the same fact cannot be recorded as true over two periods that overlap (WITHOUT OVERLAPS), for facts recorded from here on"
      : "a fact's validity is not constrained by the database (its table is not there)";
  }

  /** What is installed, what could be, and which server this is, in one round trip. */
  private async extensions(): Promise<{
    vector: boolean;
    timescale: boolean;
    offered: boolean;
    gist: boolean;
    version: number;
  }> {
    const counted = await this.on
      .query(
        `SELECT (SELECT count(*) FROM pg_extension WHERE extname = 'vector') AS vector,
                (SELECT count(*) FROM pg_extension WHERE extname = 'timescaledb') AS timescale,
                (SELECT count(*) FROM pg_available_extensions WHERE name = 'vector') AS offered,
                (SELECT count(*) FROM pg_extension WHERE extname = 'btree_gist') AS gist,
                current_setting('server_version_num')::int AS version`,
      )
      // A server that will not show its catalogues is a server with nothing
      // extra, as far as anything here can tell.
      .catch(() => ({ rows: [] as unknown[][] }));
    const [row] = counted.rows;
    return {
      vector: Number(row?.[0] ?? 0) > 0,
      timescale: Number(row?.[1] ?? 0) > 0,
      offered: Number(row?.[2] ?? 0) > 0,
      gist: Number(row?.[3] ?? 0) > 0,
      version: Number(row?.[4] ?? 0) || 0,
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
    if (!this.valid) return this.keep(items, vectors);
    // The period goes in first and in the same piece of work, so a fact the constraint
    // refuses is not a row either.
    await this.transaction(async () => {
      await this.periods(items);
      await this.keep(items, vectors);
    });
  }

  /**
   * Write what the validity table holds of these rows: nothing for a row that is not
   * a fact, and its period for one that is.
   */
  private async periods(items: Item[]): Promise<void> {
    const ids: unknown[] = [];
    const named = items.map((item) => bind(ids, item.id)).join(", ");
    await this.on.query(`DELETE FROM ${VALIDITY} WHERE id IN (${named})`, ids);

    const facts = items.flatMap((item) => {
      const fact = validityOf(item);
      return fact ? [fact] : [];
    });
    const each = Math.floor(MAX_BINDS / 7);
    for (let start = 0; start < facts.length; start += each) {
      const params: unknown[] = [];
      const values = facts.slice(start, start + each).map(([id, scope, subject, predicate, object, from, to]) =>
        `(${bind(params, id)}, ${bind(params, scope)}, ${bind(params, subject)}, ${bind(params, predicate)}, ` +
        `${bind(params, object)}, int8range(${bind(params, from)}::bigint, ${bind(params, to)}::bigint, '[)'))`,
      );
      await this.on
        .query(
          `INSERT INTO ${VALIDITY} (id, scope, subject, predicate, object, valid) VALUES ${values.join(", ")}`,
          params,
        )
        .catch((error: unknown) => {
          if ((error as { code?: string }).code !== EXCLUSION_VIOLATION) throw error;
          throw new Error(
            `that fact is already recorded as true over a period that overlaps this one. Close the ` +
              `earlier one first (\`unrelate\`), or give this one a period that does not share a moment ` +
              `with it — ${(error as Error).message}`,
          );
        });
    }
  }

  private async keep(items: Item[], vectors: (number[] | undefined)[]): Promise<void> {
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

  /**
   * Do something to the rows in a window, having first let go of their periods.
   *
   * A fact that is forgotten or taken back no longer holds its period against another
   * fact, and the two happen as one piece of work or not at all.
   */
  private async released<T>(window: Window, work: () => Promise<T>): Promise<T> {
    if (!this.valid) return work();
    return this.transaction(async () => {
      const params: unknown[] = [];
      const clauses = narrow(window, params);
      await this.on.query(
        `DELETE FROM ${VALIDITY} WHERE id IN
           (SELECT id FROM ${ITEMS}${where(clauses)} ORDER BY at DESC ${limitOf(window.limit, params)})`,
        params,
      );
      return work();
    });
  }

  /** Relationships followed by a recursive query, so the facts never leave the server. */
  async walk(walk: Walk): Promise<Step[]> {
    const { sql, params } = walkStatement(POSTGRES_DIALECT, walk);
    const result = await this.on.query(sql, params);
    return result.rows.map((row) => ({
      node: String(row[0]),
      depth: Number(row[1]),
      item: toItem(row.slice(2)),
    }));
  }

  /** A series grouped by the database, so only the windows cross the wire. */
  async buckets(buckets: Buckets): Promise<Bucket[]> {
    const { sql, params } = bucketStatement(this.dialect, buckets);
    const result = await this.on.query(sql, params);
    return result.rows.map((row) => ({ at: Number(row[0]), value: Number(row[1]) }));
  }

  async drop(window: Window): Promise<number> {
    return this.released(window, async () => {
      const params: unknown[] = [];
      const clauses = narrow(window, params);
      const result = await this.on.query(
        `DELETE FROM ${ITEMS} WHERE id IN
           (SELECT id FROM ${ITEMS}${where(clauses)} ORDER BY at DESC ${limitOf(window.limit, params)})`,
        params,
      );
      return result.changed ?? 0;
    });
  }

  async redact(window: Window, note: string, at: number): Promise<number> {
    return this.released(window, () => this.takeBack(window, note, at));
  }

  private async takeBack(window: Window, note: string, at: number): Promise<number> {
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
