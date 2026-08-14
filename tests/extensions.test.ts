/**
 * The statements a store writes when the server can do more than the last one.
 *
 * No database runs here, and the interesting half of an extension is not the
 * extension: it is what this decides to send once it knows the extension is
 * there, and what it decides to send when it is not. So the server is a fake
 * that answers catalogue questions and records what it was asked — which makes
 * "does it emit `<=>`" a thing that can be asserted rather than a thing that is
 * hoped for, and makes the fallback's *invisibility* testable, which is the
 * failure that matters: a store a hundred times slower than its operator
 * believes, with nothing anywhere saying so.
 *
 * What this cannot check is that pgvector, TimescaleDB or sqlite-vec behave as
 * documented. `tests/postgres.test.ts` runs against the server CI provides, and
 * says plainly which paths that server does and does not have.
 */

import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { openOn as openPostgres, type Server } from "../src/stores/postgres.js";
import { openOn as openSqlite, sqliteDriver, type Handle } from "../src/stores/sqlite.js";
import { Kept } from "../src/stores/store.js";
import type { Connection, ConnectOptions } from "../src/stores/types.js";
import type { Held, WireResult } from "../src/stores/wire.js";

// ── A server that only answers ─────────────────────────────────────────────

interface Said {
  sql: string;
  params: readonly unknown[];
}

const nothing: WireResult = { columns: [], rows: [] };

/**
 * A Postgres that keeps a schema and no data.
 *
 * It is faithful about the one thing these tests turn on: `CREATE TABLE IF NOT
 * EXISTS` leaves an existing table's shape alone, so what the driver asked for
 * and what it got are allowed to differ — which is the whole reason the driver
 * looks afterwards instead of trusting itself.
 */
function serverFor(shape: {
  vector?: boolean;
  timescale?: boolean;
  offered?: boolean;
  existing?: { column: string; key: string[] };
  refuses?: RegExp;
}): Server & { said: Said[]; sent(pattern: RegExp): Said[] } {
  let vector = shape.vector ?? false;
  let column = shape.existing?.column ?? "";
  let key = shape.existing?.key ?? [];
  const said: Said[] = [];

  const answer = (sql: string, params: readonly unknown[]): WireResult => {
    said.push({ sql, params });
    if (shape.refuses?.test(sql)) throw new Error("permission denied");

    if (/CREATE TABLE IF NOT EXISTS/.test(sql)) {
      // Only a table that is not there is made by this statement.
      if (!column) {
        column = /^\s*vector\s+(\S+)/m.exec(sql)?.[1] ?? "";
        key = (/PRIMARY KEY \(([^)]+)\)/.exec(sql)?.[1] ?? "").split(",").map((one) => one.trim());
      }
      return nothing;
    }
    if (/CREATE EXTENSION/.test(sql)) {
      vector = true;
      return nothing;
    }
    if (/pg_extension/.test(sql)) {
      return {
        columns: ["vector", "timescale", "offered"],
        rows: [[vector ? 1 : 0, shape.timescale ? 1 : 0, shape.offered ? 1 : 0]],
      };
    }
    if (/format_type/.test(sql)) {
      return { columns: ["format_type"], rows: column ? [[column]] : [] };
    }
    if (/indisprimary/.test(sql)) {
      return { columns: ["attname"], rows: key.map((one) => [one]) };
    }
    if (/<=>/.test(sql)) {
      // One row, so the rank the driver reads back can be checked against the
      // distance the operator would have returned.
      return {
        columns: [],
        rows: [["one", null, "near", null, 1_000, null, null, 0.75]],
      };
    }
    return nothing;
  };

  const held: Held = {
    query: async (sql, params = []) => answer(sql, params),
    exec: async (sql) => answer(sql, []),
  };
  return {
    ...held,
    lock: async (work) => work(held),
    close: async () => undefined,
    said,
    sent: (pattern: RegExp) => said.filter((one) => pattern.test(one.sql)),
  };
}

