/**
 * The paths a backend may take over from the process, held to the answers the
 * process gives.
 *
 * Three things are run here, and it is worth being exact about which is which:
 *
 *   SQLite     — the real statements against a real database, on any machine. The
 *                driver is opened over a handle that leaves the text index out of the
 *                schema, because this suite is about walks and buckets and some builds
 *                of Node have no FTS5.
 *   Postgres   — the statements the driver decides to write, read off a server that
 *                only answers; and the same against a real server where one is
 *                reachable, which is where they are actually executed.
 *   The wire   — version negotiation against a socket that speaks the opening of the
 *                protocol and nothing else.
 */
import { createServer, type Server as NetServer, type Socket } from "node:net";
import { DatabaseSync } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { conform, conformanceReport } from "../src/stores/conform.js";
import { memoryDriver } from "../src/stores/memory.js";
import { Facts, Series, type Aggregate } from "../src/stores/models.js";
import { bucketStatement, walkStatement } from "../src/stores/paths.js";
import { openOn as openPostgres, POSTGRES_DIALECT, postgresDriver, type Server } from "../src/stores/postgres.js";
import { openOn as openSqlite, type Handle } from "../src/stores/sqlite.js";
import type { Connection, Driver } from "../src/stores/types.js";
import { Wire, wireOptionsFrom, type Held, type WireResult } from "../src/stores/wire.js";

// ── SQLite, for real ───────────────────────────────────────────────────────

/** A database whose schema is made without the text index, and is otherwise the driver's own. */
function withoutTextIndex(): Handle {
  const db = new DatabaseSync(":memory:");
  const plain = (sql: string): string =>
    sql.replace(/CREATE VIRTUAL TABLE[^;]*fts5[^;]*;/g, "").replace(/CREATE TRIGGER[\s\S]*?END;/g, "");
  return { exec: (sql) => db.exec(plain(sql)), prepare: (sql) => asArrays(db.prepare(sql)), close: () => db.close() };
}

/**
 * A statement that can hand rows back as arrays, on a Node whose `node:sqlite` is from
 * before it could. The driver asks for arrays; an older build only gives objects, whose
 * values are the same row in the same order.
 */
function asArrays<Statement extends object>(statement: Statement): Statement {
  if (typeof (statement as { setReturnArrays?: unknown }).setReturnArrays === "function") return statement;
  let arrays = false;
  return new Proxy(statement, {
    get(target, key) {
      if (key === "setReturnArrays") return (flag: boolean) => void (arrays = flag);
      const value = Reflect.get(target, key) as unknown;
      if (typeof value !== "function") return value;
      if (key === "all") {
        return (...params: unknown[]) => {
          const rows = (value as (...given: unknown[]) => Record<string, unknown>[]).apply(target, params);
          return arrays ? rows.map((row) => Object.values(row)) : rows;
        };
      }
      return (value as (...given: unknown[]) => unknown).bind(target);
    },
  });
}

const sqliteWithoutText: Driver = {
  name: "sqlite",
  connect: (options) => openSqlite(withoutTextIndex(), options),
};

const named = (result: Awaited<ReturnType<typeof conform>>, name: RegExp) =>
  result.checks.find((check) => name.test(check.name));

