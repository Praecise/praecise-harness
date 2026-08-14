/**
 * The five families a store may declare, against the ones anything here can
 * actually serve.
 *
 * `of` used to be decoration. `of: "graph"` against a `postgres://` url got the
 * same table of text and json as everything else, the word survived only into a
 * prompt, and nothing anywhere said that what came back was not a graph. These
 * are the tests for the two halves of the fix: a declaration a backend cannot
 * honour is refused where it is opened, and a backend that makes no claim about
 * what it serves is still held to nothing — because a driver written before
 * there was anything to say is not wrong for not having said it.
 */

import { describe, expect, it } from "vitest";

import { EXTENSION_ENV, openStore, Stores } from "../src/stores/index.js";
import { memoryDriver } from "../src/stores/memory.js";
import type { Capabilities, Connection, ConnectOptions, Driver } from "../src/stores/types.js";

/** A backend from outside, with whatever opinion of itself a test needs. */
function brought(
  name: string,
  says: Partial<Capabilities> = {},
): Driver & { seen?: ConnectOptions; closed: number } {
  const driver = {
    name,
    closed: 0,
    seen: undefined as ConnectOptions | undefined,
    async connect(options: ConnectOptions): Promise<Connection> {
      driver.seen = options;
      const connection = await memoryDriver.connect(options);
      return Object.assign(Object.create(connection) as Connection, {
        capabilities: { ...connection.capabilities, ...says },
        close: async () => {
          driver.closed++;
          await connection.close();
        },
      });
    },
  };
  return driver;
}

describe("a family a backend cannot serve", () => {
  it("is refused where the store is opened, not where an agent asks", async () => {
    await expect(
      openStore("relations", { kind: "store", of: "graph", url: "memory:" }, { stateDir: "/x" }),
    ).rejects.toThrow(/of: "graph"/);
  });

  it("names what is served, so the refusal is a fact and not an opinion", async () => {
    const refused = await openStore(
      "relations",
      { kind: "store", of: "graph", url: ":memory:" },
      { stateDir: "/x" },
    ).then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(refused?.message).toMatch(/sqlite backend/);
    expect(refused?.message).toMatch(/serves sql, vector, document, timeseries/);
    // And what to do instead, which is the half a refusal usually leaves out.
    expect(refused?.message).toMatch(/Driver/);
    expect(refused?.message).toMatch(/Neo4j/);
  });

  it("refuses a vector store against a backend holding no vectors", async () => {
    const driver = brought("elsewhere", { vectors: false, serves: undefined });
    await expect(
      openStore(
        "embeddings",
        { kind: "store", of: "vector", url: "elsewhere://host/db", dimensions: 8 },
        { stateDir: "/x", drivers: [driver] },
      ),
    ).rejects.toThrow(/holds no vectors at all/);
  });

  it("does not leave the connection it refused open behind it", async () => {
    const driver = brought("elsewhere", { serves: ["sql"] });
    await openStore(
      "relations",
      { kind: "store", of: "graph", url: "elsewhere://host/db" },
      { stateDir: "/x", drivers: [driver] },
    ).catch(() => undefined);
    expect(driver.closed).toBe(1);
  });

  it("comes back through the app's own way of opening one", async () => {
    const stores = new Stores(
      { relations: { kind: "store", of: "graph", url: "memory:" } },
      { stateDir: "/x" },
    );
    await expect(stores.open("relations")).rejects.toThrow(/graph/);
    await stores.close();
  });
});

describe("a backend that makes no claim", () => {
  it("is held to none of them", async () => {
    // Every `Driver` written before `serves` existed says nothing about it, and
    // refusing those would be this framework breaking its own extension point.
    const driver = brought("elsewhere", { serves: undefined });
    const store = await openStore(
      "papers",
      { kind: "store", of: "document", url: "elsewhere://host/db" },
      { stateDir: "/x", drivers: [driver] },
    );
    expect(store.of).toBe("document");
    await store.remember({ text: "kept anyway" });
    expect((await store.history())[0]?.text).toBe("kept anyway");
    await store.close();
  });

  it("is refused only for what its capabilities do say", async () => {
    const driver = brought("elsewhere", { serves: undefined, vectors: false });
    const store = await openStore(
      "papers",
      { kind: "store", of: "document", url: "elsewhere://host/db" },
      { stateDir: "/x", drivers: [driver] },
    );
    await store.close();
    expect(driver.closed).toBe(1);
  });
});