const open = async (
  server: Server,
  options: Partial<ConnectOptions> = {},
): Promise<Connection> => openPostgres(server, { url: "postgres://x/y", ...options });

describe("pgvector, where the server has it", () => {
  it("makes the column the extension's own type and orders with the operator", async () => {
    const server = serverFor({ vector: true });
    const connection = await open(server, { of: "vector", dimensions: 4 });

    expect(server.sent(/CREATE TABLE/)[0]?.sql).toMatch(/vector vector\(4\)/);
    expect(server.sent(/hnsw/)).toHaveLength(1);
    expect(server.sent(/hnsw/)[0]?.sql).toMatch(/vector_cosine_ops/);

    await connection.near([1, 0, 0, 0], { limit: 5 });
    const asked = server.sent(/<=>/)[0];
    expect(asked?.sql).toMatch(/ORDER BY vector <=> \$1/);
    expect(asked?.sql).toMatch(/LIMIT \$2/);
    // The vector travels as a bound value in the extension's own text form.
    expect(asked?.params).toEqual(["[1,0,0,0]", 5]);
  });

  it("says the ordering is the database's, so the choice is not invisible", async () => {
    const connection = await open(serverFor({ vector: true }), { of: "vector", dimensions: 4 });
    expect(connection.capabilities.vectorSearch).toBe("index");
    expect(connection.capabilities.detail).toMatch(/ordered by the database/);
    expect(connection.capabilities.vectors).toBe(true);
  });

  it("reads a distance back as the score the comparison here would have given", async () => {
    // `<=>` is cosine distance and the rank is 1 - d/2, which is the same
    // number as (cos + 1) / 2. A store that moves onto the index keeps its
    // scores, so a threshold an app tuned against a scan still means something.
    const connection = await open(serverFor({ vector: true }), { of: "vector", dimensions: 4 });
    const [found] = await connection.near([1, 0, 0, 0], { limit: 5 });
    expect(found?.rank).toBe(0.75);
    expect(found?.id).toBe("one");
  });

  it("keeps the vector as text rather than as four bytes a number", async () => {
    const server = serverFor({ vector: true });
    const connection = await open(server, { of: "vector", dimensions: 4 });
    await connection.put([{ id: "one", text: "near", at: 1 }], [[1, 2, 3, 4]]);
    expect(server.sent(/INSERT INTO/)[0]?.params).toContain("[1,2,3,4]");
  });

  it("asks for nothing at all when the vector points nowhere", async () => {
    const server = serverFor({ vector: true });
    const connection = await open(server, { of: "vector", dimensions: 4 });
    expect(await connection.near([0, 0, 0, 0], { limit: 5 })).toEqual([]);
    expect(server.sent(/<=>/)).toHaveLength(0);
  });

  it("installs the extension where it is offered and the store declared vectors", async () => {
    const server = serverFor({ vector: false, offered: true });
    const connection = await open(server, { of: "vector", dimensions: 4 });
    expect(server.sent(/CREATE EXTENSION/)).toHaveLength(1);
    expect(connection.capabilities.vectorSearch).toBe("index");
  });

  it("does not install it for a store that declared no vectors", async () => {
    const server = serverFor({ vector: false, offered: true });
    await open(server, { of: "sql" });
    expect(server.sent(/CREATE EXTENSION/)).toHaveLength(0);
  });

  it("says what stopped it when it may not create the extension", async () => {
    const server = serverFor({ offered: true, refuses: /CREATE EXTENSION/ });
    const connection = await open(server, { of: "vector", dimensions: 4 });
    expect(connection.capabilities.vectorSearch).toBe("scan");
    expect(connection.capabilities.detail).toMatch(/could not be created/);
    expect(connection.capabilities.detail).toMatch(/permission denied/);
  });

  it("keeps the operator without an index rather than the answer without rows", async () => {
    const server = serverFor({ vector: true, refuses: /hnsw/ });
    const connection = await open(server, { of: "vector", dimensions: 4 });
    // The column is still the right type, so `<=>` is still exact — only slow.
    expect(connection.capabilities.vectorSearch).toBe("index");
    expect(connection.capabilities.detail).toMatch(/without an HNSW index/);
  });
});