describe("a file that walks and buckets for itself", () => {
  it("says which paths it takes", async () => {
    const connection = await sqliteWithoutText.connect({ url: ":memory:" });
    expect(connection.capabilities.faster).toEqual(["walk", "buckets"]);
    expect(connection.capabilities.detail).toMatch(/walked and series are bucketed by the database/);
    await connection.close();
  });

  it("is held by the suite to the answers the verbs work out", async () => {
    const result = await conform(sqliteWithoutText, { url: ":memory:" });
    for (const name of [/walks relationships/, /buckets a series/]) {
      const check = named(result, name);
      expect(check, conformanceReport(result)).toMatchObject({ ok: true });
      expect(check?.skipped).toBeUndefined();
    }
    // It makes no ids of its own and constrains nothing, and says so by not saying so.
    expect(named(result, /makes ids/)?.skipped).toBe(true);
    expect(named(result, /two periods that overlap/)?.skipped).toBe(true);
  });

  /** The same writes to the file and to the backend that works everything out here. */
  async function both(): Promise<{ file: Connection; memory: Connection }> {
    return {
      file: await sqliteWithoutText.connect({ url: ":memory:" }),
      memory: await memoryDriver.connect({ url: "memory:" }),
    };
  }

  it("walks a tangled graph to the same nodes at the same depths", async () => {
    const { file, memory } = await both();
    expect(memory.capabilities.faster).toBeUndefined();

    // A deterministic tangle: cycles, hubs, two predicates, facts that have ended.
    const nodes = Array.from({ length: 14 }, (_, index) => `n${index}`);
    let seed = 7;
    const next = (): number => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648);
    for (const facts of [new Facts(file), new Facts(memory)]) {
      seed = 7;
      for (let i = 0; i < 40; i++) {
        const from = nodes[next() % nodes.length]!;
        const to = nodes[next() % nodes.length]!;
        const predicate = next() % 3 ? "links" : "cites";
        const ended = next() % 5 === 0;
        await facts.relate(from, predicate, to, {
          scope: "g",
          ...(ended ? { validFrom: 1_000, validTo: 2_000 } : {}),
        });
      }
    }

    const read = (found: Awaited<ReturnType<Facts["neighbors"]>>): string[] =>
      found.map((one) => `${one.node}@${one.depth}`).sort();
    let compared = 0;
    for (const from of ["n0", "n3", "n9"]) {
      for (const direction of ["out", "in", "both"] as const) {
        for (const depth of [1, 2, 3]) {
          for (const more of [{}, { predicate: "cites" }, { asOf: "ever" as const }, { asOf: 1_500 }]) {
            const options = { scope: "g", direction, depth, ...more };
            const here = await new Facts(file).neighbors(from, options);
            expect(read(here)).toEqual(read(await new Facts(memory).neighbors(from, options)));
            // Each node once, nearest first, and never the node the walk began at.
            expect(new Set(here.map((one) => one.node)).size).toBe(here.length);
            expect(here.map((one) => one.depth)).toEqual(here.map((one) => one.depth).sort());
            expect(here.map((one) => one.node)).not.toContain(from);
            compared++;
          }
        }
      }
    }
    expect(compared).toBe(108);
    await file.close();
    await memory.close();
  });

  it("does not walk through a fact that was taken back", async () => {
    const { file, memory } = await both();
    const facts = new Facts(file);
    await facts.relate("a", "to", "b");
    const middle = await facts.relate("b", "to", "c");
    expect((await facts.neighbors("a", { depth: 2 })).map((one) => one.node)).toEqual(["b", "c"]);
    await file.redact({ id: middle, limit: 1 }, "[taken back]", Date.now());
    expect((await facts.neighbors("a", { depth: 2 })).map((one) => one.node)).toEqual(["b"]);
    await file.close();
    await memory.close();
  });

  it("buckets a series to the same windows, before 1970 included", async () => {
    const { file, memory } = await both();
    const points = Array.from({ length: 200 }, (_, index) => ({
      at: -90_000 + index * 1_733,
      value: Math.round(Math.sin(index) * 1_000) / 10,
    }));
    await new Series(file).append("load", points);
    await new Series(memory).append("load", points);

    const how: Aggregate[] = ["mean", "min", "max", "sum", "count", "first", "last"];
    for (const aggregate of how) {
      for (const span of [{}, { from: -10_000, to: 120_000 }, { limit: 3 }]) {
        const options = { bucket: 15_000, aggregate, ...span };
        const here = await new Series(file).range("load", options);
        const there = await new Series(memory).range("load", options);
        expect(here.map((point) => point.at)).toEqual(there.map((point) => point.at));
        here.forEach((point, index) => expect(point.value).toBeCloseTo(there[index]!.value, 6));
      }
    }
    // A reading before the epoch is in the window before it, not the one after.
    const [first] = await new Series(file).range("load", { bucket: 15_000, aggregate: "count" });
    expect(first?.at).toBe(-90_000);
    await file.close();
    await memory.close();
  });

  it("leaves a width that is not whole milliseconds, and a redacted reading, to the rows", async () => {
    const { file, memory } = await both();
    const series = new Series(file);
    await series.append("s", [
      { at: 0, value: 1 },
      { at: 1, value: 3 },
      { at: 2, value: 100 },
    ]);
    expect(await series.range("s", { bucket: 1.5, aggregate: "sum" })).toEqual([
      { at: 0, value: 4 },
      { at: 1.5, value: 100 },
    ]);
    const [newest] = await file.list({ scope: "series:s", limit: 1 });
    await file.redact({ id: newest!.id, limit: 1 }, "[taken back]", Date.now());
    expect(await series.range("s", { bucket: 10, aggregate: "sum" })).toEqual([{ at: 0, value: 4 }]);
    // The newest row is no longer a reading, so the latest reading is the one before it.
    expect(await series.last("s")).toEqual({ at: 1, value: 3 });
    await file.close();
    await memory.close();
  });
});

