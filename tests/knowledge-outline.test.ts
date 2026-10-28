/**
 * Knowledge that does not fit.
 *
 * Documents used to be dropped from the end once the instructions were full, with a
 * warning and no way for the model to reach them. These tests are about what replaced
 * that: nothing changes while everything fits, an overflowing folder is outlined in
 * full with a tool to read from it, and the tool answers only for what exists.
 */

import { afterEach, describe, expect, it } from "vitest";

import { planAgent } from "../src/compile/plan.js";
import { READ_KNOWLEDGE, headingsOf, knowledgeTool, packKnowledge, sectionOf } from "../src/compile/outline.js";
import { loadProject } from "../src/project/load.js";
import { MODEL_ENV, TEST_MODELS, cleanup, FRAMEWORK, makeProject } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(cleanup));
});

const guide = "# Guide\nintro\n\n## Refunds\nWithin 30 days.\n\n### Exceptions\nNone for sale items.\n\n## Shipping\nThree days.\n";

describe("headings and sections", () => {
  it("finds headings and ignores those inside code fences", () => {
    const text = "# A\n```\n# not a heading\n```\n## B\n";
    expect(headingsOf(text).map((h) => h.title)).toEqual(["A", "B"]);
  });

  it("reads a section down to the next heading of the same or a higher level", () => {
    expect(sectionOf(guide, "Refunds")).toBe("## Refunds\nWithin 30 days.\n\n### Exceptions\nNone for sale items.");
    expect(sectionOf(guide, "exceptions")).toBe("### Exceptions\nNone for sale items.");
    expect(sectionOf(guide, "Missing")).toBeUndefined();
  });
});

describe("packing knowledge", () => {
  const docs = [
    { name: "a", content: "alpha ".repeat(100) },
    { name: "b", content: "# B\n" + "beta ".repeat(2000) },
  ];

  it("puts everything in whole when it fits, and needs no tool", () => {
    const packed = packKnowledge(docs, 100_000);
    expect(packed.outlined).toBe(false);
    expect(packed.text).toContain("--- a ---");
    expect(packed.text).toContain("--- b ---");
  });

  it("outlines every document when they do not fit, and keeps whole the ones that do", () => {
    const packed = packKnowledge(docs, 400);
    expect(packed.outlined).toBe(true);
    expect(packed.text).toContain("- a");
    expect(packed.text).toContain("- b");
    expect(packed.text).toContain("--- a ---");
    expect(packed.text).not.toContain("--- b ---");
    expect(packed.text).toContain(READ_KNOWLEDGE);
  });
});

describe("the read tool", () => {
  const tool = knowledgeTool([{ name: "guide", content: guide }]);

  it("reads a document or one section of it", () => {
    expect(tool.run({ name: "guide" })).toContain("## Shipping");
    expect(tool.run({ name: "guide", section: "Shipping" })).toBe("## Shipping\nThree days.");
  });

  it("answers an unknown name with the names that exist, not a guess", () => {
    expect(tool.run({ name: "guid" })).toBe('No document named "guid". Documents: guide.');
  });

  it("answers an unknown heading with the headings that exist", () => {
    expect(tool.run({ name: "guide", section: "Returns" })).toContain("Headings: Guide; Refunds; Exceptions; Shipping.");
  });

  it("offers only the names that exist as the choices", () => {
    const props = tool.parameters.properties as { name: { enum: string[] } };
    expect(props.name.enum).toEqual(["guide"]);
  });
});

describe("planning an agent", () => {
  async function planFor(files: Record<string, string>) {
    const root = await makeProject({
      ...TEST_MODELS,
      "agents/a.ts": `import { agent } from "${FRAMEWORK}";
        export default agent({ role: "Help.", quality: "fast", memory: false });`,
      ...files,
    });
    roots.push(root);
    const loaded = await loadProject(root);
    return planAgent(loaded, loaded.agents.a!, { env: MODEL_ENV });
  }

  it("changes nothing for a folder that fits", async () => {
    const plan = await planFor({ "memory/guide.md": guide });
    expect(plan.locals.map((t) => t.name)).not.toContain(READ_KNOWLEDGE);
    expect(plan.instructions).toContain("--- guide ---");
    expect(plan.problems).toEqual([]);
  });

  it("outlines a folder that overflows instead of dropping its last files", async () => {
    const big = (word: string) => `# ${word}\n\n## Part\n` + `${word} `.repeat(30_000);
    const plan = await planFor({
      "memory/one.md": big("one"),
      "memory/two.md": big("two"),
      "memory/three.md": big("three"),
    });
    expect(plan.locals.map((t) => t.name)).toContain(READ_KNOWLEDGE);
    for (const name of ["one", "two", "three"]) expect(plan.instructions).toContain(`- ${name}`);
    expect(plan.problems.join(" ")).not.toContain("left out");
  });
});
