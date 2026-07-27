import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { App } from "../src/app.js";
import {
  Kept,
  Stores,
  asObjects,
  memoryDriver,
  openStore,
  sqliteDriver,
  urlFor,
} from "../src/stores/index.js";
import type { Connection, Driver, Store } from "../src/stores/types.js";
import { cleanup, FRAMEWORK, makeProject, MODEL_ENV, stubModel, TEST_MODELS } from "./helpers.js";

const roots: string[] = [];
const open: Store[] = [];

/** A store whose url is explicit, so nothing touches the state directory. */
async function inMemory(of: "sql" | "vector" = "sql"): Promise<Store> {
  const store = await openStore("kept", { kind: "store", of, url: ":memory:" }, { stateDir: "/nowhere" });
  open.push(store);
  return store;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((store) => store.close().catch(() => undefined)));
  await Promise.all(roots.splice(0).map(cleanup));
});

const DAY = 24 * 60 * 60 * 1000;

describe("a store's four verbs", () => {
  it("remembers and hands back the ids it kept under", async () => {
    const store = await inMemory();
    const ids = await store.remember([{ text: "first" }, { text: "second", id: "mine" }]);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe("mine");

    const seen = await store.history();
    expect(seen.map((item) => item.text).sort()).toEqual(["first", "second"]);
  });

  it("keeps scope and meta across a round trip", async () => {
    const store = await inMemory();
    await store.remember({ text: "hello", scope: "thread-1", meta: { ticket: 4021 } });
    const [item] = await store.history({ scope: "thread-1" });
    expect(item?.scope).toBe("thread-1");
    expect(item?.meta).toEqual({ ticket: 4021 });
  });

  it("hands back history newest first", async () => {
    const store = await inMemory();
    const now = Date.now();
    await store.remember([
      { text: "oldest", at: now - 2 * DAY },
      { text: "newest", at: now },
      { text: "middle", at: now - DAY },
    ]);
    expect((await store.history()).map((item) => item.text)).toEqual(["newest", "middle", "oldest"]);
  });

  it("narrows history by scope and by age", async () => {
    const store = await inMemory();
    const now = Date.now();
    await store.remember([
      { text: "mine, old", scope: "a", at: now - 10 * DAY },
      { text: "mine, new", scope: "a", at: now },
      { text: "theirs", scope: "b", at: now },
    ]);
    expect((await store.history({ scope: "a" })).length).toBe(2);
    expect((await store.history({ scope: "a", since: now - DAY })).map((i) => i.text)).toEqual([
      "mine, new",
    ]);
  });

  it("searches text without caring how old it is", async () => {
    const store = await inMemory();
    const now = Date.now();
    await store.remember([
      { text: "the refund policy allows fourteen days", at: now - 400 * DAY },
      { text: "shipping usually takes three days", at: now },
    ]);
    const found = await store.search("refund");
    expect(found).toHaveLength(1);
    expect(found[0]?.text).toContain("refund policy");
    expect(found[0]?.score).toBe(1);
  });

  it("survives punctuation a text index would refuse", async () => {
    const store = await inMemory();
    await store.remember({ text: "the customer's order (4021) was cancelled" });
    const found = await store.search("customer's order -- (4021)");
    expect(found[0]?.text).toContain("cancelled");
  });

  it("recalls the recent one when two say the same thing", async () => {
    const store = await inMemory();
    const now = Date.now();
    await store.remember([
      { id: "old", text: "we discussed the refund policy", at: now - 90 * DAY },
      { id: "new", text: "we discussed the refund policy", at: now },
    ]);
    const found = await store.recall("refund policy");
    expect(found.map((item) => item.id)).toEqual(["new", "old"]);
    expect(found[0]!.score).toBeGreaterThan(found[1]!.score);
  });

  it("forgets a scope entirely, and only that scope", async () => {
    const store = await inMemory();
    await store.remember([
      { text: "one", scope: "a" },
      { text: "two", scope: "a" },
      { text: "three", scope: "b" },
    ]);
    expect(await store.forget({ scope: "a" })).toBe(2);
    expect((await store.history()).map((item) => item.text)).toEqual(["three"]);
  });

  it("clamps a limit rather than refusing it", async () => {
    const store = await inMemory();
    await store.remember(Array.from({ length: 30 }, (_, index) => ({ text: `note ${index}` })));
    expect(await store.history({ limit: 5 })).toHaveLength(5);
    expect(await store.history({ limit: 1_000_000 })).toHaveLength(30);
    expect(await store.history()).toHaveLength(20);
  });

  it("replaces rather than duplicates when an id comes back", async () => {
    const store = await inMemory();
    await store.remember({ id: "one", text: "before" });
    await store.remember({ id: "one", text: "after" });
    const seen = await store.history();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.text).toBe("after");
    // The text index has to have moved with it, or search answers with a ghost.
    expect(await store.search("before")).toHaveLength(0);
    expect(await store.search("after")).toHaveLength(1);
  });
});