describe("the latest reading of a series", () => {
  it("is one row asked for, not the series read through", async () => {
    const memory = await memoryDriver.connect({ url: "memory:" });
    const asked: number[] = [];
    const watched: Connection = {
      capabilities: memory.capabilities,
      install: () => memory.install(),
      put: (items, vectors) => memory.put(items, vectors),
      list: (window) => {
        asked.push(window.limit);
        return memory.list(window);
      },
      match: (terms, window) => memory.match(terms, window),
      near: (vector, window) => memory.near(vector, window),
      drop: (window) => memory.drop(window),
      redact: (window, note, at) => memory.redact(window, note, at),
      run: (sql, params) => memory.run(sql, params),
      transaction: (work) => memory.transaction(work),
      close: () => memory.close(),
    };
    const series = new Series(watched);
    await series.append("cpu", [
      { at: 1_000, value: 0.2 },
      { at: 2_000, value: 0.9 },
    ]);
    expect(await series.last("cpu")).toEqual({ at: 2_000, value: 0.9 });
    expect(asked).toEqual([1]);
    expect(await series.last("nothing here")).toBeUndefined();
    await memory.close();
  });
});

// ── A backend that claims a path it does not keep ──────────────────────────

describe("a claim the suite holds a backend to", () => {
  const claiming = (faster: Connection["capabilities"]["faster"], extra: Partial<Connection>): Driver => ({
    name: "claims",
    async connect(options) {
      const real = await memoryDriver.connect(options);
      return {
        capabilities: { ...real.capabilities, faster },
        install: () => real.install(),
        put: (items, vectors) => real.put(items, vectors),
        list: (window) => real.list(window),
        match: (terms, window) => real.match(terms, window),
        near: (vector, window) => real.near(vector, window),
        drop: (window) => real.drop(window),
        redact: (window, note, at) => real.redact(window, note, at),
        run: (sql, params) => real.run(sql, params),
        transaction: (work) => real.transaction(work),
        close: () => real.close(),
        ...extra,
      };
    },
  });

  it("skips what was not claimed, and says why", async () => {
    const result = await conform(memoryDriver, { url: "memory:" });
    expect(result.ok).toBe(true);
    expect(named(result, /walks relationships/)).toMatchObject({ skipped: true, why: expect.stringMatching(/worked out here/) });
  });

  it("fails a walk that reaches the wrong nodes", async () => {
    const result = await conform(claiming(["walk"], { walk: async () => [] }), { url: "memory:" });
    expect(named(result, /walks relationships/)).toMatchObject({ ok: false, why: expect.stringMatching(/reached nothing/) });
  });

  it("fails buckets that are not the verbs' buckets", async () => {
    const off = claiming(["buckets"], { buckets: async () => [{ at: 0, value: 42 }] });
    const result = await conform(off, { url: "memory:" });
    expect(named(result, /buckets a series/)).toMatchObject({ ok: false, why: expect.stringMatching(/came back 0=42/) });
  });

  it("fails a word with no method behind it", async () => {
    const result = await conform(claiming(["walk", "ids"], {}), { url: "memory:" });
    expect(named(result, /walks relationships/)?.why).toMatch(/declares "walk" and has no `walk`/);
    expect(named(result, /makes ids/)?.why).toMatch(/declares "ids" and has no `mint`/);
  });

  it("fails ids that repeat, and a constraint that does not refuse", async () => {
    const result = await conform(claiming(["ids", "validity"], { mint: async (count) => Array.from({ length: count }, () => "same") }), {
      url: "memory:",
    });
    expect(named(result, /makes ids/)).toMatchObject({ ok: false });
    expect(named(result, /two periods that overlap/)).toMatchObject({ ok: false });
  });
});

