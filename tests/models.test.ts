/**
 * Three more shapes of data on the one table every backend has: a value under a name,
 * how two things are related and when, and readings in order of time.
 *
 * Run against the backend that keeps nothing past the process, because these are verbs
 * over the operations every driver already implements — what holds here holds wherever
 * `conform` passes.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openStore } from "../src/stores/index.js";
import type { Store } from "../src/stores/types.js";

let store: Store;
beforeEach(async () => {
  store = await openStore("kept", { kind: "store", of: "document", url: "memory:" }, { stateDir: "/x" });
});
afterEach(async () => {
  await store.close();
});

describe("a value under a name", () => {
  it("is kept, read back as what it was, replaced, and removed", async () => {
    await store.values.put(["users", "ada"], "theme", { dark: true });
    expect(await store.values.get(["users", "ada"], "theme")).toEqual({ dark: true });

    await store.values.put(["users", "ada"], "theme", { dark: false });
    expect(await store.values.get(["users", "ada"], "theme")).toEqual({ dark: false });
    // Writing twice is one entry, not two.
    expect(await store.values.list(["users", "ada"])).toHaveLength(1);

    expect(await store.values.delete(["users", "ada"], "theme")).toBe(true);
    expect(await store.values.get(["users", "ada"], "theme")).toBeUndefined();
    expect(await store.values.delete(["users", "ada"], "theme")).toBe(false);
  });

  it("keeps namespaces apart, and a key in one is not a key in another", async () => {
    await store.values.put(["users", "ada"], "plan", "pro");
    await store.values.put(["users", "bob"], "plan", "free");
    await store.values.put("flags", "plan", true);
    expect(await store.values.get(["users", "ada"], "plan")).toBe("pro");
    expect(await store.values.get(["users", "bob"], "plan")).toBe("free");
    expect(await store.values.get("flags", "plan")).toBe(true);
    expect((await store.values.list(["users", "bob"])).map((entry) => entry.key)).toEqual(["plan"]);
  });

  it("a value given a lifetime is gone when it ends", async () => {
    await store.values.put("sessions", "s1", "token", { ttl: 0.03 });
    expect(await store.values.get("sessions", "s1")).toBe("token");
    expect((await store.values.list("sessions"))[0]!.expires).toBeGreaterThan(Date.now());
    await new Promise((resume) => setTimeout(resume, 50));
    expect(await store.values.get("sessions", "s1")).toBeUndefined();
    expect(await store.values.list("sessions")).toEqual([]);
  });

  it("does not turn up when an agent recalls something", async () => {
    await store.values.put("flags", "refunds", "enabled for refunds");
    await store.remember({ text: "the customer asked about refunds", scope: "support" });
    const recalled = await store.recall("refunds", { scope: "support" });
    expect(recalled.map((found) => found.text)).toEqual(["the customer asked about refunds"]);
  });
});

describe("how two things are related, and when", () => {
  const day = 86_400_000;
  const march = Date.UTC(2026, 2, 1);
  const june = Date.UTC(2026, 5, 1);

  it("records a fact once, however often it is said", async () => {
    const first = await store.facts.relate("ada", "works_at", "acme", { source: "hr-export" });
    const again = await store.facts.relate("ada", "works_at", "acme", { confidence: 0.9 });
    expect(again).toBe(first);
    const known = await store.facts.facts({ subject: "ada" });
    expect(known).toHaveLength(1);
    expect(known[0]).toMatchObject({ subject: "ada", predicate: "works_at", object: "acme", confidence: 0.9 });
  });

  it("answers by any of subject, predicate and object", async () => {
    await store.facts.relate("ada", "works_at", "acme");
    await store.facts.relate("bob", "works_at", "acme");
    await store.facts.relate("ada", "manages", "bob");
    expect((await store.facts.facts({ object: "acme" })).map((fact) => fact.subject).sort()).toEqual(["ada", "bob"]);
    expect(await store.facts.facts({ predicate: "manages" })).toHaveLength(1);
    expect(await store.facts.facts({ subject: "carol" })).toEqual([]);
  });

  it("knows when a fact was true: closed, never deleted", async () => {
    const id = await store.facts.relate("ada", "works_at", "acme", { validFrom: march });
    expect(await store.facts.unrelate(id, { at: june })).toBe(true);
    await store.facts.relate("ada", "works_at", "globex", { validFrom: june });

    const at = async (when: number) => (await store.facts.facts({ subject: "ada", asOf: when })).map((fact) => fact.object);
    expect(await at(march + 30 * day)).toEqual(["acme"]);
    expect(await at(june + day)).toEqual(["globex"]);
    expect(await at(march - day)).toEqual([]);
    // What was once believed is still on the record.
    expect(await store.facts.facts({ subject: "ada", asOf: "ever" })).toHaveLength(2);
    expect(await store.facts.unrelate("fact_nothing")).toBe(false);
  });

  it("walks outward, nearest first, each thing once, three steps at most", async () => {
    await store.facts.relate("ada", "manages", "bob");
    await store.facts.relate("bob", "manages", "carol");
    await store.facts.relate("carol", "manages", "dan");
    await store.facts.relate("dan", "manages", "eve");
    await store.facts.relate("carol", "manages", "ada"); // a cycle, which must not loop

    const one = await store.facts.neighbors("ada");
    expect(one.map((n) => [n.node, n.depth])).toEqual([["bob", 1]]);

    const far = await store.facts.neighbors("ada", { depth: 9 });
    expect(far.map((n) => [n.node, n.depth])).toEqual([["bob", 1], ["carol", 2], ["dan", 3]]);
    expect(far[1]!.via).toMatchObject({ subject: "bob", object: "carol" });

    const back = await store.facts.neighbors("bob", { direction: "in" });
    expect(back.map((n) => n.node)).toEqual(["ada"]);
    const both = await store.facts.neighbors("bob", { direction: "both" });
    expect(both.map((n) => n.node).sort()).toEqual(["ada", "carol"]);
  });

  it("keeps scopes apart, and refuses a fact with a part missing or a span that ends before it starts", async () => {
    await store.facts.relate("ada", "likes", "tea", { scope: "tenant-a" });
    expect(await store.facts.facts({ scope: "tenant-b" })).toEqual([]);
    expect(await store.facts.facts({ scope: "tenant-a" })).toHaveLength(1);
    await expect(store.facts.relate("ada", " ", "tea")).rejects.toThrow(/needs a predicate/);
    await expect(store.facts.relate("a", "b", "c", { validFrom: june, validTo: march })).rejects.toThrow(/before it starts/);
  });

  it("is found by what it says, like anything else in the store", async () => {
    await store.facts.relate("ada", "works_at", "acme");
    const found = await store.search("acme", { scope: "facts:" });
    expect(found[0]?.text).toBe("ada works_at acme");
  });
});

describe("readings in order of time", () => {
  const start = Date.UTC(2026, 0, 1);
  const minute = 60_000;

  it("keeps readings, hands them back oldest first, and the latest on its own", async () => {
    await store.series.append("boiler/temp", [
      { at: start + 2 * minute, value: 62 },
      { at: start, value: 60 },
      { at: start + minute, value: 61, tags: { unit: "Cel" } },
    ]);
    const all = await store.series.range("boiler/temp");
    expect(all.map((point) => point.value)).toEqual([60, 61, 62]);
    expect(all[1]!.tags).toEqual({ unit: "Cel" });
    expect(await store.series.last("boiler/temp")).toMatchObject({ value: 62 });
    expect(await store.series.last("nothing")).toBeUndefined();
  });

  it("a reading sent twice is one reading", async () => {
    await store.series.append("load", { at: start, value: 1 });
    await store.series.append("load", { at: start, value: 2 });
    expect(await store.series.range("load")).toEqual([{ at: start, value: 2 }]);
  });

  it("takes a span, from inclusive to exclusive", async () => {
    await store.series.append("load", Array.from({ length: 10 }, (_, at) => ({ at: start + at * minute, value: at })));
    const span = await store.series.range("load", { from: start + 2 * minute, to: start + 5 * minute });
    expect(span.map((point) => point.value)).toEqual([2, 3, 4]);
    expect((await store.series.range("load", { limit: 2 })).map((point) => point.value)).toEqual([8, 9]);
  });

  it("says what each window amounts to", async () => {
    await store.series.append("load", Array.from({ length: 6 }, (_, at) => ({ at: start + at * minute, value: at + 1 })));
    const width = 3 * minute;
    const mean = await store.series.range("load", { bucket: width });
    expect(mean).toEqual([{ at: start, value: 2 }, { at: start + width, value: 5 }]);
    const pick = async (aggregate: "min" | "max" | "sum" | "count" | "first" | "last") =>
      (await store.series.range("load", { bucket: width, aggregate })).map((point) => point.value);
    expect(await pick("min")).toEqual([1, 4]);
    expect(await pick("max")).toEqual([3, 6]);
    expect(await pick("sum")).toEqual([6, 15]);
    expect(await pick("count")).toEqual([3, 3]);
    expect(await pick("last")).toEqual([3, 6]);
  });

  it("keeps series apart and refuses a reading that is not a number at a time", async () => {
    await store.series.append("a", 1);
    await store.series.append("b", 2);
    expect((await store.series.range("a")).map((point) => point.value)).toEqual([1]);
    await expect(store.series.append("a", { at: start, value: Number.NaN })).rejects.toThrow(/finite value/);
    await expect(store.series.append(" ", 1)).rejects.toThrow(/needs a name/);
  });
});
