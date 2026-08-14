/**
 * Rules must not be the thing that gives when there is no room.
 *
 * Systems that compact a conversation into a summary and re-derive their instructions
 * from it lose constraints as they go: violation rates measured at 0% with the constraint
 * present and 78% after four rounds of compaction, and the loss is SELECTIVE rather than
 * random — summarisers preferentially drop what reads as procedural policy while keeping
 * hard prohibitions, so what survives is exactly the wrong half.
 *
 * This framework is structurally immune, and the immunity is worth pinning down because
 * it is a property of two design choices that a refactor could undo without noticing:
 *
 *   1. Instructions are recomposed from the SPEC on every request, never summarised from
 *      history. There is no compaction round for a rule to decay across.
 *   2. When instructions do not fit, KNOWLEDGE is what gives. The opening — the role and
 *      the rules — is subtracted from the budget first and returned unmodified, and the
 *      documents that do not fit are dropped with a stated problem rather than silently.
 *
 * These are static checks over the composing source rather than a runtime probe, because
 * the invariant is about which text is reachable by `clip` at all — a property of the
 * code, not of any one request.
 */
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../src/compile/plan.ts"),
  "utf8",
);

describe("constraints survive a squeezed context", () => {
  test("the composed instructions return the opening unmodified", () => {
    // `opening` holds the role and the rules. It is concatenated as-is; if a future
    // change wraps it in clip(), a rule becomes droppable and this fails.
    expect(source).toMatch(/return \[\.\.\.opening, \.\.\.reference, \.\.\.closing\]/);
    expect(source).not.toMatch(/clip\(\s*\[?\.\.\.?opening/);
    expect(source).not.toMatch(/opening\s*=\s*clip\(/);
  });

  test("only document content is ever clipped in this file", () => {
    const clipped = [...source.matchAll(/\bclip\(([^,]+),/g)].map((m) => m[1]?.trim());
    expect(clipped.length).toBeGreaterThan(0);
    for (const argument of clipped) {
      expect(argument, `clip() applied to ${argument} — only knowledge may give`).toMatch(/doc\./);
    }
  });

  test("the rules budget is taken before knowledge, not after", () => {
    // `left` is what remains AFTER the opening and closing are accounted for, so a
    // large document cannot crowd a rule out; it runs out of room itself instead.
    expect(source).toMatch(/left\s*=\s*limit\s*-\s*tokens\(\[\.\.\.opening, \.\.\.closing\]/);
  });

  test("knowledge that does not fit is reported, never dropped in silence", () => {
    expect(source).toMatch(/left <= 0/);
    expect(source).toMatch(/were left out/);
  });

  test("rules are composed into the opening, where nothing can clip them", () => {
    const opening = source.slice(source.indexOf("const opening"), source.indexOf("const closing"));
    expect(opening).toMatch(/spec\.rules/);
    expect(opening).toMatch(/without exception/);
  });
});
