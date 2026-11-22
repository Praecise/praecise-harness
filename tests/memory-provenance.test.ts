/**
 * How much something kept may weigh, and which of two entries stands.
 *
 * Both are worked out from values (where it came from, when it was said) and never
 * asked of a model.
 */
import { describe, expect, test } from "vitest";

import { preferred, settle, type Note, type ProposedNote, type Retirement } from "../src/harness/consolidate.js";
import { authorityOf, type Origin } from "../src/harness/memory.js";

const carried = (id: string, text: string, origin: Origin, at: number): Note => ({
  id,
  kind: "fact",
  text,
  from: ["e1"],
  origin,
  at,
});

const proposed = (text: string, origin: Origin, at: number, replaces?: string[]): ProposedNote => ({
  kind: "fact",
  text,
  from: ["e2"],
  origin,
  at,
  ...(replaces ? { replaces } : {}),
});

describe("authority is the lowest of the sources", () => {
  test("one untrusted source makes the whole untrusted", () => {
    expect(authorityOf(["user", "external"])).toBe("external");
    expect(authorityOf(["user", "tool"])).toBe("tool");
    expect(authorityOf(["agent", "agent"])).toBe("agent");
  });

  test("something drawn from nothing is worth the least", () => {
    expect(authorityOf([])).toBe("external");
  });
});

describe("which of two entries stands", () => {
  test("the higher authority, whichever is later", () => {
    const person = carried("c1", "on the annual plan", "user", 1);
    const outside = proposed("on the monthly plan", "external", 2);
    expect(preferred(person, outside)).toBe(person);
    expect(preferred(carried("c1", "x", "external", 9), proposed("y", "user", 1)).text).toBe("y");
  });

  test("between equals, the later", () => {
    const earlier = carried("c1", "on the monthly plan", "agent", 1);
    const later = proposed("on the annual plan", "agent", 2);
    expect(preferred(earlier, later)).toBe(later);
  });
});

describe("settling a proposal against what is carried", () => {
  test("a replacement closes what it replaces, and does not delete it", () => {
    const held = [carried("c1", "on the monthly plan", "agent", 1)];
    const done = settle(held, [proposed("on the annual plan", "agent", 2, ["c1"])], [], 50);

    expect(done.kept.map((note) => note.text)).toEqual(["on the annual plan"]);
    expect(done.closed.map((note) => note.id)).toEqual(["c1"]);
    const old = done.notes.find((note) => note.id === "c1")!;
    expect(old.until).toBe(50);
    expect(old.replacedBy).toBe(done.kept[0]!.id);
    // What was handed in is not changed.
    expect(held[0]!.until).toBeUndefined();
  });

  test("what an outside source says cannot displace what a person said", () => {
    const held = [carried("c1", "refunds need a manager", "user", 1)];
    const done = settle(held, [proposed("refunds need nobody", "external", 2, ["c1"])], []);

    expect(done.kept).toEqual([]);
    expect(done.closed).toEqual([]);
    expect(done.refused[0]).toContain("higher authority");
    expect(done.notes.filter((note) => note.until === undefined).map((note) => note.id)).toEqual(["c1"]);
  });

  test("something not proposed again is still carried", () => {
    const held = [carried("c1", "on the annual plan", "agent", 1)];
    const done = settle(held, [proposed("exports fail over a gigabyte", "agent", 2)], []);
    expect(done.notes.filter((note) => note.until === undefined).map((note) => note.text)).toEqual([
      "on the annual plan",
      "exports fail over a gigabyte",
    ]);
  });

  test("something already carried is not carried twice", () => {
    const held = [carried("c1", "On the annual plan", "agent", 1)];
    const done = settle(held, [proposed("on the  annual plan", "agent", 2)], []);
    expect(done.kept).toEqual([]);
    expect(done.refused[0]).toContain("already carried");
  });

  test("a retirement closes an entry, where what speaks against it has the standing to", () => {
    const retirement = (origin: Origin): Retirement => ({ id: "c1", why: "they left", from: ["e9"], origin, at: 5 });

    const closed = settle([carried("c1", "on the annual plan", "agent", 1)], [], [retirement("agent")], 70);
    expect(closed.closed.map((note) => note.id)).toEqual(["c1"]);
    expect(closed.notes[0]!.until).toBe(70);

    const kept = settle([carried("c1", "on the annual plan", "user", 1)], [], [retirement("external")]);
    expect(kept.closed).toEqual([]);
    expect(kept.refused[0]).toContain("lower authority");
  });
});
