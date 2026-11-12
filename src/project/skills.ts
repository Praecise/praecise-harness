/**
 * Authored skills: `skills/<name>/SKILL.md`, the open Agent Skills format.
 *
 * An authored skill is a file a developer wrote: a description of one kind of work and
 * the way to do it, with any scripts, references and assets beside it. It is NOT the
 * `SkillBook` in `harness/procedure.ts` — those are procedures an agent proposed from
 * its own traces and a person accepted. One is written, the other is learned, and they
 * reach the model by different routes.
 *
 * Only the name and description are loaded into an agent's instructions. The body is
 * read when the agent decides the skill applies, and the files beside it when the body
 * points at them (see `compile/skills.ts`). So nothing here reads `scripts/`,
 * `references/` or `assets/`: the loader's job ends at SKILL.md.
 *
 * The frontmatter is parsed by hand because the framework has no dependencies and the
 * format needs very little YAML: `key: value`, quoted strings, and one nested map of
 * strings. Anything past that is refused with the line it is on, rather than read
 * approximately.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { Findings } from "./load.js";

/** The folder authored skills live in. */
export const SKILLS_DIR = "skills";
/** The one file a skill must have. */
export const SKILL_FILE = "SKILL.md";

const NAME_MAX = 64;
const DESCRIPTION_MAX = 1024;
const COMPATIBILITY_MAX = 500;
/** Past this the body is better split into `references/`; advice, not a rule. */
const BODY_LINES = 500;

/** An authored skill, checked and ready to offer to an agent. */
export interface AuthoredSkill {
  /** The directory name, which the format requires `name` to equal. */
  name: string;
  /** What the skill does and when to use it — the only part an agent reads up front. */
  description: string;
  /** SKILL.md below the frontmatter. */
  body: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  /** `allowed-tools`, split. Carried, not enforced: the format marks it experimental. */
  allowedTools?: string[];
  /** Absolute path of the skill's directory, when it came from a folder. */
  dir?: string;
  /** The skill's other files by relative path, when it was defined in code. */
  files?: Record<string, string>;
}

/** An authored skill as written in code; the record key is its name. */
export interface AuthoredSkillInput {
  /** Optional, and must equal the record key when given. */
  name?: string;
  description: string;
  body: string;
  /** Other files by path relative to the skill, such as `references/policy.md`. */
  files?: Record<string, string>;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string[] | string;
}

export interface ParsedSkillFile {
  fields: Record<string, string | Record<string, string>>;
  body: string;
  /** Each names the line it is about. */
  faults: string[];
}

const UNSUPPORTED = "only plain and quoted strings are supported; write the value on one line, in quotes if needed";

