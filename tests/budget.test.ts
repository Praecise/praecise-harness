/**
 * What fits in a request.
 *
 * Four things used to answer this question separately, each in its own file and
 * each counting characters as though it were the only one spending. These tests
 * are about the one answer that replaced them: that it is measured in the unit
 * an endpoint actually charges in, that the shares of a request add up to less
 * than the request, and that what is cut says so rather than stopping mid-word
 * and letting whatever reads it assume that was the end.
 */

import { describe, expect, it } from "vitest";

import { ROOM, budgetFor, clip, tokens, trim } from "../src/harness/budget.js";

describe("estimating what text costs", () => {
  it("counts about four Latin characters to the token", () => {
    expect(tokens("a".repeat(400))).toBe(100);
  });

  it("counts a script that is not Latin one for one, which overestimates", () => {
    // The safe direction to be wrong in: promising room that is not there is
    // how a request comes back refused for length after it has been paid for.
    const wide = "書".repeat(100);
    expect(tokens(wide)).toBe(100);
    expect(tokens(wide)).toBeGreaterThan(tokens("a".repeat(100)));
  });

  it("costs nothing for nothing", () => {
    expect(tokens("")).toBe(0);
  });
});

describe("dividing a request between what wants room", () => {
  it("leaves room for the answer, which is not a share of anything", () => {
    const budget = budgetFor(100_000);
    const spent =
      budget.instructions + budget.recall + budget.conversation + budget.toolOutput;
    expect(spent).toBeLessThan(100_000);
  });

  it("gives every share more room when the endpoint has more", () => {
    const small = budgetFor(64_000);
    const large = budgetFor(256_000);
    for (const share of ["instructions", "recall", "conversation", "toolOutput"] as const) {
      expect(large[share]).toBeGreaterThan(small[share]);
    }
  });

  it("assumes a modest endpoint when the app has not said", () => {
    expect(budgetFor()).toEqual(budgetFor(ROOM));
  });

  it("still divides something when told an implausibly small endpoint", () => {
    // An app that says 500 has misconfigured itself. Dividing zero four ways
    // would answer that by carrying nothing at all, which reads as a bug in
    // the framework rather than in the number it was handed.
    for (const share of Object.values(budgetFor(500))) {
      expect(share).toBeGreaterThan(0);
    }
  });
});

describe("cutting text down to what fits", () => {
  it("leaves text alone when it already fits", () => {
    expect(clip("short enough", 100)).toBe("short enough");
  });

  it("cuts to about the room it was given", () => {
    const cut = clip("a".repeat(4_000), 100);
    expect(tokens(cut)).toBeLessThanOrEqual(100);
  });

  it("cuts on a line ending when there is one near enough", () => {
    const text = `${"a".repeat(360)}\n${"b".repeat(400)}`;
    expect(clip(text, 100).endsWith("a")).toBe(true);
  });

  it("takes the middle rather than the end, and says how much went", () => {
    const text = `THE-BEGINNING${"x".repeat(40_000)}THE-END`;
    const cut = trim(text, 500);
    expect(cut).toContain("THE-BEGINNING");
    expect(cut).toContain("THE-END");
    expect(cut).toContain("omitted from the middle");
  });

  it("leaves text alone when the whole of it fits", () => {
    const text = "nothing here needs cutting";
    expect(trim(text, 1_000)).toBe(text);
  });

  it("tells whatever is reading how to get what is missing", () => {
    // A model handed a fragment with no sign it is one will answer from the
    // fragment. Saying so is what lets it go back and ask a narrower question.
    expect(trim("x".repeat(40_000), 500)).toContain("Ask again more narrowly");
  });

  it("keeps to the budget even when there is no room for the note", () => {
    const cut = trim("x".repeat(40_000), 20);
    expect(tokens(cut)).toBeLessThanOrEqual(20);
  });
});
