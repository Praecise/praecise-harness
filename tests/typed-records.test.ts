/**
 * A schema on a store: what is kept beside a row's text is checked on the way in.
 *
 * The validator below is written by hand against the Standard Schema interface, which
 * is the point of the interface — a store takes anything with a `~standard` property
 * and this package depends on no library that makes one. Run against the backend that
 * keeps nothing past the process; the check happens above the driver, so it is the
 * same check on every backend.
 */
import { describe, expect, expectTypeOf, it } from "vitest";

import { store, type RecordInputOf, type RecordOf } from "../src/define.js";
import { SchemaError, isStandardSchema, type StandardSchemaV1 } from "../src/schema.js";
import { Stores, openStore } from "../src/stores/index.js";

interface Ticket {
  id: number;
  status: "open" | "closed";
  tags: string[];
}

/** What a caller may hand over: `status` and `tags` have defaults. */
interface TicketInput {
  id: number;
  status?: "open" | "closed";
  tags?: string[];
}

/** A Standard Schema validator, as a validation library would hand one over. */
const ticket: StandardSchemaV1<TicketInput, Ticket> = {
  "~standard": {
    version: 1,
    vendor: "by-hand",
    validate(value) {
      const issues: StandardSchemaV1.Issue[] = [];
      const given = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
      if (typeof value !== "object" || value === null) issues.push({ message: "expected an object" });
      if (typeof given.id !== "number") issues.push({ message: "expected a number", path: ["id"] });
      const status = given.status ?? "open";
      if (status !== "open" && status !== "closed") {
        issues.push({ message: 'expected "open" or "closed"', path: [{ key: "status" }] });
      }
      const tags = given.tags ?? [];
      if (!Array.isArray(tags)) issues.push({ message: "expected a list", path: ["tags"] });
      else tags.forEach((tag, index) => typeof tag !== "string" && issues.push({ message: "expected text", path: ["tags", index] }));
      if (issues.length) return { issues };
      return { value: { id: given.id as number, status: status as Ticket["status"], tags: tags as string[] } };
    },
  },
};

const tickets = store({ of: "document", url: "memory:", schema: ticket });
const OPTIONS = { stateDir: "/x" };

describe("a store declared with a schema", () => {
  it("keeps what passes, as the validator returned it", async () => {
    const kept = await openStore("tickets", tickets, OPTIONS);
    await kept.remember({ text: "printer on fire", meta: { id: 1 } });
    const [row] = await kept.history();
    // The defaults the validator filled in are what was kept.
    expect(row?.meta).toEqual({ id: 1, status: "open", tags: [] });
    await kept.close();
  });

  it("refuses what does not, with what was wrong and where", async () => {
    const kept = await openStore("tickets", tickets, OPTIONS);
    const refused = await kept
      .remember({ text: "bad", meta: { id: "one", status: "pending", tags: ["a", 2] } as never })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(SchemaError);
    const error = refused as SchemaError;
    expect(error.issues).toEqual([
      { index: 0, path: "id", message: "expected a number" },
      { index: 0, path: "status", message: 'expected "open" or "closed"' },
      { index: 0, path: "tags.1", message: "expected text" },
    ]);
    expect(error.message).toMatch(/store "tickets" refused what it was given, and nothing was kept/);
    expect(await kept.history()).toHaveLength(0);
    await kept.close();
  });

  it("refuses a whole batch for one bad record, and names which", async () => {
    const kept = await openStore("tickets", tickets, OPTIONS);
    const refused = await kept
      .remember([
        { text: "fine", meta: { id: 1 } },
        { text: "not fine", meta: { id: "two" } as never },
        { text: "also fine", meta: { id: 3 } },
      ])
      .catch((error: unknown) => error as SchemaError);
    expect((refused as SchemaError).issues).toEqual([{ index: 1, path: "id", message: "expected a number" }]);
    // Not the first one either: half a batch is a state nobody asked for.
    expect(await kept.history()).toHaveLength(0);
    await kept.close();
  });

  it("refuses a row with no record at all", async () => {
    const kept = await openStore("tickets", tickets, OPTIONS);
    await expect(kept.remember({ text: "nothing beside it" } as never)).rejects.toThrow(SchemaError);
    await kept.close();
  });

  it("checks what an agent writes through its own view of the store", async () => {
    const kept = await openStore("tickets", tickets, OPTIONS);
    const view = kept.as("the agent");
    await expect(view.remember({ text: "bad", meta: { id: "x" } as never })).rejects.toThrow(SchemaError);
    await view.remember({ text: "good", meta: { id: 9, status: "closed" } });
    const [row] = await kept.history();
    expect(row).toMatchObject({ by: "the agent", meta: { id: 9, status: "closed", tags: [] } });
    await kept.close();
  });

  it("waits for a validator that answers later", async () => {
    const slow: StandardSchemaV1<unknown, { ok: true }> = {
      "~standard": {
        version: 1,
        vendor: "by-hand",
        validate: async (value) =>
          (value as { ok?: unknown } | undefined)?.ok === true ? { value: { ok: true } } : { issues: [{ message: "not ok" }] },
      },
    };
    const kept = await openStore("slow", store({ of: "document", url: "memory:", schema: slow }), OPTIONS);
    await kept.remember({ text: "yes", meta: { ok: true } });
    await expect(kept.remember({ text: "no", meta: { ok: false } as never })).rejects.toThrow(/not ok/);
    expect(await kept.history()).toHaveLength(1);
    await kept.close();
  });

  it("refuses a schema whose record is not an object", async () => {
    const text: StandardSchemaV1<unknown, object> = {
      "~standard": { version: 1, vendor: "by-hand", validate: () => ({ value: "a string" as unknown as object }) },
    };
    const kept = await openStore("text", store({ of: "document", url: "memory:", schema: text }), OPTIONS);
    await expect(kept.remember({ text: "x", meta: {} })).rejects.toThrow(/not an object/);
    await kept.close();
  });

  it("leaves values, facts and series to their own shapes", async () => {
    const kept = await openStore("tickets", tickets, OPTIONS);
    await kept.values.put("flags", "beta", true);
    await kept.facts.relate("ada", "owns", "ticket 1");
    await kept.series.append("load", { at: 1_000, value: 3 });
    expect(await kept.values.get("flags", "beta")).toBe(true);
    await kept.close();
  });
});