/** One scalar: a quoted string, or plain text up to a comment. */
function scalar(raw: string): { value: string } | { fault: string } {
  const text = raw.trim();
  const quote = text[0];
  if (quote === '"' || quote === "'") {
    let value = "";
    let at = 1;
    for (; at < text.length; at++) {
      const char = text[at]!;
      if (quote === '"' && char === "\\") {
        const next = text[++at];
        if (next === undefined) break;
        value += next === "n" ? "\n" : next === "t" ? "\t" : next;
      } else if (char === quote) {
        // In single quotes a doubled quote is a literal one.
        if (quote === "'" && text[at + 1] === "'") {
          value += "'";
          at++;
        } else break;
      } else value += char;
    }
    if (at >= text.length) return { fault: `the string opened with ${quote} is never closed` };
    const rest = text.slice(at + 1).trim();
    if (rest && !rest.startsWith("#")) return { fault: "there is text after the closing quote" };
    return { value };
  }
  if (/^[[{|>&*!%@`]/.test(text) || text === "-" || text.startsWith("- ")) return { fault: UNSUPPORTED };
  const comment = text.search(/\s#/);
  const value = (comment < 0 ? text : text.slice(0, comment)).trim();
  if (value.includes(": ") || value.endsWith(":")) {
    return { fault: "a value containing a colon followed by a space must be in quotes" };
  }
  return { value };
}

/** Split SKILL.md into its frontmatter fields and its body. */
export function parseSkillFile(text: string): ParsedSkillFile {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const fields: ParsedSkillFile["fields"] = {};
  const faults: string[] = [];

  if (lines[0]?.trimEnd() !== "---") {
    return { fields, body: "", faults: ["line 1: expected `---` opening the frontmatter"] };
  }
  const close = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  if (close < 0) {
    return { fields, body: "", faults: ["line 1: the frontmatter is never closed; end it with a line of `---`"] };
  }

  // The map the indented lines below belong to, while there is one.
  let open: Record<string, string> | undefined;
  for (let index = 1; index < close; index++) {
    const line = lines[index]!;
    const at = `line ${index + 1}`;
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (/^\s*\t/.test(line)) {
      faults.push(`${at}: indent with spaces, not tabs`);
      continue;
    }
    const nested = /^\s/.test(line);
    const entry = /^\s*([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(line);
    if (!entry) {
      faults.push(`${at}: expected \`key: value\`; ${UNSUPPORTED}`);
      continue;
    }
    const key = entry[1]!;
    const raw = (entry[2] ?? "").trim();
    const empty = !raw || raw.startsWith("#");

    if (nested) {
      if (!open) faults.push(`${at}: unexpected indentation; only a key with no value of its own holds nested keys`);
      else if (empty) faults.push(`${at}: "${key}" has no value; maps nest one level only`);
      else {
        const parsed = scalar(raw);
        if ("fault" in parsed) faults.push(`${at}: ${parsed.fault}`);
        else open[key] = parsed.value;
      }
      continue;
    }

    open = undefined;
    if (key in fields) {
      faults.push(`${at}: "${key}" is given twice; keep one`);
      continue;
    }
    if (empty) {
      open = {};
      fields[key] = open;
      continue;
    }
    const parsed = scalar(raw);
    if ("fault" in parsed) faults.push(`${at}: ${parsed.fault}`);
    else fields[key] = parsed.value;
  }

  return { fields, body: lines.slice(close + 1).join("\n").trim(), faults };
}

const KNOWN = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools", "allowedTools"]);

/**
 * Check one skill against the format's rules.
 *
 * Shared by the folder loader and the code-defined door, so a skill refused by one is
 * refused by the other in the same words. A skill with a fault is not returned: an agent
 * must not be offered something whose name or description cannot be trusted to say what
 * it is.
 */
export function skillFrom(
  key: string,
  raw: Record<string, unknown>,
  body: unknown,
): { skill?: AuthoredSkill; faults: string[]; advice: string[] } {
  const faults: string[] = [];
  const advice: string[] = [];
  const text = (field: string): string | undefined => {
    const value = raw[field];
    if (value === undefined) return undefined;
    if (typeof value === "string") return value.trim();
    faults.push(`\`${field}\` must be text`);
    return undefined;
  };

  const name = text("name");
  if (name === undefined || !name) {
    if (raw.name === undefined || name === "") faults.push(`\`name\` is required; set it to "${key}"`);
  } else {
    if (name.length > NAME_MAX) faults.push(`\`name\` is ${name.length} characters; the limit is ${NAME_MAX}`);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
      faults.push(
        `\`name\` "${name}" may hold only lowercase letters, digits and single hyphens, and not start or end with one`,
      );
    }
    if (name !== key) faults.push(`\`name\` "${name}" must equal the skill's folder name, "${key}"`);
  }

  const description = text("description");
  if (!description) {
    if (raw.description === undefined || description === "") {
      faults.push("`description` is required; say what the skill does and when to use it");
    }
  } else if (description.length > DESCRIPTION_MAX) {
    faults.push(`\`description\` is ${description.length} characters; the limit is ${DESCRIPTION_MAX}`);
  }

  const license = text("license");
  const compatibility = text("compatibility");
  if (compatibility && compatibility.length > COMPATIBILITY_MAX) {
    faults.push(`\`compatibility\` is ${compatibility.length} characters; the limit is ${COMPATIBILITY_MAX}`);
  }

  let metadata: Record<string, string> | undefined;
  if (raw.metadata !== undefined) {
    const map = raw.metadata;
    const ok =
      map !== null &&
      typeof map === "object" &&
      !Array.isArray(map) &&
      Object.values(map).every((value) => typeof value === "string");
    if (ok) metadata = { ...(map as Record<string, string>) };
    else faults.push("`metadata` must be a map of text to text, one key per indented line");
  }

  let allowedTools: string[] | undefined;
  const tools = raw["allowed-tools"] ?? raw.allowedTools;
  if (typeof tools === "string") allowedTools = tools.split(/\s+/).filter(Boolean);
  else if (Array.isArray(tools) && tools.every((tool) => typeof tool === "string")) allowedTools = [...tools];
  else if (tools !== undefined) faults.push("`allowed-tools` must be tool names separated by spaces");

  for (const field of Object.keys(raw)) {
    if (!KNOWN.has(field) && field !== "body" && field !== "files") {
      advice.push(`\`${field}\` is not part of the skill format and is ignored; put extra values under \`metadata\``);
    }
  }

  if (typeof body !== "string") faults.push("`body` must be text: the instructions the skill gives");
  else {
    const count = body.trim() ? body.trim().split(/\r?\n/).length : 0;
    if (count > BODY_LINES) {
      advice.push(
        `the body is ${count} lines; keep it under ${BODY_LINES} and move detail into references/, ` +
          "which is read only when needed",
      );
    }
  }

  if (faults.length) return { faults, advice };
  return {
    skill: {
      name: key,
      description: description!,
      body: (body as string).trim(),
      ...(license ? { license } : {}),
      ...(compatibility ? { compatibility } : {}),
      ...(metadata ? { metadata } : {}),
      ...(allowedTools?.length ? { allowedTools } : {}),
    },
    faults,
    advice,
  };
}

/**
 * Load `skills/`: one directory per skill, each holding a SKILL.md.
 *
 * Reported with forward slashes whatever the platform, because the same report is read
 * in a terminal on one machine and in CI on another.
 */
export async function loadSkills(root: string, found: Findings): Promise<Record<string, AuthoredSkill>> {
  const base = join(root, SKILLS_DIR);
  let entries: string[];
  try {
    entries = await readdir(base);
  } catch {
    return {}; // an absent convention folder is not an error
  }

  const out: Record<string, AuthoredSkill> = {};
  for (const entry of entries.sort()) {
    if (entry.startsWith(".")) continue;
    const dir = join(base, entry);
    if (!(await stat(dir).catch(() => undefined))?.isDirectory()) continue;

    const where = `${SKILLS_DIR}/${entry}/${SKILL_FILE}`;
    const text = await readFile(join(dir, SKILL_FILE), "utf8").catch(() => undefined);
    if (text === undefined) {
      found.fault(`${SKILLS_DIR}/${entry}: no ${SKILL_FILE}; a skill is a folder holding one`);
      continue;
    }

    const parsed = parseSkillFile(text);
    if (parsed.faults.length) {
      for (const fault of parsed.faults) found.fault(`${where}: ${fault}`);
      continue;
    }
    const checked = skillFrom(entry, parsed.fields, parsed.body);
    for (const fault of checked.faults) found.fault(`${where}: ${fault}`);
    for (const note of checked.advice) found.advise(`${where}: ${note}`);
    if (checked.skill) out[entry] = { ...checked.skill, dir };
  }
  return out;
}