describe("pgvector, where the server has not", () => {
  it("keeps the column, the scan and the score it always had", async () => {
    const server = serverFor({ vector: false });
    const connection = await open(server, { of: "vector", dimensions: 4 });

    expect(server.sent(/CREATE TABLE/)[0]?.sql).toMatch(/vector bytea/);
    expect(server.sent(/hnsw/)).toHaveLength(0);

    await connection.near([1, 0, 0, 0], { limit: 5 });
    expect(server.sent(/<=>/)).toHaveLength(0);
    expect(server.sent(/vector IS NOT NULL/)).toHaveLength(1);
  });

  it("keeps the vector as bytes, as every store already holding one expects", async () => {
    const server = serverFor({ vector: false });
    const connection = await open(server, { of: "vector", dimensions: 4 });
    await connection.put([{ id: "one", text: "near", at: 1 }], [[1, 2, 3, 4]]);
    const written = server.sent(/INSERT INTO/)[0]?.params ?? [];
    expect(written.some((value) => value instanceof Uint8Array)).toBe(true);
  });

  it("says which statement would change that", async () => {
    const connection = await open(serverFor({ vector: false }), { of: "vector", dimensions: 4 });
    expect(connection.capabilities.vectorSearch).toBe("scan");
    expect(connection.capabilities.detail).toMatch(/CREATE EXTENSION vector/);
    expect(connection.capabilities.detail).toMatch(/no restart/);
  });

  it("tells a server with no build to get one, and one that has it to run the statement", async () => {
    // "Install the extension" is unhelpful to an operator whose server has
    // nothing to install, and the two situations look identical from here
    // unless the catalogue of what is available is asked as well.
    const bare = await open(serverFor({ vector: false, offered: false }), {
      of: "vector",
      dimensions: 4,
    });
    expect(bare.capabilities.detail).toMatch(/no "vector" extension to install/);

    const ready = await open(serverFor({ vector: false, offered: true }), {
      of: "vector",
      dimensions: 4,
      readOnly: true,
    });
    expect(ready.capabilities.detail).toMatch(/the "vector" extension is not installed/);
  });

  it("says a width is missing when that is what is missing", async () => {
    const connection = await open(serverFor({ vector: true }), { of: "sql" });
    expect(connection.capabilities.vectorSearch).toBe("scan");
    expect(connection.capabilities.detail).toMatch(/dimensions/);
  });

  it("leaves a table that already holds bytea alone, and says why", async () => {
    // The extension arrived after the rows did. Reading a `vector` column that
    // is not one would not be faster, it would be empty.
    const server = serverFor({ vector: true, existing: { column: "bytea", key: ["id"] } });
    const connection = await open(server, { of: "vector", dimensions: 4 });
    expect(connection.capabilities.vectorSearch).toBe("scan");
    expect(connection.capabilities.detail).toMatch(/already holds them as bytea/);
    await connection.near([1, 0, 0, 0], { limit: 5 });
    expect(server.sent(/<=>/)).toHaveLength(0);
  });

  it("orders in the database from a read-only connection it could not have made", async () => {
    const server = serverFor({ vector: true, existing: { column: "vector(4)", key: ["id"] } });
    const connection = await open(server, { of: "vector", dimensions: 4, readOnly: true });
    expect(server.sent(/CREATE /)).toHaveLength(0);
    expect(connection.capabilities.vectorSearch).toBe("index");
    await connection.near([1, 0, 0, 0], { limit: 5 });
    expect(server.sent(/<=>/)).toHaveLength(1);
  });
});

