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
 * Nearest-vector search here is an honest scan by default: every stored vector
 * is read and compared. That is fast enough for thousands of rows and wrong for
 * millions, and it is the price of not requiring an extension to be installed.
 * A store that outgrows it changes its url, not its code.
 *
 * An operator who would rather change the extension can: naming a `sqlite-vec`
 * build in `PRAECISE_SQLITE_EXTENSION` opens the connection with extension
 * loading allowed, loads that one file, and shuts the door behind it. Nothing
 * here turns it on by itself, and nothing infers a path. Loading an extension
 * runs machine code of somebody else's choosing inside the process holding the
 * data, which is a decision that belongs to whoever is deploying it and not to
 * a framework guessing from a url.
 *
 * The index is kept beside the rows rather than instead of them: the vector is
 * still in the table, so the scan is always available and always right. That is
 * what lets a vec0 query that fails demote itself to the scan mid-flight and
 * answer correctly anyway — visibly, in `capabilities.detail`, because a
 * fallback that is not visible is a fallback nobody knows they are on.
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";

/**
 * `node:sqlite` is loaded on first CONNECT, never on import.
 *
 * It is still flagged experimental, so importing it prints a warning to stderr. A
 * framework that pulled it in at module load would print that warning into every
 * consumer's output merely for importing the package — including consumers who use
 * Postgres, or who use no store at all. A side effect on import is the framework
 * speaking out of turn; deferring it means only the app that actually opens a SQLite
 * store sees the warning, which is the one place it is the truth.
 */
let loadDatabaseSync: Promise<typeof DatabaseSync> | null = null;
const databaseSync = (): Promise<typeof DatabaseSync> => {
  loadDatabaseSync ??= import("node:sqlite").then((m) => m.DatabaseSync);
  return loadDatabaseSync;
};

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

const ITEMS = "praecise_items";
const INDEX = "praecise_items_fts";
const VECTORS = "praecise_items_vec";
const COLUMNS = `id, scope, body, meta, at, writer, redacted`;

/**
 * What one table of text, json, a time and an optional vector can honestly be.
 *
 * Not `graph`. There are no edges here and nothing to walk them with, and a
 * store that declared one would get a list back and no warning that it had.
 */
const SERVES: readonly StoreKind[] = ["sql", "vector", "document", "timeseries"];

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
  serves: SERVES,
};

/**
 * The index sqlite-vec keeps, when there is one.
 *
 * `distance_metric=cosine` because cosine is the reading everything above this
 * file works in; a table built for L2 would rank the same rows differently and
 * the difference would show up as a threshold that stopped meaning anything.
 * The id is the key rather than the rowid, so the two tables stay joined
 * through the one thing that survives a row being rewritten.
 */
const vecSchema = (width: number): string =>
  `CREATE VIRTUAL TABLE IF NOT EXISTS ${VECTORS} USING vec0(
     id TEXT PRIMARY KEY, embedding float[${width}] distance_metric=cosine)`;

/**
 * The nearest rows, asked of the index.
 *
 * `k` is how many the index is asked for, and it is asked for exactly what the
 * caller wants — which is why this is only used for a window that narrows
 * nothing. vec0 picks its k nearest and then a join would drop whichever of
 * them fell outside the scope, so a narrowed window could come back empty while
 * holding perfectly good matches. The scan answers that one, correctly.
 */
const VEC_NEAR = `SELECT i.id, i.scope, i.body, i.meta, i.at, i.writer, i.redacted,
       1 - v.distance / 2 AS rank
FROM ${VECTORS} v JOIN ${ITEMS} i ON i.id = v.id
WHERE v.embedding MATCH ? AND k = ?
ORDER BY v.distance`;

/** Whether the caller asked about a subset, which the index cannot answer for. */
const narrowed = (window: Window): boolean =>
  window.id !== undefined ||
  window.scope !== undefined ||
  window.since !== undefined ||
  window.by !== undefined;

