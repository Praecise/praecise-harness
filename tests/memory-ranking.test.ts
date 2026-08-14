/**
 * The near-miss problem: a long, topically-adjacent, WRONG episode outranking the short
 * right one — measured at better than 2× on a real store before this was fixed.
 *
 * It matters more than an ordinary mis-ranking. Wrong-but-related context measurably
 * drags an answer off course, while unrelated text is close to harmless — so a scoring
 * rule that rewards length is optimising for the single worst thing it can retrieve.
 */
import { describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Memory } from "../src/harness/memory.js";

async function withMemory(run: (m: Memory) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "praecise-rank-"));
  try {
    await run(new Memory(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("recall does not reward an episode for being long", () => {
  test("the short right answer beats the long wrong neighbour", async () => {
    await withMemory(async (memory) => {
      // Short and exactly on point.
      await memory.record("a", {
        input: "what is the refund window",
        answer: "thirty days from delivery",
      });
      // Long, same vocabulary, and does NOT answer the question. This is the shape
      // that used to win: more words means more query terms present.
      await memory.record("a", {
        input: "refund policy discussion refund shipping refund window delivery refund",
        answer: [
          "we talked about refund handling and the refund team and refund tooling",
          "and shipping delivery windows and the delivery partner and delivery scans",
          "and the window for escalation and the window for review and refund audits",
          "without ever settling what the refund window actually is",
        ].join(" "),
      });

      const found = await memory.recall("a", "what is the refund window", 2);
      expect(found[0]?.answer, "the concise answer must rank first").toBe(
        "thirty days from delivery",
      );
    });
  });

  test("a thorough episode is still findable — length is penalised, not disqualifying", async () => {
    await withMemory(async (memory) => {
      await memory.record("a", {
        input: "how do I export data",
        answer: [
          "open settings, choose export, pick a format, confirm the range,",
          "wait for the mail, and download within seven days before the link expires",
        ].join(" "),
      });
      const found = await memory.recall("a", "how do I export data", 3);
      expect(found).toHaveLength(1);
    });
  });

  test("an episode sharing no terms is not retrieved at all", async () => {
    await withMemory(async (memory) => {
      await memory.record("a", { input: "refund window", answer: "thirty days" });
      const found = await memory.recall("a", "kubernetes ingress certificate rotation", 3);
      expect(found).toHaveLength(0);
    });
  });
});