describe("TimescaleDB, for a store that declared time", () => {
  it("widens the key and partitions into chunks", async () => {
    const server = serverFor({ timescale: true });
    const connection = await open(server, { of: "timeseries" });

    expect(server.sent(/CREATE TABLE/)[0]?.sql).toMatch(/PRIMARY KEY \(id, at\)/);
    const made = server.sent(/create_hypertable/)[0]?.sql ?? "";
    expect(made).toMatch(/'praecise_items', 'at'/);
    expect(made).toMatch(/chunk_time_interval => 604800000/);
    expect(made).toMatch(/if_not_exists => TRUE/);
    expect(connection.capabilities.detail).toMatch(/partitioned into weekly chunks/);
  });

  it("keeps an id a single row even where the key can no longer say so", async () => {
    // A hypertable's key has to carry the column it partitions on, and a key
    // over (id, at) would let the same id sit twice at two times. It is cleared
    // and written again in one piece of work instead.
    const server = serverFor({ timescale: true });
    const connection = await open(server, { of: "timeseries" });
    await connection.put([{ id: "one", text: "again", at: 2_000 }], [undefined]);

    expect(server.sent(/DELETE FROM praecise_items WHERE id IN/)).toHaveLength(1);
    expect(server.sent(/INSERT INTO/)[0]?.sql).toMatch(/ON CONFLICT \(id, at\)/);
    expect(server.said.map((one) => one.sql).join(" ")).toMatch(/BEGIN/);
  });

  it("does not widen the key for a store that is not a time series", async () => {
    const server = serverFor({ timescale: true });
    const connection = await open(server, { of: "sql" });
    expect(server.sent(/CREATE TABLE/)[0]?.sql).toMatch(/PRIMARY KEY \(id\)/);
    expect(server.sent(/create_hypertable/)).toHaveLength(0);
    expect(connection.capabilities.detail).not.toMatch(/chunk/);
  });

  it("names the config line and the restart when the extension is not there", async () => {
    const server = serverFor({ timescale: false });
    const connection = await open(server, { of: "timeseries" });
    expect(server.sent(/create_hypertable/)).toHaveLength(0);
    expect(connection.capabilities.detail).toMatch(/shared_preload_libraries = 'timescaledb'/);
    expect(connection.capabilities.detail).toMatch(/restart/);
  });

  it("explains the primary key rather than partitioning a table it would break", async () => {
    const server = serverFor({ timescale: true, existing: { column: "bytea", key: ["id"] } });
    const connection = await open(server, { of: "timeseries" });
    expect(server.sent(/create_hypertable/)).toHaveLength(0);
    expect(connection.capabilities.detail).toMatch(/primary key/);
    expect(connection.capabilities.detail).toMatch(/\(id, at\)/);
  });

  it("says so and carries on when the server refuses to partition", async () => {
    const server = serverFor({ timescale: true, refuses: /create_hypertable/ });
    const connection = await open(server, { of: "timeseries" });
    expect(connection.capabilities.detail).toMatch(/plain indexed column/);
    expect(connection.capabilities.detail).toMatch(/permission denied/);
  });

  it("touches nothing outside the part of that extension anyone may use", async () => {
    // Compression, continuous aggregates, retention and the job scheduler are
    // the source-available half. A framework reaching for them would be handing
    // its adopters a licence they never chose.
    const server = serverFor({ timescale: true });
    const connection = await open(server, { of: "timeseries" });
    await connection.put([{ id: "one", text: "a", at: 1 }], [undefined]);
    const everything = server.said.map((one) => one.sql).join("\n");
    expect(everything).not.toMatch(/compress|continuous aggregate|add_.*policy|materialized view/i);
  });
});

// ── A SQLite that has an index, without having the extension ────────────────

/**
 * Real SQLite, with `vec0` played by a stand-in.
 *
 * Everything about the rows is genuine — a real file, real statements, real
 * results — and only the virtual table is emulated, because a virtual table
 * module cannot be written from here and the extension is not something this
 * repository may depend on. So what is under test is the driver's half of the
 * contract: that the index is made, filled, written to, cleared on a redaction,
 * asked with `MATCH` and `k`, and stood down from when it stops answering.
 * That the extension keeps its half is `tests/postgres.test.ts`'s kind of
 * question, and there is no server here that has it.
 */
