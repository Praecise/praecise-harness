/**
 * The operator's tradeoff, and what each setting actually does.
 *
 * The framework holds the machinery; the operator says which way to lean. These tests
 * pin the three behaviours apart from each other, because "cost" and "quality" that
 * route the same request identically would be a dial connected to nothing — and a dial
 * connected to nothing is worse than no dial, since it invites a decision that is not
 * being acted on.
 */
import { describe, expect, test } from "vitest";
import { route, type Shape } from "../src/harness/routing.js";

/** A middling request: not trivial, not obviously beyond the cheap rung. */
const middling: Shape = { asked: 900, carried: 4_000, turns: 3, tools: 4, structured: false };
/** A hard one: long, many tools, deep conversation, a declared shape to hit. */
const hard: Shape = { asked: 8_000, carried: 30_000, turns: 12, tools: 14, structured: true };
/** A trivial one. */
const easy: Shape = { asked: 40, carried: 100, turns: 0, tools: 0, structured: false };

describe("the operator decides the tradeoff, not the framework", () => {
  test("quality goes straight to the strongest rung and checks nothing", () => {
    for (const shape of [easy, middling, hard]) {
      const r = route(shape, 3, 0, "quality");
      expect(r.entry, "the strongest rung, whatever the request looks like").toBe(2);
      expect(r.effort, "and all of the room it has").toBe(1);
      expect(r.verify, "checking exists to decide whether to climb; there is nowhere above").toBe(false);
      expect(r.why).toMatch(/quality/);
    }
  });

  test("cost starts below the estimate and pays for a check instead of a climb", () => {
    const balanced = route(middling, 3, 0, "balanced");
    const cheap = route(middling, 3, 0, "cost");
    expect(cheap.entry, "one rung below where the estimate alone would start").toBeLessThanOrEqual(balanced.entry);
    expect(cheap.verify, "having started deliberately low, the answer is always worth checking").toBe(true);
  });

  test("cost cannot start below the bottom rung", () => {
    const r = route(easy, 3, 0, "cost");
    expect(r.entry).toBe(0);
  });

  test("balanced is the behaviour that was there before a dial existed", () => {
    const withDial = route(middling, 3, 0, "balanced");
    const withoutDial = route(middling, 3, 0);
    expect(withDial).toEqual(withoutDial);
  });

  test("the three settings are genuinely different — a dial connected to nothing is worse than none", () => {
    const entries = (["cost", "balanced", "quality"] as const).map((p) => route(hard, 3, 0, p).entry);
    expect(new Set(entries).size, `all three routed to the same rung: ${entries.join(", ")}`).toBeGreaterThan(1);
  });

  test("with one rung configured there is no tradeoff to make, and none is claimed", () => {
    for (const preference of ["cost", "balanced", "quality"] as const) {
      const r = route(hard, 1, 0, preference);
      expect(r.entry).toBe(0);
      expect(r.verify, "nothing to climb to, so nothing to check for").toBe(false);
    }
  });

  test("quality does not depend on the agreement signal at all", () => {
    // The signal decays as models improve — a frontier model agrees with itself on most
    // hard items and is wrong on nearly half of those. An operator who asked for quality
    // must not have their answer gated on it.
    const r = route(hard, 4, 0, "quality");
    expect(r.verify).toBe(false);
    expect(r.entry).toBe(3);
  });
});
