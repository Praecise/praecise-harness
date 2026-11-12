/**
 * Authored skills: `skills/<name>/SKILL.md`.
 *
 * A skill is disclosed a step at a time — its name and description in the instructions,
 * its body when the agent reads it, its other files when the body points at them. These
 * tests are about each step, and about the reader answering only for what exists and
 * only from inside the skill.
 */

import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { planAgent, shapedFor } from "../src/compile/plan.js";
import { READ_SKILL, skillTool } from "../src/compile/skills.js";
import { loadProject } from "../src/project/load.js";
import { parseSkillFile, skillFrom } from "../src/project/skills.js";
import { createApp, defineApp, mergeApps } from "../src/sdk.js";
import { MODEL_ENV, TEST_MODELS, cleanup, FRAMEWORK, makeProject } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(cleanup));
});

async function project(files: Record<string, string>) {
  const root = await makeProject({ ...TEST_MODELS, ...files });
  roots.push(root);
  return loadProject(root);
}

const skillFile = (name: string, description: string, body = "Do the thing.") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

const agentFile = (extra = "") =>
  `import { agent } from "${FRAMEWORK}";
   export default agent({ role: "You help customers.", ${extra} });`;

const REFUNDS = {
  "skills/refunds/SKILL.md": skillFile(
    "refunds",
    "Issue a refund. Use when a customer asks for money back.",
    "# Refunds\n\nCheck the order, then see references/policy.md.",
  ),
  "skills/refunds/references/policy.md": "Refunds are allowed within 30 days.",
  "skills/refunds/scripts/check.py": "print('ok')\n",
};