type StandIn = Handle & { made: boolean; held: Map<string, Float32Array> };

function withStandIn(real: DatabaseSync, breaks?: RegExp): StandIn {
  const held = new Map<string, Float32Array>();
  const shell = {
    made: false,
    held,
    exec(sql: string): void {
      if (/praecise_items_vec/.test(sql)) {
        if (/DROP TABLE/.test(sql)) {
          shell.made = false;
          held.clear();
        } else shell.made = true;
        return;
      }
      real.exec(sql);
    },
    prepare(sql: string): unknown {
      if (breaks?.test(sql)) {
        const gone = (): never => {
          throw new Error("no such module: vec0");
        };
        return { setReturnArrays: () => undefined, all: gone, run: gone };
      }
      if (/FROM sqlite_master/.test(sql)) {
        return {
          setReturnArrays: () => undefined,
          all: (name: string) =>
            name === "praecise_items_vec" ? (shell.made ? [[1]] : []) : real.prepare(sql).all(name),
        };
      }
      if (!/praecise_items_vec/.test(sql)) return real.prepare(sql);

      return {
        setReturnArrays: () => undefined,
        run: (...args: unknown[]) => {
          if (sql.startsWith("DELETE")) held.delete(String(args[0]));
          else held.set(String(args[0]), floats(args[1]));
          return { changes: 1 };
        },
        all: (...args: unknown[]) => {
          if (sql.startsWith("SELECT id FROM")) return [...held.keys()].map((id) => [id]);
          // The KNN join: nearest k by cosine, read back through the real rows.
          const asked = floats(args[0]);
          const k = Number(args[1]);
          return [...held.entries()]
            .map(([id, vector]) => ({ id, distance: 1 - similarity(asked, vector) }))
            .sort((a, b) => a.distance - b.distance)
            .slice(0, k)
            .flatMap(({ id, distance }) => {
              const [row] = real
                .prepare(
                  "SELECT id, scope, body, meta, at, writer, redacted FROM praecise_items WHERE id = ?",
                )
                .all(id) as Record<string, unknown>[];
              return row ? [[...Object.values(row), 1 - distance / 2]] : [];
            });
        },
      };
    },
    close: () => real.close(),
  };
  return shell as unknown as StandIn;
}

const floats = (value: unknown): Float32Array =>
  value instanceof Uint8Array
    ? new Float32Array(value.buffer, value.byteOffset, Math.floor(value.byteLength / 4))
    : new Float32Array();

function similarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let left = 0;
  let right = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!;
    left += a[i]! * a[i]!;
    right += b[i]! * b[i]!;
  }
  return left && right ? dot / Math.sqrt(left * right) : 0;
}

const loaded = { loaded: true, note: "sqlite-vec 0.1.0 loaded from /opt/vec0.so" };

async function indexed(
  breaks?: RegExp,
): Promise<{ store: Kept; connection: Connection; index: Map<string, Float32Array> }> {
  const db = withStandIn(new DatabaseSync(":memory:"), breaks);
  const connection = await openSqlite(db, { url: ":memory:", dimensions: 4 }, loaded);
  return { store: new Kept("kept", "vector", connection), connection, index: db.held };
}