describe("who wrote a thing", () => {
  it("marks what was kept through a view, and nothing else", async () => {
    const store = await inMemory();
    await store.remember({ text: "anonymous" });
    await store.as("intake").remember({ text: "attributed" });

    const seen = await store.history();
    expect(seen.find((item) => item.text === "attributed")?.by).toBe("intake");
    expect(seen.find((item) => item.text === "anonymous")?.by).toBeUndefined();
  });

  it("takes the mark from the view and never from what is being kept", async () => {
    const store = await inMemory();
    // Whatever a caller thinks it is, this row is the intake's.
    await store.as("intake").remember({ text: "claimed", by: "somebody else" } as never);

    expect((await store.history())[0]?.by).toBe("intake");
  });

  it("answers with only one writer's when asked for one", async () => {
    const store = await inMemory();
    await store.as("intake").remember({ text: "the roof leaks" });
    await store.as("billing").remember({ text: "the roof invoice" });

    expect((await store.history({ by: "intake" })).map((item) => item.text)).toEqual([
      "the roof leaks",
    ]);
    expect((await store.search("roof", { by: "billing" })).map((item) => item.text)).toEqual([
      "the roof invoice",
    ]);
  });

  it("is the same store underneath, so a view sees what the store kept", async () => {
    const store = await inMemory();
    await store.remember({ text: "kept plainly" });
    expect(await store.as("intake").history()).toHaveLength(1);
  });
});

describe("taking something back", () => {
  it("leaves the note where the text was, and the row where it was", async () => {
    const store = await inMemory();
    const [id] = await store.remember({ text: "the card number is 4000", at: 5_000 });

    expect(await store.redact({ id }, "removed at the customer's request")).toBe(1);

    const kept = await store.history();
    expect(kept).toHaveLength(1);
    expect(kept[0]?.id).toBe(id);
    expect(kept[0]?.at).toBe(5_000);
    expect(kept[0]?.text).toBe("removed at the customer's request");
    expect(kept[0]?.redactedAt).toBeGreaterThan(0);
  });

  it("cannot be found by what it used to say", async () => {
    const store = await inMemory();
    await store.remember({ text: "the card number is 4000" });
    await store.redact({}, "taken back");

    expect(await store.search("4000")).toHaveLength(0);
    expect(await store.recall("card number")).toHaveLength(0);
  });

  it("is never handed back to answer with, even by its note", async () => {
    const store = await inMemory();
    await store.remember({ text: "the roof leaks" });
    await store.redact({}, "the roof leaks");

    // The note says the same words and is still not something to answer from.
    expect(await store.search("roof")).toHaveLength(0);
    expect(await store.history()).toHaveLength(1);
  });

  it("takes back what was kept beside the text as well as the text", async () => {
    const store = await inMemory();
    await store.remember({ text: "the card number is 4000", meta: { card: "4000" } });
    await store.redact({}, "taken back");

    expect((await store.history())[0]?.meta).toBeUndefined();
  });

  it("stops a vector store finding it by nearness", async () => {
    const store = await inMemory("vector");
    await store.remember({ text: "close", vector: [1, 0, 0] });
    await store.redact({}, "taken back");

    expect(await store.recall([1, 0, 0])).toHaveLength(0);
  });

  it("takes back only what was asked for", async () => {
    const store = await inMemory();
    await store.as("intake").remember({ text: "the roof leaks" });
    await store.as("billing").remember({ text: "the roof invoice" });

    expect(await store.redact({ by: "intake" }, "taken back")).toBe(1);
    expect((await store.search("roof")).map((item) => item.text)).toEqual(["the roof invoice"]);
  });

  it("will not take something back and leave nothing in its place", async () => {
    const store = await inMemory();
    await store.remember({ text: "the roof leaks" });
    await expect(store.redact({}, "   ")).rejects.toThrow(/say what to leave/);
  });

  it("says how many it took back, including none", async () => {
    const store = await inMemory();
    expect(await store.redact({ scope: "nobody" }, "taken back")).toBe(0);
  });
});

