/**
 * The protocol client, against a real server where there is one.
 *
 * Everything here that needs a database is skipped when none is reachable, so
 * the suite runs anywhere. That is a real gap and not a hidden one: the parsing
 * below always runs, and the rest says plainly that it did not.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openStore } from "../src/stores/index.js";
import { Kept } from "../src/stores/store.js";
import { postgresDriver } from "../src/stores/postgres.js";
import type { Connection, Store } from "../src/stores/types.js";
import { wireOptionsFrom } from "../src/stores/wire.js";

describe("reading a connection string", () => {
  it("takes every part a socket needs", () => {
    const options = wireOptionsFrom("postgres://sam:hunter2@db.internal:6543/ledger?sslmode=require");
    expect(options).toMatchObject({
      host: "db.internal",
      port: 6543,
      user: "sam",
      password: "hunter2",
      database: "ledger",
      ssl: "require",
    });
  });

  it("fills in what was left out", () => {
    expect(wireOptionsFrom("postgres://localhost/")).toMatchObject({
      host: "localhost",
      port: 5432,
      user: "postgres",
      database: "postgres",
      password: undefined,
      ssl: "prefer",
    });
  });

  it("unescapes a password that had to be escaped", () => {
    const options = wireOptionsFrom("postgres://sam:p%40ss%3Aword@localhost/app");
    expect(options.password).toBe("p@ss:word");
  });

  it("refuses an ssl setting that means nothing", () => {
    expect(() => wireOptionsFrom("postgres://localhost/app?sslmode=maybe")).toThrow(/not an sslmode/);
  });
});

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

describe.skipIf(!reachable)("a store on the wire", () => {
  let connection: Connection;
  let store: Store;

  beforeAll(async () => {
    connection = await postgresDriver.connect({ url: URL_ });
    store = new Kept("main", "sql", connection);
  });

  afterAll(async () => {
    await store?.close();
  });

  it("keeps scope, meta and time across a round trip", async () => {
    await store.forget({});
    const at = Date.now();
    await store.remember({ id: "one", text: "hello", scope: "acme", meta: { ticket: 4021 }, at });
    const [item] = await store.history();
    expect(item).toMatchObject({ id: "one", text: "hello", scope: "acme", at });
    expect(item?.meta).toEqual({ ticket: 4021 });
  });

  it("searches through the index the database maintains", async () => {
    await store.forget({});
    await store.remember([
      { text: "the refund policy allows fourteen days" },
      { text: "shipping usually takes three days" },
    ]);
    const found = await store.search("refund");
    expect(found.map((item) => item.text)).toEqual(["the refund policy allows fourteen days"]);
  });

  it("treats what a caller types as words, not as operators", async () => {
    await store.forget({});
    await store.remember({ text: "order 4021 was cancelled" });
    const found = await store.search("order & | ! 4021 :*");
    expect(found).toHaveLength(1);
  });

  it("replaces rather than duplicates, index included", async () => {
    await store.forget({});
    await store.remember({ id: "one", text: "before" });
    await store.remember({ id: "one", text: "after" });
    expect(await store.history()).toHaveLength(1);
    expect(await store.search("before")).toHaveLength(0);
    expect(await store.search("after")).toHaveLength(1);
  });

  it("ranks by nearness when given a vector", async () => {
    await store.forget({});
    await store.remember([
      { id: "near", text: "close", vector: [1, 0, 0] },
      { id: "side", text: "orthogonal", vector: [0, 1, 0] },
      { id: "none", text: "no vector at all" },
    ]);
    const found = await store.recall([1, 0, 0]);
    expect(found.map((item) => item.id)).toEqual(["near", "side"]);
    expect(found[0]!.score).toBeCloseTo(1, 5);
  });

  it("undoes everything in a transaction that fails", async () => {
    await store.forget({});
    await expect(
      connection.transaction(async () => {
        await connection.put([{ id: "gone", text: "rolled back", at: Date.now() }], [undefined]);
        throw new Error("no");
      }),
    ).rejects.toThrow("no");
    expect(await store.history()).toHaveLength(0);
  });

  it("lets an inner failure roll back without taking the outer with it", async () => {
    await store.forget({});
    await connection.transaction(async () => {
      await connection.put([{ id: "outer", text: "kept", at: Date.now() }], [undefined]);
      await connection
        .transaction(async () => {
          await connection.put([{ id: "inner", text: "not kept", at: Date.now() }], [undefined]);
          throw new Error("inner");
        })
        .catch(() => undefined);
    });
    expect((await store.history()).map((item) => item.id)).toEqual(["outer"]);
  });

  it("passes the author's own SQL through with its values bound", async () => {
    await store.forget({});
    await store.remember({ id: "one", text: "counted", scope: "acme" });
    const result = await store.query(
      "SELECT count(*)::int AS n FROM praecise_items WHERE scope = $1",
      ["acme"],
    );
    expect(result.columns).toEqual(["n"]);
    expect(result.rows).toEqual([[1]]);
  });

  it("surfaces what the database said and stays usable afterwards", async () => {
    await expect(store.query("SELECT * FROM nothing_of_the_sort")).rejects.toThrow(/does not exist/);
    await expect(store.history()).resolves.toBeInstanceOf(Array);
  });

  it("serialises work rather than interleaving it on one connection", async () => {
    await store.forget({});
    await store.remember(Array.from({ length: 5 }, (_, index) => ({ text: `note ${index}` })));
    const answers = await Promise.all([
      store.history({ limit: 1 }),
      store.history({ limit: 3 }),
      store.search("note"),
    ]);
    expect(answers.map((rows) => rows.length)).toEqual([1, 3, 5]);
  });
});

/**
 * What the server turned out to be, asked of a server.
 *
 * The catalogue questions this driver now opens with — is `vector` installed,
 * is `timescaledb`, what type is that column really, what is the primary key
 * over — are checked against a fake elsewhere, and a fake cannot tell you
 * whether they parse. These can, and they do not assume which extensions the
 * server has: what is asserted is that the driver reached a conclusion, that it
 * said which one, and that whichever path it took gives the right answers.
 */