describe("frontmatter", () => {
  it("reads plain values, quoted strings, comments and one nested map", () => {
    const parsed = parseSkillFile(
      [
        "---",
        "# a comment",
        "name: pdf-forms",
        'description: "Fill forms: PDF only. Say \\"done\\" after."',
        "license: 'It''s MIT'   # trailing comment",
        "compatibility: Needs network access # and this goes",
        "metadata:",
        "  author: someone",
        '  version: "1.0"',
        "allowed-tools: Read Bash(git:*)",
        "---",
        "",
        "Body text.",
        "",
      ].join("\r\n"),
    );
    expect(parsed.faults).toEqual([]);
    expect(parsed.fields).toEqual({
      name: "pdf-forms",
      description: 'Fill forms: PDF only. Say "done" after.',
      license: "It's MIT",
      compatibility: "Needs network access",
      metadata: { author: "someone", version: "1.0" },
      "allowed-tools": "Read Bash(git:*)",
    });
    expect(parsed.body).toBe("Body text.");
  });

  it("refuses what it does not read, naming the line", () => {
    const faults = (front: string[]) => parseSkillFile(["---", ...front, "---", "body"].join("\n")).faults;

    expect(faults(["name: a", "description: {a: b}"])[0]).toMatch(/^line 3: this YAML is not read here/);
    expect(faults(["name: a", "tags: [one, two]"])[0]).toMatch(/^line 3: this YAML is not read here/);
    expect(faults(["name: a", "description: >2", "    x"])[0]).toMatch(/^line 3: /);
    expect(faults(["name: a", "description: &anchor text"])[0]).toMatch(/^line 3: /);
    expect(faults(["name: a", "- item"])[0]).toMatch(/^line 3: expected `key: value`/);
    expect(faults(["name: a", "description: uses: colons"])[0]).toMatch(/^line 3: .*quotes/);
    expect(faults(['name: "open'])[0]).toMatch(/^line 2: .*never closed/);
    expect(faults(["name: a", "name: b"])[0]).toMatch(/^line 3: "name" is given twice/);
    expect(faults(["name: a", "  stray: value"])[0]).toMatch(/^line 3: unexpected indentation/);
    expect(faults(["metadata:", "  deep:", "    deeper: x"])[0]).toMatch(/^line 3: /);
  });

  const front = (lines: string[]) => parseSkillFile(["---", ...lines, "---", "body"].join("\n"));

  it("folds a `>` block: line breaks become spaces, blank lines become line breaks", () => {
    const parsed = front([
      "name: a",
      "description: >",
      "  Fill in PDF forms.",
      "  Use when a form",
      "  needs filling: always.",
      "",
      "  Second paragraph. # not a comment",
      "license: MIT",
    ]);
    expect(parsed.faults).toEqual([]);
    expect(parsed.fields.description).toBe(
      "Fill in PDF forms. Use when a form needs filling: always.\nSecond paragraph. # not a comment\n",
    );
    expect(parsed.fields.license).toBe("MIT");
  });

  it("keeps the lines of a `|` block, and a further-indented line of a `>` block", () => {
    const literal = front(["description: |", "    First line.", "      indented", "", "    Last line.", "name: a"]);
    expect(literal.faults).toEqual([]);
    expect(literal.fields.description).toBe("First line.\n  indented\n\nLast line.\n");
    expect(literal.fields.name).toBe("a");

    expect(front(["description: >", "  one", "    two", "  three"]).fields.description).toBe("one\n  two\nthree\n");
  });

  it("honours the chomping indicator: strip, keep, and clip by default", () => {
    const block = (head: string) => front([`description: ${head}`, "  text", "", "", "name: a"]).fields.description;
    expect(block(">-")).toBe("text");
    expect(block("|-")).toBe("text");
    expect(block(">")).toBe("text\n");
    expect(block("|")).toBe("text\n");
    expect(block("|+")).toBe("text\n\n\n");
    expect(block(">- # why")).toBe("text");
    expect(front(["description: >", "name: a"]).fields).toEqual({ description: "", name: "a" });
  });

  it("names the line of a block that is indented unevenly", () => {
    expect(front(["description: |", "    one", "  two"]).faults).toEqual([
      "line 4: indented less than the first line of its block; line the block up",
    ]);
  });

  it("reads a block description into a skill that passes the rules", () => {
    const parsed = front(["name: pdf", "description: >-", "  Fill forms.", "  Use for PDFs."]);
    const { skill, faults } = skillFrom("pdf", parsed.fields, parsed.body);
    expect(faults).toEqual([]);
    expect(skill!.description).toBe("Fill forms. Use for PDFs.");
  });

  it("joins a list of tool names under allowed-tools", () => {
    const parsed = front([
      "name: a",
      "allowed-tools:",
      "  - Read",
      "  # the shell, for git only",
      '  - "Bash(git:*)"',
      "",
      "  - Write # trailing",
      "description: x",
    ]);
    expect(parsed.faults).toEqual([]);
    expect(parsed.fields["allowed-tools"]).toBe("Read Bash(git:*) Write");
    expect(parsed.fields.description).toBe("x");
    expect(skillFrom("a", parsed.fields, "b").skill!.allowedTools).toEqual(["Read", "Bash(git:*)", "Write"]);

    // At the key's own indentation, which YAML also allows.
    expect(front(["allowed-tools:", "- Read", "- Write"]).fields["allowed-tools"]).toBe("Read Write");
  });

  it("refuses a list anywhere else, and a list of anything but plain text", () => {
    expect(front(["name: a", "description:", "  - one", "  - two"]).faults).toEqual([
      "line 4: `description` does not take a list; only `allowed-tools` does",
    ]);
    expect(front(["metadata:", "  - one"]).faults[0]).toMatch(/^line 3: `metadata` does not take a list/);
    expect(front(["allowed-tools:", "  - Read", "  - [a, b]"]).faults[0]).toMatch(/^line 4: this YAML is not read here/);
    expect(front(["allowed-tools:", "  - Read", "  -"]).faults[0]).toMatch(/^line 4: a list item needs a value/);
    expect(front(["allowed-tools:", "  - Read", "    - nested"]).faults[0]).toMatch(/^line 4: /);
    expect(front(["allowed-tools:", "  - Read", "  - name: x"]).faults[0]).toMatch(/^line 4: /);
    expect(front(["allowed-tools:", "  - Read", "  - Bad"]).fields["allowed-tools"]).toBe("Read Bad");
    expect(front(["allowed-tools:", "  - [a]"]).fields["allowed-tools"]).toBeUndefined();
  });

  it("requires the frontmatter to be opened and closed", () => {
    expect(parseSkillFile("# Just a heading\n").faults[0]).toMatch(/^line 1: expected `---`/);
    expect(parseSkillFile("---\nname: a\n").faults[0]).toMatch(/never closed/);
  });
});

