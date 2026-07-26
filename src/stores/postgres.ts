/**
 * The other backend that ships with the framework.
 *
 * Same table, same four operations, a different dialect underneath — which is
 * the whole point of the split: nothing above this file changes when a store
 * moves from a file to a server. What does change is where the work happens.
 * Text search here is a real index the database maintains, not a scan.
 *
 * Vectors are the honest exception. They are kept, and compared here rather
 * than in the database, because ordering by distance needs an extension this
 * cannot assume is installed. That is fast enough for thousands of rows and
 * wrong for millions, exactly as it is for a local file — a store that outgrows
 * it wants a backend built for the job, which is what `Driver` is for.
 *
 * Text handed to search is treated as words rather than as a query to parse, so
 * an apostrophe returns results instead of a syntax error, and nothing a caller
 * types is ever read as an operator.
 */

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
const COLUMNS = "id, scope, body, meta, at";

/** `simple` stems nothing, so a stored word is the word that was stored. */
const DICTIONARY = "simple";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ${ITEMS} (
  id     text PRIMARY KEY,
  scope  text,
  body   text NOT NULL,
  meta   jsonb,
  vector bytea,
  at     bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS ${ITEMS}_recent ON ${ITEMS} (scope, at DESC);
CREATE INDEX IF NOT EXISTS ${ITEMS}_text
  ON ${ITEMS} USING gin (to_tsvector('${DICTIONARY}', body));
`;

const CAPABILITIES: Capabilities = {
  // The protocol counts parameters in a signed 16-bit field, and this is what
  // that leaves once the count itself is accounted for.
  maxBindValues: 65_535,
  fullText: true,
  vectors: true,
  returning: true,
};

/** Bind a value and answer with the placeholder that now refers to it. */
const bind = (params: unknown[], value: unknown): string => `$${params.push(value)}`;

function narrow(window: Window, params: unknown[], prefix = ""): string[] {
  const clauses: string[] = [];
  if (window.scope !== undefined) clauses.push(`${prefix}scope = ${bind(params, window.scope)}`);
  if (window.since !== undefined) clauses.push(`${prefix}at >= ${bind(params, window.since)}`);
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
  const [id, scope, body, meta, at] = row;
  const item: Item = { id: String(id), text: String(body), at: Number(at) };
  if (scope !== null && scope !== undefined) item.scope = String(scope);
  if (meta && typeof meta === "object") item.meta = meta as Record<string, unknown>;
  return item;
}

function toVector(blob: unknown): Float32Array | undefined {
  if (!(blob instanceof Uint8Array)) return undefined;
  return new Float32Array(blob.buffer, blob.byteOffset, Math.floor(blob.byteLength / 4));
}

const toBlob = (vector: number[] | undefined): Uint8Array | undefined =>
  vector ? new Uint8Array(Float32Array.from(vector).buffer) : undefined;

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

class PostgresConnection implements Connection {
  readonly capabilities = CAPABILITIES;
  /** Set while a transaction holds the connection, so its work stays inside it. */
  private held?: Held;

  constructor(
    private readonly wire: Wire,
    private readonly readOnly: boolean,
  ) {}

  private get on(): Held {
    return this.held ?? this.wire;
  }

  async install(): Promise<void> {
    if (this.readOnly) return;
    await this.on.exec(SCHEMA);
  }

  async put(items: Item[], vectors: (number[] | undefined)[]): Promise<void> {
    if (!items.length) return;
    const params: unknown[] = [];
    const values = items.map(
      (item, index) =>
        `(${bind(params, item.id)}, ${bind(params, item.scope ?? null)}, ` +
        `${bind(params, item.text)}, ${bind(params, item.meta ? JSON.stringify(item.meta) : null)}, ` +
        `${bind(params, toBlob(vectors[index]) ?? null)}, ${bind(params, item.at)})`,
    );
    await this.on.query(
      `INSERT INTO ${ITEMS} (id, scope, body, meta, vector, at) VALUES ${values.join(", ")}
       ON CONFLICT (id) DO UPDATE SET
         scope = EXCLUDED.scope, body = EXCLUDED.body, meta = EXCLUDED.meta,
         vector = EXCLUDED.vector, at = EXCLUDED.at`,
      params,
    );
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
      `SELECT i.id, i.scope, i.body, i.meta, i.at,
              ts_rank_cd(to_tsvector('${DICTIONARY}', i.body), q) AS rank
       FROM ${ITEMS} i, to_tsquery('${DICTIONARY}', ${asked}) q
       ${where([`to_tsvector('${DICTIONARY}', i.body) @@ q`, ...clauses])}
       ORDER BY rank DESC ${limitOf(window.limit, params)}`,
      params,
    );
    return result.rows.map((row) => ({ ...toItem(row), rank: Number(row[5]) }));
  }

  async near(vector: number[], window: Window): Promise<Ranked[]> {
    const params: unknown[] = [];
    const clauses = narrow(window, params);
    const result = await this.on.query(
      `SELECT ${COLUMNS}, vector FROM ${ITEMS}${where([...clauses, "vector IS NOT NULL"])}`,
      params,
    );
    const ranked: Ranked[] = [];
    for (const row of result.rows) {
      const stored = toVector(row[5]);
      if (!stored?.length) continue;
      ranked.push({ ...toItem(row), rank: cosine(vector, stored) });
    }
    ranked.sort((a, b) => b.rank - a.rank);
    return window.limit > 0 ? ranked.slice(0, window.limit) : ranked;
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

  async run(sql: string, params: readonly unknown[] = []): Promise<ResultSet> {
    const result = await this.on.query(sql, params);
    return { columns: result.columns, rows: result.rows, changed: result.changed };
  }

  async transaction<T>(work: () => Promise<T>): Promise<T> {
    // Already inside one: a savepoint, so a caller that wraps its own work does
    // not silently commit the work that wrapped it.
    if (this.held) return this.savepoint(this.held, work);

    return this.wire.lock(async (held) => {
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
    await this.wire.close();
  }
}

export const postgresDriver: Driver = {
  name: "postgres",
  async connect(options: ConnectOptions): Promise<Connection> {
    const wire = await Wire.open(wireOptionsFrom(options.url));
    const connection = new PostgresConnection(wire, options.readOnly ?? false);
    if (options.readOnly) await wire.exec("SET default_transaction_read_only = on");
    await connection.install();
    return connection;
  },
};