describe.skipIf(!reachable)("what a real server can do", () => {
  it("settles on a path for vectors and says which, in terms of what to do next", async () => {
    const connection = await postgresDriver.connect({ url: URL_, of: "vector", dimensions: 4 });
    try {
      const can = connection.capabilities;
      expect(can.vectors).toBe(true);
      expect(can.vectorSearch === "index" || can.vectorSearch === "scan").toBe(true);
      expect(can.detail).toBeTruthy();
      expect(can.detail).toMatch(
        can.vectorSearch === "index" ? /ordered by the database/ : /CREATE EXTENSION vector/,
      );
    } finally {
      await connection.close();
    }
  });

  it("ranks by nearness whichever path it settled on", async () => {
    const connection = await postgresDriver.connect({ url: URL_, of: "vector", dimensions: 4 });
    const store = new Kept("main", "vector", connection);
    try {
      await store.forget({});
      await store.remember([
        { id: "near", text: "close", vector: [1, 0, 0, 0] },
        { id: "side", text: "orthogonal", vector: [0, 1, 0, 0] },
      ]);
      const found = await store.recall([1, 0, 0, 0], { limit: 5 });
      expect(found.map((item) => item.id)).toEqual(["near", "side"]);
      expect(found[0]!.score).toBeCloseTo(1, 5);
      // The same reading on both paths, so a threshold survives the move.
      expect(found[1]!.score).toBeCloseTo(0.5, 5);
    } finally {
      await store.close();
    }
  });

  it("says what partitioning by time would take on this server", async () => {
    const connection = await postgresDriver.connect({ url: URL_, of: "timeseries" });
    try {
      expect(connection.capabilities.detail).toMatch(
        /partitioned into weekly chunks|time is a plain indexed column/,
      );
    } finally {
      await connection.close();
    }
  });

  it("refuses a graph against a table of rows, on a server that really has one", async () => {
    await expect(
      openStore("relations", { kind: "store", of: "graph", url: URL_ }, { stateDir: "/x" }),
    ).rejects.toThrow(/serves sql, vector, document, timeseries/);
  });
});

if (!reachable) {
  // eslint-disable-next-line no-console
  console.warn(`no database at ${URL_} — the protocol client went untested against a real one`);
}
