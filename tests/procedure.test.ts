import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkillBook, usableProcedures, renderSkills, type ProcedureCandidate } from "../src/harness/procedure.js";

describe("procedural memory (CoALA fourth type)", () => {
  it("usableProcedures keeps a named, described, cited procedure and drops the rest", () => {
    const kept = usableProcedures(
      [
        { name: "split-then-upload", recipe: "split the file, upload the parts", from: ["t1"] },
        { name: "", recipe: "x", from: ["t1"] },
        { name: "n", recipe: "", from: ["t1"] },
        { name: "made-up", recipe: "do a thing", from: ["nope"] },
      ],
      new Set(["t1", "t2"]),
    );
    expect(kept.map((p) => p.name)).toEqual(["split-then-upload"]);
    expect(kept[0]!.from).toEqual(["t1"]);
  });

  it("keeps the candidate->accept floor: nothing is used until accepted, accept replaces, reject clears", async () => {
    const dir = await mkdtemp(join(tmpdir(), "praecise-skills-"));
    try {
      const book = new SkillBook(dir);
      expect(await book.skills("bot")).toEqual([]);
      const candidate: ProcedureCandidate = {
        agent: "bot", at: 0,
        procedures: [{ name: "a", recipe: "way a", from: ["t1"] }, { name: "b", recipe: "way b", from: ["t2"] }],
      };
      await book.propose(candidate);
      expect((await book.pending("bot"))?.procedures.length).toBe(2);
      expect(await book.skills("bot")).toEqual([]); // still not in use
      const kept = await book.accept("bot", [0]); // accept only the first
      expect(kept.map((p) => p.name)).toEqual(["a"]);
      expect((await book.skills("bot")).map((p) => p.name)).toEqual(["a"]);
      expect(await book.pending("bot")).toBeUndefined(); // accepting cleared the candidate
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("renderSkills renders accepted procedures as an instruction block", () => {
    expect(renderSkills([{ name: "x", recipe: "do x", from: ["t1"] }])).toContain("- x: do x");
    expect(renderSkills([])).toBe("");
  });
});
