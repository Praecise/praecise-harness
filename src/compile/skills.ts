/**
 * Authored skills, disclosed a step at a time.
 *
 * The same shape as knowledge that does not fit (see `outline.ts`): the instructions
 * carry a list, and one tool reads from it. What differs is that a skill is NEVER put in
 * whole. Its name and description are always in the instructions, its body is read when
 * the agent decides the skill applies, and the files beside it are read when the body
 * points at them — so twenty skills cost twenty lines until one is used.
 *
 * These are the skills a developer wrote in `skills/`. The procedures an agent learned
 * and a person accepted (`harness/procedure.ts`) are rendered separately, per request.
 *
 * The tool accepts only names and files that exist, and a file only from inside its own
 * skill. A name that does not exist is answered with the names that do.
 */

import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep, win32 } from "node:path";

import type { AgentSpec } from "../define.js";
import { tokens, trim } from "../harness/budget.js";
import type { AuthoredSkill } from "../project/skills.js";
import { SKILL_FILE } from "../project/skills.js";
import type { LocalTool } from "./plan.js";

export const READ_SKILL = "read_skill";

/**
 * The authored skills one agent may use.
 *
 * Left out, an agent has every skill in the folder — the default `memory/` has for
 * knowledge. A list narrows; `false` or an empty list is none.
 */
export function skillsFor(
  all: Record<string, AuthoredSkill> | undefined,
  spec: Pick<AgentSpec, "skills">,
  problems: string[],
): AuthoredSkill[] {
  const known = Object.keys(all ?? {}).sort();
  if (spec.skills === false) return [];
  if (!Array.isArray(spec.skills)) return known.map((name) => all![name]!);

  const chosen: AuthoredSkill[] = [];
  for (const name of new Set(spec.skills)) {
    const skill = all?.[name];
    if (skill) chosen.push(skill);
    else {
      problems.push(
        `\`skills\` names "${name}", and no such skill loaded; ` +
          (known.length ? `skills: ${known.join(", ")}` : `add skills/${name}/${SKILL_FILE}`),
      );
    }
  }
  return chosen;
}

/**
 * The part of the instructions that lists the skills.
 *
 * Built only from what was loaded, in the order given, so it is the same text on every
 * request: it sits in the prefix an endpoint caches.
 */
export function skillsSection(skills: AuthoredSkill[]): string {
  const lines = skills.map((skill) => `- ${skill.name}: ${skill.description.replace(/\s+/g, " ")}`);
  return (
    "Skills. Each is a written way of doing one kind of work. Before doing work a skill describes, " +
    `call ${READ_SKILL} with its name and follow what it says:\n${lines.join("\n")}`
  );
}

interface Listed {
  path: string;
  bytes: number;
}

