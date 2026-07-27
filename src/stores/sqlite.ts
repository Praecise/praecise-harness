/**
 * The backend that ships with the framework: a single file on disk, or nothing
 * at all when the url is `:memory:`. It is here so that a store works before
 * anyone has provisioned a database, in the same way memory works before anyone
 * has configured one.
 *
 * It owns one table and one text index, both prefixed so they cannot be
 * mistaken for the author's own. Everything above it asks for `match` or
 * `near`; the SQL those become never leaves this file.
 *
 * Nearest-vector search here is an honest scan: every stored vector is read and
 * compared. That is fast enough for thousands of rows and wrong for millions,
 * and it is the price of not requiring an extension to be installed. A store
 * that outgrows it changes its url, not its code.
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

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

const ITEMS = "praecise_items";
const INDEX = "praecise_items_fts";
const COLUMNS = `id, scope, body, meta, at, writer, redacted`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ${ITEMS} (
  id     TEXT PRIMARY KEY,
  scope  TEXT,
  body   TEXT NOT NULL,
  meta   TEXT,
  vector BLOB,
  at     INTEGER NOT NULL,
  writer TEXT,
  redacted INTEGER
);
CREATE INDEX IF NOT EXISTS ${ITEMS}_recent ON ${ITEMS} (scope, at DESC);
CREATE VIRTUAL TABLE IF NOT EXISTS ${INDEX}
  USING fts5(body, content='${ITEMS}', content_rowid='rowid');
CREATE TRIGGER IF NOT EXISTS ${ITEMS}_ai AFTER INSERT ON ${ITEMS} BEGIN
  INSERT INTO ${INDEX}(rowid, body) VALUES (new.rowid, new.body);
END;
CREATE TRIGGER IF NOT EXISTS ${ITEMS}_ad AFTER DELETE ON ${ITEMS} BEGIN
  INSERT INTO ${INDEX}(${INDEX}, rowid, body) VALUES ('delete', old.rowid, old.body);
END;
CREATE TRIGGER IF NOT EXISTS ${ITEMS}_au AFTER UPDATE ON ${ITEMS} BEGIN
  INSERT INTO ${INDEX}(${INDEX}, rowid, body) VALUES ('delete', old.rowid, old.body);
  INSERT INTO ${INDEX}(rowid, body) VALUES (new.rowid, new.body);
END;
`;

const UPSERT = `
INSERT INTO ${ITEMS} (id, scope, body, meta, vector, at, writer) VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  scope = excluded.scope, body = excluded.body, meta = excluded.meta,
  vector = excluded.vector, at = excluded.at, writer = excluded.writer
`;

const CAPABILITIES: Capabilities = {
  // One under the historical compile-time ceiling, so a statement built here
  // binds the same on a host that was built with the old default.
  maxBindValues: 999,
  fullText: true,
  vectors: true,
  returning: true,
};

/** A limit at or below zero means the whole window, which is how SQL spells it. */
const bounded = (limit: number): number => (limit > 0 ? limit : -1);

function narrow(window: Window, table = ITEMS): { clauses: string[]; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (window.id !== undefined) {
    clauses.push(`${table}.id = ?`);
    params.push(window.id);
  }
  if (window.scope !== undefined) {
    clauses.push(`${table}.scope = ?`);
    params.push(window.scope);
  }
  if (window.since !== undefined) {
    clauses.push(`${table}.at >= ?`);
    params.push(window.since);
  }
  if (window.by !== undefined) {
    clauses.push(`${table}.writer = ?`);
    params.push(window.by);
  }
  return { clauses, params };
}

const where = (clauses: string[]): string => (clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "");

/**
 * Terms, as the text index will accept them.
 *
 * Whatever arrives is treated as words to look for rather than as a query to
 * parse. A caller typing an apostrophe or a bracket gets results instead of a
 * syntax error, and no phrasing reaches the index that the index did not build.
 */
function terms(text: string): string {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.map((word) => `"${word}"`).join(" OR ");
}

function toItem(row: unknown[]): Item {
  const [id, scope, body, meta, at, writer, redacted] = row;
  const item: Item = { id: String(id), text: String(body), at: Number(at) };
  if (scope !== null && scope !== undefined) item.scope = String(scope);
  if (writer !== null && writer !== undefined) item.by = String(writer);
  if (redacted !== null && redacted !== undefined) item.redactedAt = Number(redacted);
  if (typeof meta === "string") {
    try {
      item.meta = JSON.parse(meta) as Record<string, unknown>;
    } catch {
      // Written by something other than this driver. The row is still an item.
    }
  }
  return item;
}

const toBlob = (vector: number[] | undefined): Uint8Array | null =>
  vector ? new Uint8Array(Float32Array.from(vector).buffer) : null;

function toVector(blob: unknown): Float32Array | undefined {
  if (!(blob instanceof Uint8Array)) return undefined;
  return new Float32Array(blob.buffer, blob.byteOffset, Math.floor(blob.byteLength / 4));
}