describe("vectors", () => {
  it("recalls by nearness when given one", async () => {
    const store = await inMemory("vector");
    await store.remember([
      { id: "near", text: "close", vector: [1, 0, 0] },
      { id: "far", text: "opposite", vector: [-1, 0, 0] },
      { id: "side", text: "orthogonal", vector: [0, 1, 0] },
    ]);
    const found = await store.recall([1, 0, 0]);
    // The opposite one is not merely last, it is not an answer to the question.
    expect(found.map((item) => item.id)).toEqual(["near", "side"]);
    expect(found[0]!.score).toBeCloseTo(1, 5);
  });

  it("ignores anything kept without one", async () => {
    const store = await inMemory("vector");
    await store.remember([
      { id: "with", text: "has a vector", vector: [1, 0] },
      { id: "without", text: "has none" },
    ]);
    expect((await store.recall([1, 0])).map((item) => item.id)).toEqual(["with"]);
  });
});

describe("the author's own surface", () => {
  it("passes SQL through and answers in columns and rows", async () => {
    const store = await inMemory();
    await store.query("CREATE TABLE invoices (id TEXT PRIMARY KEY, cents INTEGER)");
    const written = await store.query("INSERT INTO invoices VALUES (?, ?)", ["a", 1200]);
    expect(written.changed).toBe(1);

    const read = await store.query("SELECT id, cents FROM invoices");
    expect(read.columns).toEqual(["id", "cents"]);
    expect(read.rows).toEqual([["a", 1200]]);
    expect(asObjects(read)).toEqual([{ id: "a", cents: 1200 }]);
  });

  it("declares what the backend can do rather than leaving it to be guessed", async () => {
    const store = await inMemory();
    expect(store.capabilities.fullText).toBe(true);
    expect(store.capabilities.vectors).toBe(true);
    expect(store.capabilities.maxBindValues).toBeGreaterThan(0);
  });
});

describe("where a store lives", () => {
  it("falls back to a file under the state directory", () => {
    const { url } = urlFor("main", { kind: "store", of: "sql" }, { stateDir: "/app/.praecise" });
    expect(url).toBe("/app/.praecise/stores/main.db");
  });

  it("makes that file, and what it kept is still there next time", async () => {
    const root = await makeProject({});
    roots.push(root);

    const spec = { kind: "store", of: "sql" } as const;
    const first = await openStore("main", spec, { stateDir: join(root, ".praecise") });
    await first.remember({ id: "kept", text: "written to disk" });
    await first.close();

    expect(existsSync(join(root, ".praecise", "stores", "main.db"))).toBe(true);

    const again = await openStore("main", spec, { stateDir: join(root, ".praecise") });
    open.push(again);
    expect((await again.history())[0]?.text).toBe("written to disk");
  });

  it("reads a named credential", () => {
    const { url } = urlFor(
      "main",
      { kind: "store", of: "sql", credential: "MAIN_DB" },
      { stateDir: "/app/.praecise", env: { MAIN_DB: "sqlite:/tmp/x.db" } },
    );
    expect(url).toBe("sqlite:/tmp/x.db");
  });

  it("says which credential is missing instead of opening the wrong thing", () => {
    const { problem } = urlFor(
      "main",
      { kind: "store", of: "sql", credential: "MAIN_DB" },
      { stateDir: "/app/.praecise", env: {} },
    );
    expect(problem).toMatch(/MAIN_DB/);
  });

  it("refuses a scheme nothing brought a backend for", async () => {
    await expect(
      openStore("main", { kind: "store", of: "sql", url: "elsewhere://host/db" }, { stateDir: "/x" }),
    ).rejects.toThrow(/elsewhere/);
  });

  it("opens a brought backend by its scheme", async () => {
    const store = await openStore(
      "main",
      { kind: "store", of: "document", url: "elsewhere://host/db" },
      { stateDir: "/x", drivers: [elsewhere] },
    );
    expect(store.capabilities.fullText).toBe(false);
    // No text index, so text goes through an honest scan and still answers.
    await store.remember({ text: "the refund was approved" });
    expect((await store.search("refund")).map((item) => item.text)).toEqual([
      "the refund was approved",
    ]);
    await expect(store.recall([1, 2])).rejects.toThrow(/cannot compare vectors/);
  });

  it("opens each declared store once and closes them with the app", async () => {
    const specs = { main: { kind: "store", of: "sql", url: ":memory:" } as const };
    const stores = new Stores(specs, { stateDir: "/x" });
    expect(stores.names).toEqual(["main"]);
    const first = await stores.open("main");
    expect(await stores.open("main")).toBe(first);
    await stores.close();
    await expect(first.history()).rejects.toThrow();
  });
});