describe("the rules of the format", () => {
  const check = (fields: Record<string, unknown>, body = "Body.") =>
    skillFrom("refunds", { name: "refunds", description: "Issue a refund.", ...fields }, body);

  it("accepts a skill that follows them", () => {
    const { skill, faults, advice } = check({
      license: "MIT",
      compatibility: "Needs network access",
      metadata: { author: "someone" },
      "allowed-tools": "Read  Write",
    });
    expect(faults).toEqual([]);
    expect(advice).toEqual([]);
    expect(skill).toMatchObject({
      name: "refunds",
      description: "Issue a refund.",
      body: "Body.",
      license: "MIT",
      metadata: { author: "someone" },
      allowedTools: ["Read", "Write"],
    });
  });

  it("requires a name, of the right shape, equal to the folder", () => {
    expect(check({ name: undefined }).faults[0]).toMatch(/`name` is required/);
    expect(check({ name: "Refunds" }).faults[0]).toMatch(/lowercase letters, digits and single hyphens/);
    expect(check({ name: "re_funds" }).faults[0]).toMatch(/lowercase/);
    expect(check({ name: "-refunds" }).faults[0]).toMatch(/lowercase/);
    expect(check({ name: "returns" }).faults).toEqual(['`name` "returns" must equal the skill\'s folder name, "refunds"']);
    const long = "a".repeat(65);
    expect(skillFrom(long, { name: long, description: "x" }, "b").faults[0]).toMatch(/65 characters; the limit is 64/);
    expect(check({ name: "returns" }).skill).toBeUndefined();
  });

  it("requires a description of at most 1024 characters", () => {
    expect(check({ description: undefined }).faults[0]).toMatch(/`description` is required/);
    expect(check({ description: "  " }).faults[0]).toMatch(/`description` is required/);
    expect(check({ description: "d".repeat(1025) }).faults[0]).toMatch(/1025 characters; the limit is 1024/);
    expect(check({ description: "d".repeat(1024) }).faults).toEqual([]);
  });

  it("limits compatibility and types the optional fields", () => {
    expect(check({ compatibility: "c".repeat(501) }).faults[0]).toMatch(/501 characters; the limit is 500/);
    expect(check({ metadata: "flat" }).faults[0]).toMatch(/`metadata` must be a map/);
    expect(check({ license: { nested: "x" } }).faults[0]).toMatch(/`license` must be text/);
    expect(check({ "allowed-tools": { a: "b" } }).faults[0]).toMatch(/`allowed-tools`/);
  });

  it("advises on a long body and an unknown field without refusing the skill", () => {
    const long = check({}, Array.from({ length: 501 }, (_, i) => `line ${i}`).join("\n"));
    expect(long.faults).toEqual([]);
    expect(long.advice[0]).toMatch(/501 lines; keep it under 500/);
    expect(long.skill).toBeDefined();

    const extra = check({ version: "2" });
    expect(extra.faults).toEqual([]);
    expect(extra.advice[0]).toMatch(/`version` is not part of the skill format/);
  });
});