/** Cosine similarity, mapped from -1..1 onto 0..1 so every rank reads the same way. */
function cosine(a: readonly number[] | Float32Array, b: Float32Array): number {
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

class SqliteConnection implements Connection {
  readonly capabilities = CAPABILITIES;
  private depth = 0;

  constructor(
    private readonly db: DatabaseSync,
    private readonly readOnly: boolean,
  ) {}

  async install(): Promise<void> {
    if (this.readOnly) return;
    this.db.exec(SCHEMA);
  }

  private select(sql: string, params: readonly unknown[]): unknown[][] {
    const statement = this.db.prepare(sql);
    statement.setReturnArrays(true);
    return statement.all(...(params as never[])) as unknown as unknown[][];
  }

  async put(items: Item[], vectors: (number[] | undefined)[]): Promise<void> {
    if (!items.length) return;
    await this.transaction(async () => {
      const statement = this.db.prepare(UPSERT);
      items.forEach((item, index) => {
        statement.run(
          item.id,
          item.scope ?? null,
          item.text,
          item.meta ? JSON.stringify(item.meta) : null,
          toBlob(vectors[index]),
          item.at,
          item.by ?? null,
        );
      });
    });
  }

  async list(window: Window): Promise<Item[]> {
    const { clauses, params } = narrow(window);
    return this.select(
      `SELECT ${COLUMNS} FROM ${ITEMS}${where(clauses)} ORDER BY at DESC LIMIT ?`,
      [...params, bounded(window.limit)],
    ).map(toItem);
  }

  async match(text: string, window: Window): Promise<Ranked[]> {
    const query = terms(text);
    if (!query) return [];
    const { clauses, params } = narrow(window, "i");
    return this.select(
      `SELECT i.id, i.scope, i.body, i.meta, i.at, i.writer, i.redacted, -bm25(${INDEX}) AS rank
       FROM ${INDEX} JOIN ${ITEMS} i ON i.rowid = ${INDEX}.rowid
       ${where([`${INDEX} MATCH ?`, ...clauses])}
       ORDER BY rank DESC LIMIT ?`,
      [query, ...params, bounded(window.limit)],
    ).map((row) => ({ ...toItem(row), rank: Number(row[7]) }));
  }

  async near(vector: number[], window: Window): Promise<Ranked[]> {
    const { clauses, params } = narrow(window);
    const rows = this.select(
      `SELECT ${COLUMNS}, vector FROM ${ITEMS}${where([...clauses, "vector IS NOT NULL"])}`,
      params,
    );
    const ranked: Ranked[] = [];
    for (const row of rows) {
      const stored = toVector(row[7]);
      if (!stored?.length) continue;
      ranked.push({ ...toItem(row), rank: cosine(vector, stored) });
    }
    ranked.sort((a, b) => b.rank - a.rank);
    return window.limit > 0 ? ranked.slice(0, window.limit) : ranked;
  }

  async drop(window: Window): Promise<number> {
    const { clauses, params } = narrow(window);
    const statement = this.db.prepare(
      `DELETE FROM ${ITEMS} WHERE rowid IN
         (SELECT rowid FROM ${ITEMS}${where(clauses)} ORDER BY at DESC LIMIT ?)`,
    );
    const result = statement.run(...([...params, bounded(window.limit)] as never[]));
    return Number(result.changes);
  }

  async redact(window: Window, note: string, at: number): Promise<number> {
    const { clauses, params } = narrow(window);
    // The vector goes with the text. A row that could still be found by what it
    // used to say has not been taken back, whatever its text now reads.
    const statement = this.db.prepare(
      `UPDATE ${ITEMS} SET body = ?, meta = NULL, vector = NULL, redacted = ? WHERE rowid IN
         (SELECT rowid FROM ${ITEMS}${where(clauses)} ORDER BY at DESC LIMIT ?)`,
    );
    const result = statement.run(
      ...([note, at, ...params, bounded(window.limit)] as never[]),
    );
    return Number(result.changes);
  }

  async run(sql: string, params: readonly unknown[] = []): Promise<ResultSet> {
    const statement = this.db.prepare(sql);
    const columns = statement.columns().map((column) => column.name ?? column.column ?? "");
    if (!columns.length) {
      const result = statement.run(...(params as never[]));
      return { columns: [], rows: [], changed: Number(result.changes) };
    }
    statement.setReturnArrays(true);
    return { columns, rows: statement.all(...(params as never[])) as unknown as unknown[][] };
  }

  async transaction<T>(work: () => Promise<T>): Promise<T> {
    // A transaction inside a transaction becomes a savepoint, so a caller that
    // wraps its own work does not silently commit the work that wrapped it.
    const point = `praecise_${this.depth}`;
    this.db.exec(this.depth ? `SAVEPOINT ${point}` : "BEGIN");
    this.depth++;
    try {
      const answer = await work();
      this.db.exec(this.depth > 1 ? `RELEASE ${point}` : "COMMIT");
      return answer;
    } catch (error) {
      this.db.exec(this.depth > 1 ? `ROLLBACK TO ${point}` : "ROLLBACK");
      throw error;
    } finally {
      this.depth--;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

/** Everything before the path is addressing, and this backend has one address. */
function pathOf(url: string): string {
  const path = url.replace(/^(sqlite|file):(\/\/)?/, "").trim();
  return path || ":memory:";
}

export const sqliteDriver: Driver = {
  name: "sqlite",
  async connect(options: ConnectOptions): Promise<Connection> {
    const path = pathOf(options.url);
    const onDisk = path !== ":memory:";
    if (onDisk && !options.readOnly) await mkdir(dirname(path), { recursive: true });

    const db = new DatabaseSync(path, { readOnly: options.readOnly ?? false });
    // Readers stop blocking the writer, which is what makes one file survive a
    // dev server serving several requests at once.
    if (onDisk && !options.readOnly) db.exec("PRAGMA journal_mode = WAL");

    const connection = new SqliteConnection(db, options.readOnly ?? false);
    await connection.install();
    return connection;
  },
};