describe("sqlite-vec, where an operator asked for it", () => {
  it("makes an index of the width the store declared, and says it is using it", async () => {
    const { connection } = await indexed();
    expect(connection.capabilities.vectorSearch).toBe("index");
    expect(connection.capabilities.detail).toMatch(/ordered by sqlite-vec/);
    expect(connection.capabilities.detail).toMatch(/sqlite-vec 0\.1\.0/);
  });

  it("answers with the nearest, scored as the scan would have scored them", async () => {
    const { store, index } = await indexed();
    await store.remember([
      { id: "near", text: "close", vector: [1, 0, 0, 0] },
      { id: "side", text: "orthogonal", vector: [0, 1, 0, 0] },
      { id: "none", text: "no vector at all" },
    ]);
    expect([...index.keys()].sort()).toEqual(["near", "side"]);

    const found = await store.recall([1, 0, 0, 0], { limit: 5 });
    expect(found.map((one) => one.id)).toEqual(["near", "side"]);
    expect(found[0]!.score).toBeCloseTo(1, 5);
    expect(found[1]!.score).toBeCloseTo(0.5, 5);
  });

  it("is the index that answers, and not the column beside it", async () => {
    // The two hold the same vectors, so agreeing proves nothing. They are made
    // to disagree: the rows keep theirs and the index is emptied. An answer
    // that still arrives is an answer that came from the wrong place.
    const { store, connection, index } = await indexed();
    await store.remember({ id: "near", text: "close", vector: [1, 0, 0, 0] });
    index.clear();
    expect(await connection.near([1, 0, 0, 0], { limit: 5 })).toEqual([]);
  });

  it("takes a redacted row out of the index, not only out of the table", async () => {
    // A row still reachable by the vector it was kept with has not been taken
    // back, whatever its text now reads — and the index is a second place for
    // it to still be reachable from.
    const { store, connection, index } = await indexed();
    await store.remember({ id: "secret", text: "the passphrase is hunter", vector: [1, 0, 0, 0] });
    await store.redact({ id: "secret" }, "[taken back]");
    expect([...index.keys()]).toEqual([]);
    expect(await connection.near([1, 0, 0, 0], { limit: 5 })).toEqual([]);
  });

  it("takes a forgotten row out of the index too", async () => {
    const { store, connection, index } = await indexed();
    await store.remember({ id: "gone", text: "forget me", vector: [1, 0, 0, 0] });
    await store.forget({ id: "gone" });
    expect([...index.keys()]).toEqual([]);
    expect(await connection.near([1, 0, 0, 0], { limit: 5 })).toEqual([]);
  });

  it("keeps an id in the index once, however many times it is written", async () => {
    const { store, index } = await indexed();
    await store.remember({ id: "one", text: "as written", vector: [1, 0, 0, 0] });
    await store.remember({ id: "one", text: "as corrected", vector: [0, 1, 0, 0] });
    expect([...index.keys()]).toEqual(["one"]);
    expect([...index.values()][0]?.[1]).toBe(1);
  });

  it("answers a narrowed window from the scan, where the index would answer wrongly", async () => {
    // vec0 picks its k nearest and a join then drops whatever fell outside the
    // scope, so a narrowed window could come back empty while holding good
    // matches. The scan is slower and right.
    const { store } = await indexed();
    await store.remember([
      { id: "mine", text: "in scope", scope: "a", vector: [1, 0, 0, 0] },
      { id: "theirs", text: "out of scope", scope: "b", vector: [1, 0, 0, 0] },
    ]);
    const found = await store.recall([1, 0, 0, 0], { scope: "a" });
    expect(found.map((one) => one.id)).toEqual(["mine"]);
  });

  it("fills an index made after the rows it is meant to hold", async () => {
    // An empty index does not answer with fewer rows. It answers with none,
    // which reads exactly like a store that lost them.
    const real = new DatabaseSync(":memory:");
    const before = await openSqlite(withStandIn(real), { url: ":memory:", dimensions: 4 });
    await new Kept("kept", "vector", before).remember({
      id: "old",
      text: "written before the index",
      vector: [1, 0, 0, 0],
    });
    expect(before.capabilities.vectorSearch).toBe("scan");

    const db = withStandIn(real);
    const after = await openSqlite(db, { url: ":memory:", dimensions: 4 }, loaded);
    expect(after.capabilities.detail).toMatch(/1 vector older than the index went into it/);
    expect([...db.held.keys()]).toEqual(["old"]);
    expect((await after.near([1, 0, 0, 0], { limit: 5 })).map((one) => one.id)).toEqual(["old"]);
  });

  it("stands the index down where it stops answering, and still answers", async () => {
    const { store, connection } = await indexed();
    await store.remember({ id: "near", text: "close", vector: [1, 0, 0, 0] });

    // The extension goes away underneath a store that was using it.
    const broken = withStandIn(new DatabaseSync(":memory:"), /MATCH/);
    const fragile = await openSqlite(broken, { url: ":memory:", dimensions: 4 }, loaded);
    const held = new Kept("kept", "vector", fragile);
    await held.remember({ id: "near", text: "close", vector: [1, 0, 0, 0] });

    const found = await held.recall([1, 0, 0, 0], { limit: 5 });
    expect(found.map((one) => one.id)).toEqual(["near"]);
    expect(fragile.capabilities.vectorSearch).toBe("scan");
    expect(fragile.capabilities.detail).toMatch(/stopped answering/);
    expect(connection.capabilities.vectorSearch).toBe("index");
  });

  it("has no index at all rather than one it could not fill", async () => {
    // A width that no longer matches what is stored, most likely. An index that
    // half exists still answers, which is the worst of the three outcomes.
    const real = new DatabaseSync(":memory:");
    const before = await openSqlite(withStandIn(real), { url: ":memory:", dimensions: 4 });
    await new Kept("kept", "vector", before).remember({
      id: "old",
      text: "written before the index",
      vector: [1, 0, 0, 0],
    });

    const db = withStandIn(real, /INSERT INTO praecise_items_vec/);
    const connection = await openSqlite(db, { url: ":memory:", dimensions: 4 }, loaded);
    expect(connection.capabilities.vectorSearch).toBe("scan");
    expect(connection.capabilities.detail).toMatch(/could not be filled/);
    expect(db.made).toBe(false);
    // And the store still answers, because the vectors were never only there.
    expect((await connection.near([1, 0, 0, 0], { limit: 5 })).map((one) => one.id)).toEqual(["old"]);
  });

  it("says a width is missing rather than making an index that cannot exist", async () => {
    const connection = await openSqlite(
      withStandIn(new DatabaseSync(":memory:")),
      { url: ":memory:" },
      loaded,
    );
    expect(connection.capabilities.vectorSearch).toBe("scan");
    expect(connection.capabilities.detail).toMatch(/needs a width/);
  });
});