describe("loading skills/", () => {
  it("finds each skill and leaves its other files on disk", async () => {
    const loaded = await project({
      ...REFUNDS,
      "skills/shipping/SKILL.md": skillFile("shipping", "Quote a delivery date."),
      "skills/README.md": "not a skill",
    });
    expect(loaded.faults).toEqual([]);
    expect(Object.keys(loaded.skills ?? {})).toEqual(["refunds", "shipping"]);
    const refunds = loaded.skills!.refunds!;
    expect(refunds.description).toBe("Issue a refund. Use when a customer asks for money back.");
    expect(refunds.body).toContain("# Refunds");
    expect(refunds.body).not.toContain("---");
    expect(refunds.files).toBeUndefined();
  });

  it("reports a broken skill as a fault, with forward slashes, and does not load it", async () => {
    const loaded = await project({
      "skills/returns/SKILL.md": skillFile("refunds", "Wrong name."),
      "skills/folded/SKILL.md": "---\nname: folded\ndescription: [a, b]\n---\nbody",
      "skills/empty/notes.md": "no skill file here",
    });
    expect(loaded.skills).toEqual({});
    expect(loaded.faults).toContain(
      'skills/returns/SKILL.md: `name` "refunds" must equal the skill\'s folder name, "returns"',
    );
    expect(loaded.faults!.some((f) => f.startsWith("skills/folded/SKILL.md: line 3: "))).toBe(true);
    expect(loaded.faults).toContain("skills/empty: no SKILL.md; a skill is a folder holding one");
    expect(loaded.faults!.join("\n")).not.toContain("\\");
  });

  it("warns, without a fault, when a body runs past 500 lines", async () => {
    const loaded = await project({
      "skills/long/SKILL.md": skillFile("long", "A long one.", "line\n".repeat(600)),
    });
    expect(loaded.faults).toEqual([]);
    expect(loaded.warnings.some((w) => w.startsWith("skills/long/SKILL.md: the body is 600 lines"))).toBe(true);
    expect(loaded.skills!.long).toBeDefined();
  });
});

describe("skills on an agent", () => {
  const two = {
    ...REFUNDS,
    "skills/shipping/SKILL.md": skillFile("shipping", "Quote a delivery date."),
  };
  const plan = async (files: Record<string, string>, agent = "support") => {
    const loaded = await project(files);
    return planAgent(loaded, loaded.agents[agent]!, { env: MODEL_ENV });
  };
  const skillNames = (p: { locals: { name: string; parameters: Record<string, unknown> }[] }) => {
    const tool = p.locals.find((t) => t.name === READ_SKILL);
    return tool ? (tool.parameters.properties as { name: { enum: string[] } }).name.enum : undefined;
  };

  it("has every skill when it does not say", async () => {
    const p = await plan({ ...two, "agents/support.ts": agentFile() });
    expect(skillNames(p)).toEqual(["refunds", "shipping"]);
    expect(p.problems).toEqual([]);
  });

  it("is narrowed by a list", async () => {
    const p = await plan({ ...two, "agents/support.ts": agentFile('skills: ["shipping"]') });
    expect(skillNames(p)).toEqual(["shipping"]);
    expect(p.instructions).not.toContain("refunds:");
  });

  it("has none when it says false or gives an empty list", async () => {
    for (const off of ["skills: false", "skills: []"]) {
      const p = await plan({ ...two, "agents/support.ts": agentFile(off) });
      expect(skillNames(p)).toBeUndefined();
      expect(p.instructions).toBe("You help customers.");
    }
  });

  it("reports a skill that does not exist, and keeps the ones that do", async () => {
    const p = await plan({ ...two, "agents/support.ts": agentFile('skills: ["refunds", "returns"]') });
    expect(skillNames(p)).toEqual(["refunds"]);
    expect(p.problems).toEqual(['`skills` names "returns", and no such skill loaded; skills: refunds, shipping']);
  });

  it("adds nothing to an app with no skills", async () => {
    const p = await plan({ "agents/support.ts": agentFile() });
    expect(p.locals).toEqual([]);
    expect(p.instructions).toBe("You help customers.");
  });

  it("lists names and descriptions in the instructions, and never the body", async () => {
    const p = await plan({
      ...two,
      "agents/support.ts": agentFile('rules: ["Be brief."], returns: { answer: "the reply" }'),
    });
    expect(p.instructions).toContain(`call ${READ_SKILL} with its name`);
    expect(p.instructions).toContain("- refunds: Issue a refund. Use when a customer asks for money back.");
    expect(p.instructions).toContain("- shipping: Quote a delivery date.");
    expect(p.instructions).not.toContain("# Refunds");

    // Ahead of the output shape, which a step replaces: the list must outlive that.
    const at = (text: string) => p.instructions.indexOf(text);
    expect(at("Be brief.")).toBeLessThan(at("- refunds:"));
    expect(at("- refunds:")).toBeLessThan(at("Reply with JSON"));
    expect(shapedFor(p, { verdict: "yes or no" }).instructions).toContain("- refunds:");
  });

  it("writes the same instructions every time", async () => {
    const files = { ...two, "agents/support.ts": agentFile() };
    expect((await plan(files)).instructions).toBe((await plan(files)).instructions);
  });

  it("reports a tool that already has the reader's name", async () => {
    const p = await plan({
      ...REFUNDS,
      "agents/support.ts": agentFile(`tools: ["${READ_SKILL}"]`),
      [`functions/${READ_SKILL}.ts`]: `import { fn } from "${FRAMEWORK}";
        export default fn({ description: "Mine.", run: () => "x" });`,
    });
    expect(p.problems.some((x) => x.includes("rename the one in tools"))).toBe(true);
  });
});

