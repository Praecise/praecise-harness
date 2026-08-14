/**
 * Where a memory came from, and what that entitles it to.
 *
 * Citing source episodes is necessary and measurably not sufficient: against attacks
 * that launder a claim through a summary, derivation history alone still admits about
 * half of them. A list of ids says where a claim passed through, not whether it was
 * ever entitled to be believed — so authority travels with the note, downward only.
 */
import { describe, expect, test } from "vitest";
import { authorityOf, settle, type Note } from "../src/harness/consolidate.js";

describe("authority propagates through consolidation, and only downward", () => {
  test("a note is no more trusted than the least trusted thing it was drawn from", () => {
    expect(authorityOf(["user", "external"])).toBe("external");
    expect(authorityOf(["user", "tool"])).toBe("tool");
    expect(authorityOf(["user", "user"])).toBe("user");
  });

  test("summarising cannot upgrade what it summarises — the laundering step", () => {
    // One trusted source and one untrusted one is untrusted: the claim may rest
    // entirely on the untrusted half, and nothing downstream can tell which.
    expect(authorityOf(["user", "user", "user", "external"])).toBe("external");
  });

  test("a note drawn from nothing is treated as least trusted, not most", () => {
    expect(authorityOf([])).toBe("external");
  });
});

describe("contradictions are settled by arithmetic, not by asking a model", () => {
  const contradicts = (a: Note, b: Note) => a.text.split(" ")[0] === b.text.split(" ")[0];

  test("a person's correction outranks an agent's conclusion, however recent", () => {
    const kept = settle(
      [
        { text: "plan is annual", from: ["e1"], origin: "agent", at: 2_000 },
        { text: "plan is monthly", from: ["e2"], origin: "user", at: 1_000 },
      ],
      contradicts,
    );
    expect(kept).toHaveLength(1);
    expect(kept[0]?.text, "authority beats recency").toBe("plan is monthly");
  });

  test("between equals, the later claim wins — computed, never inferred", () => {
    const kept = settle(
      [
        { text: "plan is annual", from: ["e1"], origin: "user", at: 1_000 },
        { text: "plan is monthly", from: ["e2"], origin: "user", at: 9_000 },
      ],
      contradicts,
    );
    expect(kept[0]?.text).toBe("plan is monthly");
  });

  test("notes that do not contradict are all kept", () => {
    const kept = settle(
      [
        { text: "plan is annual", from: ["e1"] },
        { text: "export fails over a gigabyte", from: ["e2"] },
      ],
      contradicts,
    );
    expect(kept).toHaveLength(2);
  });

  test("an unlabelled note is an agent conclusion, and loses to a person", () => {
    const kept = settle(
      [
        { text: "plan is annual", from: ["e1"], at: 9_000 },
        { text: "plan is monthly", from: ["e2"], origin: "user", at: 1 },
      ],
      contradicts,
    );
    expect(kept[0]?.origin).toBe("user");
  });
});