describe("sqlite-vec, where nobody asked for it", () => {
  it("does not allow an extension to be loaded at all", async () => {
    const connection = await sqliteDriver.connect({ url: ":memory:", dimensions: 4 });
    // Nothing above can reach the handle, so the proof is that the door is
    // shut: a connection opened without `allowExtension` refuses the call.
    await expect(
      connection.run("SELECT load_extension('/opt/vec0.so')"),
    ).rejects.toThrow(/not authorized|no such function/);
    await connection.close();
  });

  it("scans, and says which variable would change that", async () => {
    const connection = await sqliteDriver.connect({ url: ":memory:", dimensions: 4 });
    expect(connection.capabilities.vectorSearch).toBe("scan");
    expect(connection.capabilities.detail).toMatch(/PRAECISE_SQLITE_EXTENSION/);
    await connection.close();
  });

  it("opens anyway when the file an operator named is not there, and says so", async () => {
    const connection = await sqliteDriver.connect({
      url: ":memory:",
      dimensions: 4,
      extension: "/nowhere/not-a-real-build",
    });
    expect(connection.capabilities.vectorSearch).toBe("scan");
    expect(connection.capabilities.detail).toMatch(/did not load/);

    // And the store is a working store, which is the point of not throwing.
    const store = new Kept("kept", "vector", connection);
    await store.remember({ id: "near", text: "close", vector: [1, 0, 0, 0] });
    expect((await store.recall([1, 0, 0, 0])).map((one) => one.id)).toEqual(["near"]);
    await connection.close();
  });
});