describe("read_skill", () => {
  const reader = async (files: Record<string, string> = REFUNDS, limit = 10_000) => {
    const loaded = await project(files);
    const tool = skillTool(Object.values(loaded.skills ?? {}), limit);
    return { root: loaded.root, read: (args: Record<string, unknown>) => tool.run(args) as Promise<string>, tool };
  };

  it("is a trusted read", async () => {
    const { tool } = await reader();
    expect(tool.name).toBe("read_skill");
    expect(tool.effect).toBe("read");
    expect(tool.trust).toBe("trusted");
  });

  it("returns the body, then the skill's other files with their sizes", async () => {
    const { read } = await reader();
    const text = await read({ name: "refunds" });
    expect(text.startsWith("# Refunds")).toBe(true);
    expect(text).not.toContain("description:");
    expect(text).toContain("- references/policy.md (35 bytes)");
    expect(text).toContain("- scripts/check.py (12 bytes)");
    expect(text).not.toContain("SKILL.md");
    expect(text).not.toContain("\\");
  });

  it("returns only the body when there is nothing beside it", async () => {
    const { read } = await reader({ "skills/solo/SKILL.md": skillFile("solo", "Alone.", "Just this.") });
    expect(await read({ name: "solo" })).toBe("Just this.");
  });

  it("returns one file by its relative path, in either slash", async () => {
    const { read } = await reader();
    expect(await read({ name: "refunds", file: "references/policy.md" })).toBe("Refunds are allowed within 30 days.");
    expect(await read({ name: "refunds", file: "references\\policy.md" })).toBe("Refunds are allowed within 30 days.");
    expect(await read({ name: "refunds", file: "./scripts/../references/policy.md" })).toBe(
      "Refunds are allowed within 30 days.",
    );
  });

  it("refuses to leave the skill", async () => {
    const { read, root } = await reader({
      ...REFUNDS,
      "skills/other/SKILL.md": skillFile("other", "Another."),
      "secret.txt": "the secret",
    });
    for (const file of ["../../secret.txt", "..\\..\\secret.txt", "references/../../other/SKILL.md", ".."]) {
      const answer = await read({ name: "refunds", file });
      expect(answer).toContain('is outside the skill "refunds"');
      expect(answer).not.toContain("the secret");
      expect(answer).toContain("references/policy.md");
    }
    for (const file of ["/etc/passwd", join(root, "secret.txt"), "C:\\Windows\\win.ini", "\\\\host\\share\\x"]) {
      const answer = await read({ name: "refunds", file });
      expect(answer).toContain("is an absolute path");
      expect(answer).not.toContain("the secret");
    }
  });

  it("refuses a link that points out of the skill", async () => {
    const { read, root } = await reader({ ...REFUNDS, "secret.txt": "the secret" });
    try {
      await symlink(join(root, "secret.txt"), join(root, "skills", "refunds", "references", "link.txt"));
    } catch {
      return; // links need a privilege this machine did not grant; nothing to test
    }
    const answer = await read({ name: "refunds", file: "references/link.txt" });
    expect(answer).toContain('is outside the skill "refunds"');
    expect(answer).not.toContain("the secret");
  });

  it("says a binary file is binary rather than returning it", async () => {
    const { read, root } = await reader();
    await writeFile(join(root, "skills", "refunds", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 0xff]));
    expect(await read({ name: "refunds", file: "logo.png" })).toBe(
      '"logo.png" in skill "refunds" is a binary file (8 bytes) and cannot be read as text.',
    );
  });

  it("answers an unknown skill or file with the ones that exist", async () => {
    const { read } = await reader();
    expect(await read({ name: "returns" })).toBe('No skill named "returns". Skills: refunds.');
    expect(await read({ name: "refunds", file: "references/missing.md" })).toBe(
      'Skill "refunds" has no file "references/missing.md". Files: references/policy.md, scripts/check.py.',
    );
    expect(await read({ name: "refunds", file: "references" })).toContain('has no file "references"');
  });

  it("cuts a read to the tool-output budget and says so", async () => {
    const { read } = await reader(
      {
        "skills/big/SKILL.md": skillFile("big", "Large.", "word ".repeat(4000)),
        "skills/big/references/long.md": "text ".repeat(4000),
      },
      500,
    );
    const file = await read({ name: "big", file: "references/long.md" });
    expect(file.length).toBeLessThan(4000);
    expect(file).toContain("characters omitted from the middle");

    // The listing survives the cut: it is how the rest is reached.
    const body = await read({ name: "big" });
    expect(body).toContain("characters omitted from the middle");
    expect(body).toContain("- references/long.md");
  });
});