describe("a store declared without one", () => {
  it("keeps whatever it is given, as it always did", async () => {
    const kept = await openStore("plain", store({ of: "document", url: "memory:" }), OPTIONS);
    await kept.remember({ text: "anything", meta: { whatever: [1, "two"] } });
    expect((await kept.history())[0]?.meta).toEqual({ whatever: [1, "two"] });
    await kept.close();
  });
});

describe("declaring the schema", () => {
  it("takes a Standard Schema validator and nothing that only looks like one", () => {
    expect(isStandardSchema(ticket)).toBe(true);
    expect(isStandardSchema({ parse: () => ({}) })).toBe(false);
    expect(isStandardSchema({ "~standard": { version: 2, validate: () => ({ value: {} }) } })).toBe(false);
    expect(() => store({ of: "document", schema: { parse: () => ({}) } as never })).toThrow(/Standard Schema/);
  });

  it("carries the record's type to reads, and the wider input type to writes", async () => {
    expectTypeOf<RecordOf<typeof tickets>>().toEqualTypeOf<Ticket>();
    expectTypeOf<RecordInputOf<typeof tickets>>().toEqualTypeOf<TicketInput>();

    const kept = await openStore("tickets", tickets, OPTIONS);
    await kept.remember({ text: "typed", meta: { id: 4, tags: ["urgent"] } });
    const [row] = await kept.history();
    expectTypeOf(row!.meta).toEqualTypeOf<Ticket | undefined>();
    // Read without a cast: the type the schema describes is the type that came back.
    expect(row?.meta?.tags[0]).toBe("urgent");
    const found = await kept.search("typed");
    expectTypeOf(found[0]!.meta).toEqualTypeOf<Ticket | undefined>();
    await kept.close();

    // By name, the declaration's type cannot follow it, so the caller says which.
    const stores = new Stores({ tickets }, OPTIONS);
    const named = await stores.open<RecordOf<typeof tickets>, RecordInputOf<typeof tickets>>("tickets");
    await named.remember({ text: "by name", meta: { id: 5 } });
    expectTypeOf((await named.history())[0]!.meta).toEqualTypeOf<Ticket | undefined>();
    await expect(named.remember({ text: "bad", meta: { id: "five" } as never })).rejects.toThrow(SchemaError);
    await stores.close();
  });

  it("leaves a store with no schema typed as it was", () => {
    const plain = store({ of: "document" });
    expectTypeOf<RecordOf<typeof plain>>().toEqualTypeOf<Record<string, unknown>>();
  });
});