describe("an agent that remembers into a store", () => {
  it("recalls its own earlier exchanges and not another agent's", async () => {
    const root = await makeProject({
      ...TEST_MODELS,
      "stores/recall.ts": `import { store } from "${FRAMEWORK}";
        export default store({ of: "sql", url: ":memory:" });`,
      "agents/support.ts": `import { agent } from "${FRAMEWORK}";
        export default agent({
          role: "Answers customer questions about orders.",
          memory: { store: "recall" },
        });`,
      "agents/billing.ts": `import { agent } from "${FRAMEWORK}";
        export default agent({
          role: "Answers questions about invoices.",
          memory: { store: "recall" },
        });`,
    });
    roots.push(root);

    const model = stubModel([
      { text: "Order 4021 shipped on Tuesday." },
      { text: "Invoice 77 is unpaid." },
      { text: "It shipped on Tuesday." },
    ]);
    const app = await App.load({ root, env: { ...MODEL_ENV }, fetch: model.fetch });

    await app.ask("support", "where is order 4021?");
    await app.ask("billing", "what about invoice 77?");
    await app.ask("support", "remind me about order 4021");

    const kept = await app.store("recall");
    expect((await kept.history({ scope: "support" })).length).toBe(2);
    expect((await kept.history({ scope: "billing" })).length).toBe(1);

    // The last call is the third ask, and it may only have recalled its own.
    const recalled = String(model.calls.at(-1)?.body.system ?? "");
    expect(recalled).toContain("where is order 4021?");
    expect(recalled).not.toContain("invoice 77");

    await app.close();
  });

  it("marks what it kept as its own, and can be made to take one back", async () => {
    const root = await makeProject({
      ...TEST_MODELS,
      "stores/recall.ts": `import { store } from "${FRAMEWORK}";
        export default store({ of: "sql", url: ":memory:" });`,
      "agents/support.ts": `import { agent } from "${FRAMEWORK}";
        export default agent({
          role: "Answers customer questions about orders.",
          memory: { store: "recall" },
        });`,
    });
    roots.push(root);

    const model = stubModel([{ text: "Noted." }, { text: "Nothing on file." }]);
    const app = await App.load({ root, env: { ...MODEL_ENV }, fetch: model.fetch });

    await app.ask("support", "my card number is 4000");
    const [kept] = await app.recorded("support");
    expect((await (await app.store("recall")).history())[0]?.by).toBe("support");

    expect(await app.redact("support", kept!.id, "removed at the customer's request")).toBe(true);
    await app.ask("support", "what was my card number?");

    const asked = String(model.calls.at(-1)?.body.system ?? "");
    expect(asked).not.toContain("4000");
    // Still on the record, and still the agent's, at the time it happened.
    const after = await app.recorded("support");
    expect(after).toHaveLength(2);
    expect(after[0]?.redactedAt).toBeGreaterThan(0);
    expect(after[0]?.at).toBe(kept!.at);

    await app.close();
  });
});

/**
 * A backend an app brought, with none of the built-in one's conveniences, so
 * the store's own fallbacks are exercised rather than the driver's.
 *
 * It is the shipped in-memory backend with its capabilities talked down. What
 * matters to these tests is that it arrives from outside under a scheme
 * nothing here knows and says it can do very little; writing a second one by
 * hand to say that would only be a second one to keep correct.
 */
const elsewhere: Driver = {
  name: "elsewhere",
  async connect(options): Promise<Connection> {
    const connection = await memoryDriver.connect(options);
    return Object.assign(Object.create(connection) as Connection, {
      capabilities: { maxBindValues: 100, fullText: false, vectors: false, returning: false },
    });
  },
};

describe("the driver contract", () => {
  it("is what the built-in backend is reached through, not a special case", async () => {
    const connection = await sqliteDriver.connect({ url: ":memory:" });
    const store = new Kept("direct", "sql", connection);
    open.push(store);
    await store.remember({ text: "reachable" });
    expect((await store.history())[0]?.text).toBe("reachable");
  });
});
