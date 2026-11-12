/**
 * The app's authored skills, served to MCP clients (the Skills extension).
 *
 * `skills/<name>/` is already a folder in the open Agent Skills format, and the
 * extension is a way to list such folders and read their files over MCP. So nothing is
 * converted: a skill is listed with the frontmatter its own `SKILL.md` has and a manifest
 * of every file in it, and each file is read with `resources/read` at
 * `skill://<name>/<path>`.
 *
 * The manifest is computed from the bytes that are served, when it is asked for. A
 * client checks every file it reads against the length and SHA-256 listed, so a manifest
 * kept from an earlier read of the folder would turn an edit to a skill into a
 * verification failure on the other side. A skill is a few small files; reading them to
 * list them is the cost of the list being true.
 *
 * A skill written in code has no `SKILL.md` on disk, so one is rendered from its fields.
 * The frontmatter listed is then read back out of that rendering, so the two cannot
 * disagree.
 *
 * Who may see a skill: whoever may reach the endpoint, as with prompts and resources. A
 * skill whose `metadata` says `access: internal` is not served.
 */

import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { App } from "../app.js";
import { SKILL_FILE, parseSkillFile, type AuthoredSkill } from "../project/skills.js";

/** The extension's identifier, as a server declares it in `server/discover`. */
export const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";
const SCHEME = "skill://";

/** One file of a served skill. */
interface Held {
  /** Forward-slash path inside the skill. */
  path: string;
  bytes: Buffer;
}

/** A skill entry as `skills/list` and `skills/get` carry it. */
export interface ServedSkill {
  uri: string;
  frontmatter: Record<string, unknown>;
  resources: { uri: string; digest: string; size: number }[];
}

/** Media types by extension, for the files a skill usually holds. */
const TYPES: Record<string, string> = {
  md: "text/markdown",
  txt: "text/plain",
  json: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  csv: "text/csv",
  html: "text/html",
  css: "text/css",
  xml: "application/xml",
  js: "text/javascript",
  mjs: "text/javascript",
  ts: "text/x-typescript",
  py: "text/x-python",
  sh: "application/x-sh",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  pdf: "application/pdf",
};

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

/** A value as a double-quoted YAML scalar, which is also how JSON writes a string. */
const quoted = (value: string): string => JSON.stringify(value);

/**
 * The SKILL.md of a skill that was written in code.
 *
 * Every value is quoted, so that nothing in a description can be read as YAML syntax.
 */
export function renderSkillFile(skill: AuthoredSkill): string {
  const lines = ["---", `name: ${skill.name}`, `description: ${quoted(skill.description)}`];
  if (skill.license) lines.push(`license: ${quoted(skill.license)}`);
  if (skill.compatibility) lines.push(`compatibility: ${quoted(skill.compatibility)}`);
  if (skill.allowedTools?.length) lines.push(`allowed-tools: ${quoted(skill.allowedTools.join(" "))}`);
  const metadata = Object.entries(skill.metadata ?? {});
  if (metadata.length) {
    lines.push("metadata:");
    for (const [key, value] of metadata) lines.push(`  ${key}: ${quoted(value)}`);
  }
  lines.push("---", "", skill.body, "");
  return lines.join("\n");
}