// ── Postgres: what it decides to write ─────────────────────────────────────

interface Said {
  sql: string;
  params: readonly unknown[];
}

const nothing: WireResult = { columns: [], rows: [] };

/** A Postgres that keeps no data and answers what it is: a version, and which extensions it has. */
function serverFor(shape: { version: number; gist?: boolean; timescale?: boolean; overlaps?: boolean }): Server & {
  said: Said[];
  sent(pattern: RegExp): Said[];
} {
  const said: Said[] = [];
  const answer = (sql: string, params: readonly unknown[]): WireResult => {
    said.push({ sql, params });
    if (/pg_extension/.test(sql)) {
      return { columns: [], rows: [[0, shape.timescale ? 1 : 0, 0, shape.gist ? 1 : 0, shape.version]] };
    }
    if (/to_regclass\(\$1\) IS NOT NULL/.test(sql)) return { columns: [], rows: [[true]] };
    if (/format_type/.test(sql)) return { columns: [], rows: [["bytea"]] };
    if (/indisprimary/.test(sql)) return { columns: [], rows: [["id"]] };
    if (/uuidv7\(\)/.test(sql)) {
      return { columns: [], rows: Array.from({ length: Number(params[0]) }, (_, index) => [`0198-${index}`]) };
    }
    if (shape.overlaps && /INSERT INTO praecise_fact_validity/.test(sql)) {
      throw Object.assign(new Error('conflicting key value violates exclusion constraint "praecise_fact_validity_once"'), {
        code: "23P01",
      });
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
    protocol: "3.2",
    said,
    sent: (pattern) => said.filter((one) => pattern.test(one.sql)),
  };
}

describe("a server, by what it turned out to be", () => {
  it("makes ids with uuidv7() and constrains validity on 18 with btree_gist", async () => {
    const server = serverFor({ version: 180_001, gist: true });
    const connection = await openPostgres(server, { url: "postgres://x/y" });
    expect(connection.capabilities.faster).toEqual(["walk", "buckets", "ids", "validity"]);
    expect(connection.capabilities.detail).toMatch(/ids are uuidv7\(\)/);
    expect(connection.capabilities.detail).toMatch(/WITHOUT OVERLAPS/);
    expect(connection.capabilities.detail).toMatch(/protocol 3\.2/);

    const [made] = server.sent(/CREATE TABLE IF NOT EXISTS praecise_fact_validity/);
    expect(made?.sql).toMatch(/valid\s+int8range NOT NULL/);
    expect(made?.sql).toMatch(/PRIMARY KEY \(scope, subject, predicate, object, valid WITHOUT OVERLAPS\)/);
    // Found, never installed: creating an extension is not this driver's call.
    expect(server.sent(/CREATE EXTENSION/)).toHaveLength(0);

    expect(await connection.mint?.(3)).toEqual(["0198-0", "0198-1", "0198-2"]);
    expect(server.sent(/uuidv7\(\)/)[0]?.params).toEqual([3]);
  });

  it("writes a fact's period beside the fact, in one piece of work, and nothing for a row that is not one", async () => {
    const server = serverFor({ version: 180_000, gist: true });
    const connection = await openPostgres(server, { url: "postgres://x/y" });
    server.said.length = 0;

    const facts = new Facts(connection);
    const id = await facts.relate("ada", "works at", "acme", { scope: "hr", validFrom: 1_000, validTo: 9_000 });
    const order = server.said.map((one) => one.sql.trim().split(/\s+/).slice(0, 3).join(" "));
    expect(order).toEqual(["BEGIN", "DELETE FROM praecise_fact_validity", "INSERT INTO praecise_fact_validity", "INSERT INTO praecise_items", "COMMIT"]);
    const [period] = server.sent(/INSERT INTO praecise_fact_validity/);
    expect(period?.sql).toMatch(/int8range\(\$6::bigint, \$7::bigint, '\[\)'\)/);
    expect(period?.params).toEqual([id, "facts:hr", "ada", "works at", "acme", 1_000, 9_000]);

    server.said.length = 0;
    await connection.put([{ id: "plain", text: "not a fact", at: 1 }], [undefined]);
    expect(server.sent(/INSERT INTO praecise_fact_validity/)).toHaveLength(0);
    expect(server.sent(/DELETE FROM praecise_fact_validity/)).toHaveLength(1);

    // Forgetting and taking back let the period go first.
    server.said.length = 0;
    await connection.drop({ scope: "facts:hr", limit: -1 });
    await connection.redact({ id, limit: 1 }, "[taken back]", 5);
    expect(server.sent(/DELETE FROM praecise_fact_validity WHERE id IN\s+\(SELECT id FROM praecise_items/)).toHaveLength(2);
  });

  it("says what to do when the constraint refuses a fact, and keeps nothing of it", async () => {
    const server = serverFor({ version: 180_000, gist: true, overlaps: true });
    const connection = await openPostgres(server, { url: "postgres://x/y" });
    server.said.length = 0;
    await expect(new Facts(connection).relate("ada", "works at", "acme", { validFrom: 5_000 })).rejects.toThrow(
      /already recorded as true over a period that overlaps.*unrelate/,
    );
    expect(server.sent(/INSERT INTO praecise_items/)).toHaveLength(0);
    expect(server.said.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("leaves validity alone on 18 without btree_gist, and says the one statement that would change it", async () => {
    const server = serverFor({ version: 180_000 });
    const connection = await openPostgres(server, { url: "postgres://x/y" });
    expect(connection.capabilities.faster).toEqual(["walk", "buckets", "ids"]);
    expect(connection.capabilities.detail).toMatch(/CREATE EXTENSION btree_gist/);
    expect(server.sent(/praecise_fact_validity/)).toHaveLength(0);
  });

  it("makes ids here and constrains nothing before 18", async () => {
    const server = serverFor({ version: 170_004, gist: true });
    const connection = await openPostgres(server, { url: "postgres://x/y" });
    expect(connection.capabilities.faster).toEqual(["walk", "buckets"]);
    expect(connection.mint).toBeUndefined();
    expect(connection.capabilities.detail).toMatch(/arrive with PostgreSQL 18; this is 17/);
    expect(server.sent(/uuidv7|praecise_fact_validity/)).toHaveLength(0);
  });

  it("buckets by arithmetic, and by time_bucket only where the extension was found", async () => {
    const plain = serverFor({ version: 170_000 });
    await (await openPostgres(plain, { url: "postgres://x/y" })).buckets?.({ scope: "series:cpu", width: 60_000, aggregate: "mean" });
    const [byHand] = plain.sent(/GROUP BY bucket/);
    expect(byHand?.sql).toMatch(/at - \(\(\(at % \$1\) \+ \$2\) % \$3\) AS bucket/);
    expect(byHand?.sql).not.toMatch(/time_bucket/);
    expect(byHand?.params).toEqual([60_000, 60_000, 60_000, "series:cpu"]);

    const timescale = serverFor({ version: 170_000, timescale: true });
    const connection = await openPostgres(timescale, { url: "postgres://x/y" });
    await connection.buckets?.({ scope: "series:cpu", width: 60_000, aggregate: "last", from: 0, to: 10 });
    const [bucketed] = timescale.sent(/GROUP BY bucket/);
    expect(bucketed?.sql).toMatch(/time_bucket\(\$1::bigint, at\) AS bucket/);
    expect(bucketed?.sql).toMatch(/\(array_agg\(v ORDER BY at DESC\)\)\[1\]/);
    expect(bucketed?.params).toEqual([60_000, "series:cpu", 0, 10]);
    expect(connection.capabilities.detail).toMatch(/\(time_bucket\)/);
  });

  it("walks with one recursive statement and bound values only", async () => {
    const server = serverFor({ version: 170_000 });
    const connection = await openPostgres(server, { url: "postgres://x/y" });
    await new Facts(connection).neighbors("ada's \"node\"; DROP TABLE x", { scope: "s", depth: 9, predicate: "knows", direction: "both" });
    const [walk] = server.sent(/WITH RECURSIVE/);
    expect(walk?.sql).toMatch(/JOIN edges e ON e\.here = r\.node WHERE r\.depth < \$/);
    // Nothing a caller typed is in the statement, and the depth was clamped to three.
    expect(walk?.sql).not.toMatch(/DROP TABLE/);
    expect(walk?.params).toContain('ada\'s "node"; DROP TABLE x');
    expect(walk?.params).toContain(3);
    expect(server.sent(/CREATE INDEX IF NOT EXISTS praecise_items_(subject|object)/)).toHaveLength(2);
  });

  it("writes the same statements for both dialects but for the two things that differ", () => {
    const walk = walkStatement(POSTGRES_DIALECT, { scope: "s", from: "a", depth: 2, direction: "out", at: 5 });
    expect(walk.sql).toMatch(/\(meta->>'validFrom'\)::float8 <= \$2/);
    expect(walk.params).toEqual(["s", 5, 5, "a", 2, "a"]);
    const buckets = bucketStatement(POSTGRES_DIALECT, { scope: "s", width: 10, aggregate: "count" });
    expect(buckets.sql).toMatch(/COUNT\(\*\)/);
    expect(buckets.sql).toMatch(/jsonb_typeof\(meta->'value'\) = 'number'/);
  });
});

// ── Postgres, for real, where there is one ─────────────────────────────────

const URL_ =
  process.env.PRAECISE_TEST_POSTGRES ??
  `postgres://${process.env.USER ?? "postgres"}@localhost:5432/praecise_wire_test`;

const reachable = await postgresDriver
  .connect({ url: URL_ })
  .then(async (connection) => {
    await connection.close();
    return true;
  })
  .catch(() => false);

describe.skipIf(!reachable)("a real server, walking and bucketing for itself", () => {
  it("keeps every promise, the faster paths among them", async () => {
    const result = await conform(postgresDriver, { url: URL_ });
    for (const name of [/walks relationships/, /buckets a series/]) {
      expect(named(result, name), conformanceReport(result)).toMatchObject({ ok: true });
      expect(named(result, name)?.skipped).toBeUndefined();
    }
    // Whatever this server turned out to be, nothing it claimed is left unkept.
    const claimed = result.checks.filter((check) => /makes ids|two periods that overlap/.test(check.name));
    expect(claimed.every((check) => check.ok), conformanceReport(result)).toBe(true);
  });

  it("uses what a server from 18 has, and only then", async () => {
    const connection = await postgresDriver.connect({ url: URL_ });
    const version = Number((await connection.run("SELECT current_setting('server_version_num')::int")).rows[0]?.[0]);
    const faster = connection.capabilities.faster ?? [];
    expect(faster.includes("ids")).toBe(version >= 180_000);
    if (faster.includes("ids")) {
      const [first, second] = (await connection.mint?.(2)) ?? [];
      expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
      // Version 7 puts the time first, so ids made later sort later.
      expect(first! < second!).toBe(true);
    }
    await connection.close();
  });

  it("settles on 3.2 with a server that speaks it, and on 3.0 with one that does not", async () => {
    const wire = await Wire.open({ ...wireOptionsFrom(URL_), protocol: "3.2" });
    const version = Number((await wire.query("SELECT current_setting('server_version_num')::int")).rows[0]?.[0]);
    expect(wire.protocol).toBe(version >= 180_000 ? "3.2" : "3.0");
    expect((await wire.query("SELECT 1")).rows).toEqual([[1]]);
    await wire.close();
  });
});

// ── The wire: which version a connection settles on ────────────────────────

interface Opening {
  version: number;
  cancel?: { pid: number; key: Buffer };
}

/** A socket that speaks the opening of the protocol: startup, a key, and ready. */
function opener(shape: { newest?: number; key: Buffer }): Promise<{ server: NetServer; port: number; seen: Opening[] }> {
  const seen: Opening[] = [];
  const message = (type: string, body: Buffer): Buffer => {
    const head = Buffer.alloc(5);
    head.write(type, 0, "latin1");
    head.writeInt32BE(body.length + 4, 1);
    return Buffer.concat([head, body]);
  };
  const int32 = (...values: number[]): Buffer => {
    const out = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => out.writeInt32BE(value, index * 4));
    return out;
  };

  const server = createServer((socket: Socket) => {
    socket.once("data", (chunk: Buffer) => {
      const code = chunk.readInt32BE(4);
      if (code === 80_877_102) {
        seen.push({ version: code, cancel: { pid: chunk.readInt32BE(8), key: Buffer.from(chunk.subarray(12, chunk.readInt32BE(0))) } });
        socket.end();
        return;
      }
      seen.push({ version: code });
      const asked = code & 0xffff;
      const replies: Buffer[] = [];
      // A server that speaks less than it was asked for says what it does speak.
      if (shape.newest !== undefined && asked > shape.newest) replies.push(message("v", int32(shape.newest, 0)));
      replies.push(message("R", int32(0)));
      replies.push(message("K", Buffer.concat([int32(4242), shape.key])));
      replies.push(message("Z", Buffer.from("I")));
      socket.write(Buffer.concat(replies));
    });
    socket.on("error", () => undefined);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address ? address.port : 0, seen });
    });
  });
}

