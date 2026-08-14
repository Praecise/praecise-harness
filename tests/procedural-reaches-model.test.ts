/**
 * A procedure an agent has been given, and a person has accepted, must reach the model.
 *
 * It did not. `SkillBook` wrote procedures to a store behind a proper acceptance floor,
 * `renderSkills` produced a prompt block for them, and NOTHING inserted that block — so
 * the fourth memory type was write-only and an agent could accumulate procedures it was
 * never able to use. Nothing failed; the feature simply had no effect.
 *
 * The repo's own tests could not catch it: each half worked when called, and neither
 * proved the halves were joined.
 */
import { describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillBook, renderSkills } from "../src/harness/procedure.js";

async function withBook(run: (book: SkillBook, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "praecise-skills-"));
  try {
    await run(new SkillBook(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("procedural memory is reachable, not merely stored", () => {
  test("an accepted procedure renders into a block a prompt can carry", async () => {
    await withBook(async (book) => {
      await book.propose({
        agent: "support",
        at: Date.now(),
        procedures: [{ name: "refund over a gigabyte", recipe: "check the file size first", from: ["e1"] }],
      });
      const accepted = await book.accept("support");
      expect(accepted.length, "the floor let it through").toBeGreaterThan(0);

      const block = renderSkills(await book.skills("support"));
      expect(block).toContain("refund over a gigabyte");
      expect(block).toContain("check the file size first");
    });
  });

  test("an agent with nothing accepted contributes nothing to the prompt", async () => {
    await withBook(async (book) => {
      expect(renderSkills(await book.skills("support"))).toBe("");
    });
  });

  test("a proposal nobody accepted never renders — the floor is the point", async () => {
    await withBook(async (book) => {
      await book.propose({
        agent: "support",
        at: Date.now(),
        procedures: [{ name: "wire the money first", recipe: "skip the checks", from: ["e1"] }],
      });
      // Proposed, not accepted. It must not reach a model.
      expect(renderSkills(await book.skills("support"))).toBe("");
    });
  });
});