/** The skills this app serves: all it loaded, less any marked internal. */
function served(app: App): AuthoredSkill[] {
  return Object.values(app.project.skills ?? {})
    .filter((skill) => skill.metadata?.access !== "internal")
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Whether this app has any skill to serve, which is when the extension is declared. */
export function servesSkills(app: App): boolean {
  return served(app).length > 0;
}

/**
 * Every file of one skill, SKILL.md first, as the bytes that would be served.
 *
 * A file reached through a link that leads out of the skill's folder is left out, for
 * the reason `read_skill` refuses one: it is the same escape as `..` by another spelling.
 */
async function filesOf(skill: AuthoredSkill): Promise<Held[]> {
  const held: Held[] = [];
  for (const [path, text] of Object.entries(skill.files ?? {})) {
    const clean = path.replace(/\\/g, "/").replace(/^\.\//, "");
    if (clean && clean !== SKILL_FILE && !clean.split("/").includes("..")) held.push({ path: clean, bytes: Buffer.from(text, "utf8") });
  }

  let main: Buffer | undefined;
  if (skill.dir) {
    const base = await realpath(skill.dir).catch(() => undefined);
    const entries = base ? await readdir(skill.dir, { recursive: true }).catch(() => [] as string[]) : [];
    for (const entry of entries) {
      const segments = entry.split(sep);
      if (segments.some((segment) => segment.startsWith("."))) continue;
      const path = segments.join("/");
      const target = await realpath(resolve(skill.dir, entry)).catch(() => undefined);
      if (!base || !target) continue;
      const within = relative(base, target);
      if (!within || within.startsWith("..") || isAbsolute(within)) continue;
      if (!(await stat(target).catch(() => undefined))?.isFile()) continue;
      const bytes = await readFile(target).catch(() => undefined);
      if (!bytes) continue;
      if (path === SKILL_FILE) main = bytes;
      else if (!held.some((file) => file.path === path)) held.push({ path, bytes });
    }
  }
  held.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return [{ path: SKILL_FILE, bytes: main ?? Buffer.from(renderSkillFile(skill), "utf8") }, ...held];
}

const uriOf = (skill: string, path: string): string =>
  `${SCHEME}${skill}/${path.split("/").map(encodeURIComponent).join("/")}`;

/**
 * The frontmatter of a SKILL.md, as a client's own YAML reader would give it.
 *
 * `allowed-tools` written as a list is a list there, and the loader here joins it into
 * one line. The entry has to say what the file says, so it is split back when the file
 * wrote it that way.
 */
function frontmatterOf(text: string, skill: AuthoredSkill): Record<string, unknown> {
  const parsed = parseSkillFile(text);
  const fields: Record<string, unknown> = { ...parsed.fields };
  fields.name ??= skill.name;
  fields.description ??= skill.description;
  if (typeof fields["allowed-tools"] === "string" && /^allowed-tools:[ \t]*(#.*)?\r?\n[ \t]*-/m.test(text)) {
    fields["allowed-tools"] = (fields["allowed-tools"] as string).split(/\s+/).filter(Boolean);
  }
  return fields;
}

async function entryOf(skill: AuthoredSkill): Promise<ServedSkill> {
  const files = await filesOf(skill);
  return {
    uri: uriOf(skill.name, SKILL_FILE),
    frontmatter: frontmatterOf(files[0]!.bytes.toString("utf8"), skill),
    resources: files.map((file) => ({
      uri: uriOf(skill.name, file.path),
      digest: `sha256:${createHash("sha256").update(file.bytes).digest("hex")}`,
      size: file.bytes.length,
    })),
  };
}

/** Every skill the app serves, each with its whole manifest. */
export function listSkills(app: App): Promise<ServedSkill[]> {
  return Promise.all(served(app).map(entryOf));
}

/** A skill address taken apart: which skill, and which path inside it. */
function parts(app: App, uri: string): { skill: AuthoredSkill; path: string } | undefined {
  if (!uri.startsWith(SCHEME)) return undefined;
  const rest = uri.slice(SCHEME.length);
  const cut = rest.indexOf("/");
  const name = cut < 0 ? rest : rest.slice(0, cut);
  const skill = served(app).find((candidate) => candidate.name === name);
  if (!skill) return undefined;
  let path: string;
  try {
    path = cut < 0 ? "" : rest.slice(cut + 1).split("/").map(decodeURIComponent).join("/");
  } catch {
    return undefined;
  }
  return { skill, path };
}

/** One skill by the address of its SKILL.md, or nothing. */
export async function getSkill(app: App, uri: string): Promise<ServedSkill | undefined> {
  const found = parts(app, uri);
  return found && found.path === SKILL_FILE ? entryOf(found.skill) : undefined;
}

/** One file of a skill as a `resources/read` block, or nothing if there is no such file. */
export async function readSkillFile(
  app: App,
  uri: string,
): Promise<{ uri: string; mimeType: string; text?: string; blob?: string } | undefined> {
  const found = parts(app, uri);
  if (!found) return undefined;
  const file = (await filesOf(found.skill)).find((candidate) => candidate.path === found.path);
  if (!file) return undefined;
  const extension = file.path.slice(file.path.lastIndexOf(".") + 1).toLowerCase();
  const binary = isBinary(file.bytes);
  const mimeType = TYPES[extension] ?? (binary ? "application/octet-stream" : "text/plain");
  return binary
    ? { uri, mimeType, blob: file.bytes.toString("base64") }
    : { uri, mimeType, text: file.bytes.toString("utf8") };
}

/**
 * The direct children of a directory in a skill, or nothing if it is not one.
 *
 * Answered from the same file list the manifest is made from, so what a client can walk
 * is exactly what it can read. A directory's address has no trailing slash.
 */
export async function readSkillDirectory(
  app: App,
  uri: string,
): Promise<{ uri: string; name: string; mimeType: string }[] | undefined> {
  const found = parts(app, uri.replace(/\/+$/, ""));
  if (!found) return undefined;
  const files = await filesOf(found.skill);
  const under = found.path ? `${found.path}/` : "";
  const inside = files.filter((file) => file.path.startsWith(under));
  // A path that is a file, or that nothing lives under, is not a directory.
  if (!inside.length || files.some((file) => file.path === found.path)) return undefined;

  const children = new Map<string, { uri: string; name: string; mimeType: string }>();
  for (const file of inside) {
    const rest = file.path.slice(under.length);
    const name = rest.split("/")[0]!;
    if (children.has(name)) continue;
    const isFile = !rest.includes("/");
    const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
    children.set(name, {
      uri: uriOf(found.skill.name, `${under}${name}`),
      name,
      mimeType: isFile ? (TYPES[extension] ?? (isBinary(file.bytes) ? "application/octet-stream" : "text/plain")) : "inode/directory",
    });
  }
  return [...children.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