/** Why the scan is what is answering, said as the thing to do about it. */
const scanning = (loaded: boolean, width: number): string => {
  if (!loaded) {
    return `vectors are read and compared here (name a sqlite-vec build in ` +
      `PRAECISE_SQLITE_EXTENSION to have the extension order them instead)`;
  }
  if (width <= 0) {
    return `vectors are read and compared here (sqlite-vec is loaded, but an index needs a ` +
      `width — declare \`dimensions\` on the store)`;
  }
  return "vectors are read and compared here (sqlite-vec is loaded and its table is not there)";
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

/**
 * What this driver needs of a database handle.
 *
 * `DatabaseSync` is one, and is the only one in production. It is named
 * separately because the statements this file writes for an extension it cannot
 * assume is installed are worth reading without having installed it.
 */
export type Handle = Pick<DatabaseSync, "exec" | "prepare" | "close">;

class SqliteConnection implements Connection {
  private ability: Capabilities = CAPABILITIES;
  private depth = 0;
  /** Vectors are ordered by the extension rather than read and compared here. */
  private indexed = false;
  private readonly db: Handle;
  private readonly readOnly: boolean;
  constructor(
    db: Handle,
    readOnly: boolean,
  ) {
    this.db = db;
    this.readOnly = readOnly;
  }

  get capabilities(): Capabilities {
    return this.ability;
  }

  async install(): Promise<void> {
    if (this.readOnly) return;
    this.db.exec(SCHEMA);
  }

  /**
   * Make what can be made, then look at what is there.
   *
   * The order matters for the same reason it does on a server: `IF NOT EXISTS`
   * leaves an older file's shape alone, so what the index path runs against is
   * whether the table exists, not whether creating it was attempted.
   */
  async settle(options: ConnectOptions, extension: Extension): Promise<void> {
    const notes: string[] = [];
    if (extension.note) notes.push(extension.note);
    const width = options.dimensions ?? 0;

    await this.install();
    if (extension.loaded && width > 0 && !this.readOnly) {
      try {
        this.db.exec(vecSchema(width));
      } catch (error) {
        notes.push(`the index could not be made (${(error as Error).message})`);
      }
    }

    this.indexed = extension.loaded && this.holds(VECTORS);
    if (this.indexed && !this.readOnly) {
      const { filled, failed } = this.backfill();
      if (failed) {
        // An index that cannot be filled — a width that no longer matches, most
        // likely — is worse than no index, because it answers.
        this.indexed = false;
        notes.push(`the index could not be filled (${failed})`);
        try {
          this.db.exec(`DROP TABLE IF EXISTS ${VECTORS}`);
        } catch {
          // Then it stays, unused, and the scan is what answers.
        }
      } else if (filled) {
        notes.push(`${filled} vector${filled === 1 ? "" : "s"} older than the index went into it`);
      }
    }
    notes.push(
      this.indexed
        ? "vectors are ordered by sqlite-vec, except where the window narrows"
        : scanning(extension.loaded, width),
    );

    this.ability = {
      ...CAPABILITIES,
      vectorSearch: this.indexed ? "index" : "scan",
      detail: notes.join("; "),
    };
  }

  private holds(table: string): boolean {
    return this.select("SELECT 1 FROM sqlite_master WHERE name = ?", [table]).length > 0;
  }

  /**
   * Put into the index whatever the table holds and it does not.
   *
   * An index built today over rows written last year starts empty, and an empty
   * index does not answer with fewer rows — it answers with none, which reads
   * exactly like a store that lost them. So it is filled before it is used, and
   * every open checks rather than assuming the last one finished.
   */
  private backfill(): { filled: number; failed?: string } {
    let filled = 0;
    try {
      const known = new Set(
        this.select(`SELECT id FROM ${VECTORS}`, []).map((row) => String(row[0])),
      );
      const write = this.db.prepare(`INSERT INTO ${VECTORS} (id, embedding) VALUES (?, ?)`);
      for (const row of this.select(`SELECT id, vector FROM ${ITEMS} WHERE vector IS NOT NULL`, [])) {
        const id = String(row[0]);
        if (known.has(id) || !(row[1] instanceof Uint8Array)) continue;
        write.run(id, row[1] as never);
        filled++;
      }
    } catch (error) {
      return { filled, failed: (error as Error).message };
    }
    return { filled };
  }

  /**
   * The index has stopped being one. Go back to the scan, say so where an
   * operator can read it, and take the index out so the next connection builds
   * it again rather than trusting one that is half written.
   */
  private demote(error: unknown): void {
    this.indexed = false;
    this.ability = {
      ...this.ability,
      vectorSearch: "scan",
      detail:
        `${this.ability.detail ?? ""}; the index stopped answering ` +
        `(${(error as Error).message}), so vectors are read and compared here`,
    };
    try {
      this.db.exec(`DROP TABLE IF EXISTS ${VECTORS}`);
    } catch {
      // Read-only, or gone already. The scan is what answers either way.
    }
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
      if (this.indexed) this.reindex(items.map((item) => item.id), vectors);
    });
  }

  /**
   * The index, kept beside the rows rather than instead of them.
   *
   * vec0 has no upsert, so an id is cleared and written again. A failure here
   * is not a failed write: the vector is in the table either way, and the scan
   * that reads it is still correct — so the index steps aside instead of taking
   * the caller's write down with it.
   */
  private reindex(ids: string[], vectors: (number[] | undefined)[]): void {
    try {
      const clear = this.db.prepare(`DELETE FROM ${VECTORS} WHERE id = ?`);
      const write = this.db.prepare(`INSERT INTO ${VECTORS} (id, embedding) VALUES (?, ?)`);
      ids.forEach((id, index) => {
        clear.run(id);
        const blob = toBlob(vectors[index]);
        if (blob) write.run(id, blob as never);
      });
    } catch (error) {
      this.demote(error);
    }
  }

  /** Which rows a window names, for the index, which knows them only by id. */
  private named(window: Window): string[] {
    const { clauses, params } = narrow(window);
    return this.select(
      `SELECT id FROM ${ITEMS}${where(clauses)} ORDER BY at DESC LIMIT ?`,
      [...params, bounded(window.limit)],
    ).map((row) => String(row[0]));
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
    if (this.indexed && window.limit > 0 && !narrowed(window) && vector.some((one) => one !== 0)) {
      const found = this.nearest(vector, window.limit);
      if (found) return found;
    }
    return this.scan(vector, window);
  }

  /**
   * The nearest rows, asked of the index.
   *
   * The rank is `1 - d/2` over cosine distance, which is the same number the
   * comparison here produces for the same pair of vectors — so a store that
   * moves onto the index does not also move its scores, and a threshold an app
   * tuned against the scan still means what it meant.
   */
  private nearest(vector: number[], limit: number): Ranked[] | undefined {
    try {
      return this.select(VEC_NEAR, [toBlob(vector), limit]).map((row) => ({
        ...toItem(row),
        rank: Number(row[7]),
      }));
    } catch (error) {
      this.demote(error);
      return undefined;
    }
  }

  private scan(vector: number[], window: Window): Ranked[] {
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
    // Named before they are gone: afterwards there is nothing left to ask which
    // rows these were, and the index would keep answering for them.
    const going = this.indexed ? this.named(window) : [];
    const { clauses, params } = narrow(window);
    const statement = this.db.prepare(
      `DELETE FROM ${ITEMS} WHERE rowid IN
         (SELECT rowid FROM ${ITEMS}${where(clauses)} ORDER BY at DESC LIMIT ?)`,
    );
    const result = statement.run(...([...params, bounded(window.limit)] as never[]));
    this.unindex(going);
    return Number(result.changes);
  }

  async redact(window: Window, note: string, at: number): Promise<number> {
    const taken = this.indexed ? this.named(window) : [];
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
    this.unindex(taken);
    return Number(result.changes);
  }

  /** Take these out of the index. A redaction the index did not hear about is not one. */
  private unindex(ids: string[]): void {
    if (!this.indexed || !ids.length) return;
    try {
      const clear = this.db.prepare(`DELETE FROM ${VECTORS} WHERE id = ?`);
      for (const id of ids) clear.run(id);
    } catch (error) {
      this.demote(error);
    }
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

/**
 * Load the one extension an operator named, and shut the door behind it.
 *
 * Extension loading is off unless a path was given, and it is switched off
 * again the moment that path has been loaded — so the window in which this
 * connection will run somebody's native code is one statement wide, over a file
 * that was written down rather than found. Whether what loaded is sqlite-vec is
 * then asked rather than assumed: any shared object will load, and only one of
 * them answers `vec_version()`.
 */
function loadExtension(db: DatabaseSync, path: string): { loaded: boolean; note?: string } {
  try {
    db.loadExtension(path);
  } catch (error) {
    return { loaded: false, note: `${path} did not load (${(error as Error).message})` };
  } finally {
    db.enableLoadExtension(false);
  }
  try {
    const version = db.prepare("SELECT vec_version() AS version").get() as { version?: string };
    return { loaded: true, note: `sqlite-vec ${String(version?.version ?? "")} loaded from ${path}` };
  } catch (error) {
    return {
      loaded: false,
      note: `${path} loaded but is not sqlite-vec (${(error as Error).message})`,
    };
  }
}

/** What the extension turned out to be, as the connection needs to hear it. */
export interface Extension {
  loaded: boolean;
  note?: string;
}

/**
 * Everything the driver does once a database is open, including deciding
 * whether there is an index to use and filling it if there is.
 */
export async function openOn(
  db: Handle,
  options: ConnectOptions,
  extension: Extension = { loaded: false },
): Promise<Connection> {
  const connection = new SqliteConnection(db, options.readOnly ?? false);
  await connection.settle(options, extension);
  return connection;
}

export const sqliteDriver: Driver = {
  name: "sqlite",
  async connect(options: ConnectOptions): Promise<Connection> {
    const path = pathOf(options.url);
    const onDisk = path !== ":memory:";
    if (onDisk && !options.readOnly) await mkdir(dirname(path), { recursive: true });

    const wanted = options.extension?.trim();
    const DatabaseSyncCtor = await databaseSync();
    const db = new DatabaseSyncCtor(path, {
      readOnly: options.readOnly ?? false,
      // Never on by default. A store that did not ask for an extension is a
      // store this cannot be talked into loading one into.
      allowExtension: Boolean(wanted),
    });
    // Readers stop blocking the writer, which is what makes one file survive a
    // dev server serving several requests at once.
    if (onDisk && !options.readOnly) db.exec("PRAGMA journal_mode = WAL");

    return openOn(db, options, wanted ? loadExtension(db, wanted) : { loaded: false });
  },
};
