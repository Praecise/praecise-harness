/**
 * The suite that says whether a backend behaves like one.
 *
 * Two things are being tested here and they pull in opposite directions. The
 * backends that ship have to pass, which is the easy half. The harder half is
 * that the suite has to fail — a conformance suite that everything passes has
 * told you nothing, and the way that happens is a check that reads state it
 * wrote through the same code path that was supposed to be under test. So each
 * of the promises worth breaking is broken here on purpose, and the suite is
 * expected to name it.
 */

import { describe, expect, it } from "vitest";

import { conform, conformanceReport } from "../src/stores/conform.js";
import { memoryDriver } from "../src/stores/memory.js";
import { sqliteDriver } from "../src/stores/sqlite.js";
import type { Connection, Driver, Item, Ranked, Window } from "../src/stores/types.js";

/** The failing checks, by name, which is what a broken driver should be told. */
async function broken(driver: Driver): Promise<string[]> {
  const result = await conform(driver, { url: "memory:" });
  return result.checks.filter((check) => !check.ok).map((check) => check.name);
}

/**
 * The shipped in-memory backend, with one promise taken away.
 *
 * Everything is forwarded by hand rather than spread over the connection: a
 * spread copies what a class instance owns and none of what its prototype
 * carries, so the result would be a connection with no methods on it at all —
 * which is a failure, but not the one being staged.
 */
function bent(change: (connection: Connection) => Partial<Connection>): Driver {
  return {
    name: "bent",
    async connect(options) {
      const real = await memoryDriver.connect(options);
      const forwarded: Connection = {
        capabilities: real.capabilities,
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
      };
      return { ...forwarded, ...change(forwarded) };
    },
  };
}

describe("the backends that ship", () => {
  it("keeps every promise, in memory", async () => {
    const result = await conform(memoryDriver, { url: "memory:" });
    expect(conformanceReport(result)).toContain("behaves like a store");
    expect(result.ok).toBe(true);
  });

  it("keeps every promise, in a file", async () => {
    const result = await conform(sqliteDriver, { url: ":memory:" });
    expect(conformanceReport(result)).toContain("behaves like a store");
    expect(result.ok).toBe(true);
  });

  it("checks the same promises of both, so neither is graded easily", async () => {
    const held = await conform(memoryDriver, { url: "memory:" });
    const filed = await conform(sqliteDriver, { url: ":memory:" });
    expect(held.checks.map((check) => check.name)).toEqual(
      filed.checks.map((check) => check.name),
    );
  });

  it("says what it did not check, rather than passing it in silence", async () => {
    // A backend that holds no vectors is not failing anything by not holding
    // them, but a run that quietly drops the check reads as a clean sheet.
    const flat = bent((connection) => ({
      capabilities: { ...connection.capabilities, vectors: false },
    }));
    const result = await conform(flat, { url: "memory:" });
    const skipped = result.checks.filter((check) => check.skipped);
    expect(skipped.length).toBeGreaterThan(0);
    expect(conformanceReport(result)).toContain("this backend holds no vectors");
    expect(result.ok).toBe(true);
  });
});

describe("what the suite catches", () => {
  it("a redaction that deletes the row instead of taking back what it said", async () => {
    const deletes = bent((connection) => ({
      async redact(window: Window) {
        return connection.drop(window);
      },
    }));
    expect(await broken(deletes)).toContain("a redaction leaves the row where it was");
  });

  it("a redaction that leaves the vector it could still be found by", async () => {
    const keepsVector = bent((connection) => ({
      async redact(window: Window, note: string, at: number) {
        const rows = await connection.list({ ...window, limit: -1 });
        await connection.put(
          rows.map((row) => ({ ...row, text: note, redactedAt: at })),
          rows.map(() => [1, 0, 0, 0]),
        );
        return rows.length;
      },
    }));
    expect(await broken(keepsVector)).toContain(
      "a redaction clears the vector along with the text",
    );
  });

  it("a backend that hands over the row it is holding", async () => {
    const shares = bent((connection) => {
      const held: Item[] = [];
      return {
        async put(items: Item[], vectors: (number[] | undefined)[]) {
          held.push(...items);
          return connection.put(items, vectors);
        },
        async list(window: Window) {
          const rows = await connection.list(window);
          // The same objects, which is what a driver that forgot to copy does.
          return rows.map((row) => held.find((one) => one.id === row.id) ?? row);
        },
      };
    });
    expect(await broken(shares)).toContain("does not hand over the row it is holding");
  });

  it("a limit that is not honoured", async () => {
    const generous = bent((connection) => ({
      async list(window: Window) {
        return connection.list({ ...window, limit: -1 });
      },
    }));
    expect(await broken(generous)).toContain("gives no more than it was asked for");
  });

  it("an order that is oldest first", async () => {
    const backwards = bent((connection) => ({
      async list(window: Window) {
        return (await connection.list(window)).reverse();
      },
    }));
    expect(await broken(backwards)).toContain("hands back the newest first");
  });

  it("a scope that does not narrow anything", async () => {
    const leaky = bent((connection) => ({
      async list(window: Window) {
        return connection.list({ ...window, scope: undefined });
      },
    }));
    expect(await broken(leaky)).toContain("narrows to one scope and shows nothing of another");
  });

  it("an id written twice that lands twice", async () => {
    const doubles = bent((connection) => ({
      async put(items: Item[], vectors: (number[] | undefined)[]) {
        return connection.put(
          items.map((item) => ({ ...item, id: `${item.id}-${Math.random()}` })),
          vectors,
        );
      },
    }));
    expect(await broken(doubles)).toContain(
      "keeping the same id twice replaces rather than doubles",
    );
  });

  it("a transaction that does not undo what failed inside it", async () => {
    const forgetful = bent(() => ({
      async transaction<T>(work: () => Promise<T>): Promise<T> {
        return work();
      },
    }));
    expect(await broken(forgetful)).toContain("undoes a transaction that did not finish");
  });

  it("a claim to hold vectors that comes to nothing", async () => {
    const boastful = bent(() => ({
      async near(): Promise<Ranked[]> {
        return [];
      },
    }));
    expect(await broken(boastful)).toContain("orders by distance when asked with a vector");
  });

  it("reads as a list of what is still owed", async () => {
    const useless = bent(() => ({
      async list(): Promise<Item[]> {
        return [];
      },
    }));
    const result = await conform(useless, { url: "memory:" });
    expect(result.ok).toBe(false);
    expect(conformanceReport(result)).toContain("promises not kept");
    // The point of a failure line is that it can be read by somebody holding a
    // half-written backend, so it says what was expected, not what compared.
    const failed = result.checks.find((check) => !check.ok);
    expect(failed?.why).toBeTruthy();
  });
});

describe("a store that keeps nothing", () => {
  it("is reachable as a url, so an example needs no file and no cleanup", async () => {
    const connection = await memoryDriver.connect({ url: "memory:" });
    expect(connection.capabilities.vectors).toBe(true);
    expect(connection.capabilities.fullText).toBe(false);
    await connection.close();
  });

  it("says it has no query language rather than inventing one", async () => {
    const connection = await memoryDriver.connect({ url: "memory:" });
    await expect(connection.run("SELECT 1")).rejects.toThrow(/no query language/);
    await connection.close();
  });

  it("refuses to change anything when it was opened read-only", async () => {
    const connection = await memoryDriver.connect({ url: "memory:", readOnly: true });
    await expect(connection.put([{ id: "a", text: "a", at: 1 }], [undefined])).rejects.toThrow(
      /read-only/,
    );
    await connection.close();
  });
});