describe("what the declaration reaches", () => {
  it("hands the family to the driver, which used to know only the url", async () => {
    const driver = brought("elsewhere");
    const store = await openStore(
      "readings",
      { kind: "store", of: "timeseries", url: "elsewhere://host/db", dimensions: 16 },
      { stateDir: "/x", drivers: [driver] },
    );
    expect(driver.seen?.of).toBe("timeseries");
    expect(driver.seen?.dimensions).toBe(16);
    await store.close();
  });

  it("hands an extension only to the backend that can load one", async () => {
    const driver = brought("elsewhere");
    const store = await openStore(
      "papers",
      { kind: "store", of: "sql", url: "elsewhere://host/db" },
      { stateDir: "/x", drivers: [driver], env: { [EXTENSION_ENV]: "/opt/vec0.so" } },
    );
    expect(driver.seen?.extension).toBeUndefined();
    await store.close();
  });

  it("hands it to the one that can, and says what became of it", async () => {
    const store = await openStore(
      "papers",
      { kind: "store", of: "vector", url: ":memory:", dimensions: 4 },
      { stateDir: "/x", env: { [EXTENSION_ENV]: "/nowhere/not-a-real-build" } },
    );
    expect(store.capabilities.detail).toMatch(/did not load/);
    await store.close();
  });
});

describe("what each backend says it is", () => {
  const shipped: [string, string][] = [
    ["a file", ":memory:"],
    ["nothing past the process", "memory:"],
  ];

  for (const [what, url] of shipped) {
    it(`answers for four families and not the fifth (${what})`, async () => {
      const store = await openStore(
        "kept",
        { kind: "store", of: "sql", url },
        { stateDir: "/x" },
      );
      const can = store.capabilities;
      expect(can.serves).toEqual(["sql", "vector", "document", "timeseries"]);
      expect(can.serves).not.toContain("graph");
      await store.close();
    });

    it(`says where its vectors are compared (${what})`, async () => {
      const store = await openStore(
        "kept",
        { kind: "store", of: "vector", url, dimensions: 4 },
        { stateDir: "/x" },
      );
      expect(store.capabilities.vectorSearch).toBe("scan");
      expect(store.capabilities.detail).toBeTruthy();
      await store.close();
    });
  }

  it("still compares vectors exactly the way it did before there was a choice", async () => {
    // The fallback is the path nearly every adopter is on. It is not allowed to
    // move by a decimal place because a faster one now exists beside it.
    const store = await openStore(
      "kept",
      { kind: "store", of: "vector", url: ":memory:", dimensions: 4 },
      { stateDir: "/x" },
    );
    await store.remember([
      { id: "near", text: "close", vector: [1, 0, 0, 0] },
      { id: "side", text: "orthogonal", vector: [0, 1, 0, 0] },
      { id: "away", text: "opposite", vector: [-1, 0, 0, 0] },
    ]);
    const found = await store.recall([1, 0, 0, 0], { limit: 5 });
    expect(found.map((one) => one.id)).toEqual(["near", "side"]);
    expect(found[0]!.score).toBeCloseTo(1, 5);
    expect(found[1]!.score).toBeCloseTo(0.5, 5);
    await store.close();
  });

  it("declares a family in the same words the type does", async () => {
    // `serves` is read against `StoreKind`, so a driver cannot quietly answer
    // for something that is not one of the five.
    const store = await openStore(
      "kept",
      { kind: "store", of: "sql", url: "memory:" },
      { stateDir: "/x" },
    );
    const families = ["sql", "vector", "document", "graph", "timeseries"];
    for (const one of store.capabilities.serves ?? []) expect(families).toContain(one);
    await store.close();
  });
});