describe("skills defined in code", () => {
  const refunds = {
    description: "Issue a refund. Use when a customer asks for money back.",
    body: "Check the order, then see references/policy.md.",
    files: { "references/policy.md": "Refunds are allowed within 30 days." },
    metadata: { author: "someone" },
  };
  const support = { kind: "agent" as const, role: "You help customers." };

  it("produces what the folder produces", async () => {
    const defined = defineApp({ agents: { support }, skills: { refunds } });
    expect(defined.faults).toEqual([]);
    expect(defined.skills!.refunds).toMatchObject({ name: "refunds", metadata: { author: "someone" } });

    const p = await planAgent(defined, defined.agents.support!, { env: {} });
    expect(p.instructions).toContain("- refunds: Issue a refund.");
    const tool = p.locals.find((t) => t.name === READ_SKILL)!;
    const body = (await tool.run({ name: "refunds" })) as string;
    expect(body).toContain("Check the order");
    expect(body).toContain("- references/policy.md (35 bytes)");
    expect(await tool.run({ name: "refunds", file: "references/policy.md" })).toBe("Refunds are allowed within 30 days.");
    expect(await tool.run({ name: "refunds", file: "../x" })).toContain("is outside the skill");
    expect(await tool.run({ name: "refunds", file: "nope.md" })).toBe(
      'Skill "refunds" has no file "nope.md". Files: references/policy.md.',
    );
  });

  it("holds a skill to the same rules, and refuses to start on a broken one", async () => {
    const defined = defineApp({
      agents: { support },
      skills: {
        Bad_Name: { description: "x", body: "y" },
        mismatch: { name: "other", description: "x", body: "y" },
        blank: { description: "", body: "y" },
      },
    });
    expect(defined.skills).toEqual({});
    expect(defined.faults!.some((f) => f.startsWith('skill "Bad_Name": `name` "Bad_Name" may hold only'))).toBe(true);
    expect(defined.faults).toContain('skill "mismatch": `name` "other" must equal the skill\'s folder name, "mismatch"');
    expect(defined.faults!.some((f) => f.startsWith('skill "blank": `description` is required'))).toBe(true);

    await expect(createApp({ agents: { support }, skills: { Bad_Name: { description: "x", body: "y" } } })).rejects.toThrow(
      /skill "Bad_Name"/,
    );
  });

  it("merges skills and reports one defined twice", () => {
    const merged = mergeApps(
      { skills: { refunds } },
      { skills: { refunds: { ...refunds, body: "Newer." }, shipping: { description: "Quote a date.", body: "b" } } },
    );
    expect(Object.keys(merged.skills!)).toEqual(["refunds", "shipping"]);
    expect(merged.skills!.refunds!.body).toBe("Newer.");
    expect(merged.collisions).toEqual(['skill "refunds" is defined more than once']);
  });
});