/** A skill's files other than SKILL.md, by forward-slash path whatever the platform. */
async function filesOf(skill: AuthoredSkill): Promise<Listed[]> {
  const listed: Listed[] = [];
  for (const [path, text] of Object.entries(skill.files ?? {})) {
    listed.push({ path: posix.normalize(path.replace(/\\/g, "/")), bytes: Buffer.byteLength(text) });
  }
  if (skill.dir) {
    const entries = await readdir(skill.dir, { recursive: true }).catch(() => [] as string[]);
    for (const entry of entries) {
      const segments = entry.split(sep);
      if (segments.some((segment) => segment.startsWith("."))) continue;
      const path = segments.join("/");
      if (path === SKILL_FILE) continue;
      const info = await stat(resolve(skill.dir, entry)).catch(() => undefined);
      if (info?.isFile()) listed.push({ path, bytes: info.size });
    }
  }
  return listed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

async function existing(skill: AuthoredSkill): Promise<string> {
  const files = await filesOf(skill);
  return files.length ? `Files: ${files.map((file) => file.path).join(", ")}.` : "It has no files besides its instructions.";
}

/** Whether these bytes are something other than text. */
function isBinary(bytes: Buffer): boolean {
  if (bytes.subarray(0, 8192).includes(0)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return false;
  } catch {
    return true;
  }
}

/** One file from inside a skill, or the sentence saying why not. */
async function readFileOf(skill: AuthoredSkill, asked: string): Promise<string> {
  const wanted = asked.replace(/\\/g, "/");
  if (posix.isAbsolute(wanted) || win32.isAbsolute(asked)) {
    return `"${asked}" is an absolute path; give a path relative to the skill "${skill.name}". ${await existing(skill)}`;
  }
  const path = posix.normalize(wanted);
  const outside = `"${asked}" is outside the skill "${skill.name}"; only its own files can be read. ${await existing(skill)}`;
  if (path === ".." || path.startsWith("../")) return outside;
  const missing = async () => `Skill "${skill.name}" has no file "${asked}". ${await existing(skill)}`;

  const held = Object.entries(skill.files ?? {}).find(
    ([key]) => posix.normalize(key.replace(/\\/g, "/")) === path,
  );
  if (held) return held[1];
  if (!skill.dir) return missing();

  // Resolved twice: once as written, and once through any links, because a link inside
  // the skill that points out of it is the same escape as `..` by another spelling.
  const inside = (base: string, target: string): boolean => {
    const rel = relative(base, target);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  };
  const target = resolve(skill.dir, path);
  if (!inside(skill.dir, target)) return outside;
  const [realBase, realTarget] = await Promise.all([
    realpath(skill.dir).catch(() => undefined),
    realpath(target).catch(() => undefined),
  ]);
  if (!realBase || !realTarget) return missing();
  if (!inside(realBase, realTarget)) return outside;
  if (!(await stat(realTarget).catch(() => undefined))?.isFile()) return missing();

  const bytes = await readFile(realTarget);
  if (isBinary(bytes)) {
    return `"${path}" in skill "${skill.name}" is a binary file (${bytes.length.toLocaleString("en-US")} bytes) and cannot be read as text.`;
  }
  return bytes.toString("utf8");
}

/**
 * The tool that reads a skill's instructions, or one of its files.
 *
 * `limit` is the plan's budget for one tool's output, in tokens. A long reference is cut
 * in the middle with a note saying so, rather than costing the rest of the conversation.
 */
export function skillTool(skills: AuthoredSkill[], limit: number): LocalTool {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  const names = [...byName.keys()];
  return {
    name: READ_SKILL,
    description:
      "Read a skill's instructions before doing the kind of work it describes, or one of the files " +
      "those instructions point to. Only names from the skill list exist.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", enum: names, description: "The skill to read." },
        file: {
          type: "string",
          description:
            "A file in that skill, by the relative path its instructions give, such as references/guide.md. " +
            "Leave out to read the instructions.",
        },
      },
      required: ["name"],
    },
    effect: "read",
    // Written by the developer, like the role and the rules, so it may steer what follows.
    trust: "trusted",
    async run(args: Record<string, unknown>): Promise<string> {
      const name = String(args.name ?? "");
      const skill = byName.get(name);
      if (!skill) return `No skill named "${name}". Skills: ${names.join(", ")}.`;

      const file = typeof args.file === "string" ? args.file.trim() : "";
      if (file) return trim(await readFileOf(skill, file), limit);

      const files = await filesOf(skill);
      if (!files.length) return trim(skill.body, limit);
      const listing =
        `\n\nFiles in this skill. Read one by calling ${READ_SKILL} with \`file\`:\n` +
        files.map((entry) => `- ${entry.path} (${entry.bytes.toLocaleString("en-US")} bytes)`).join("\n");
      // The listing is what makes the rest reachable, so the body gives way before it does.
      const room = limit - tokens(listing);
      return room > 0 ? trim(skill.body, room) + listing : trim(skill.body + listing, limit);
    },
  };
}