describe("which protocol version a connection settles on", () => {
  const servers: NetServer[] = [];
  afterAll(() => {
    for (const server of servers) server.close();
  });
  const base = (port: number) => ({
    host: "127.0.0.1",
    port,
    user: "sam",
    database: "app",
    ssl: "disable" as const,
    timeoutMs: 2_000,
  });

  let longKey: Buffer;
  beforeAll(() => {
    longKey = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1));
  });

  it("asks for 3.0 unless told otherwise, as the server's own client does", async () => {
    const { server, port, seen } = await opener({ key: Buffer.from([1, 2, 3, 4]) });
    servers.push(server);
    const wire = await Wire.open(base(port));
    expect(seen[0]?.version).toBe(196_608);
    expect(wire.protocol).toBe("3.0");
    await wire.close();
    expect(wireOptionsFrom("postgres://localhost/app").protocol).toBe("3.0");
  });

  it("asks for 3.2 when the url says so, and keeps a key longer than four bytes", async () => {
    expect(wireOptionsFrom("postgres://localhost/app?max_protocol_version=3.2").protocol).toBe("3.2");
    expect(wireOptionsFrom("postgres://localhost/app?max_protocol_version=latest").protocol).toBe("3.2");
    expect(() => wireOptionsFrom("postgres://localhost/app?max_protocol_version=4")).toThrow(/not a max_protocol_version/);

    const { server, port, seen } = await opener({ key: longKey });
    servers.push(server);
    const wire = await Wire.open({ ...base(port), protocol: "3.2" });
    expect(seen[0]?.version).toBe(196_610);
    expect(wire.protocol).toBe("3.2");

    // The key it was given is the key it cancels with, all thirty-two bytes of it.
    await wire.cancel();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen[1]?.cancel?.pid).toBe(4242);
    expect(seen[1]?.cancel?.key.equals(longKey)).toBe(true);
    await wire.close();
  });

  it("goes on at 3.0 with a server that answers it speaks nothing newer", async () => {
    const { server, port, seen } = await opener({ newest: 0, key: Buffer.from([9, 9, 9, 9]) });
    servers.push(server);
    const wire = await Wire.open({ ...base(port), protocol: "3.2" });
    expect(seen[0]?.version).toBe(196_610);
    expect(wire.protocol).toBe("3.0");
    await wire.close();
  });
});
