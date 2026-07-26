/**
 * Adding a piece to an app that already exists.
 *
 * A blueprint may ship its files, or it may say what it should accomplish and
 * be worked out from there. The second only works because an app describes
 * itself: every role, every function schema, every store is already written
 * down, so there is a set of parts to build from rather than a blank page.
 *
 * Whatever is produced is written as ordinary files. There is no hidden
 * install step and nothing to un-install — what lands on disk is what the
 * author would have typed, and they can read it, change it, or delete it.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, normalize, resolve, sep } from "node:path";

import type { BlueprintSpec, FileContents } from "../define.js";

/** Folders a blueprint is allowed to write into. */
const WRITABLE = new Set([
  "agents",
  "workflows",
  "memory",
  "tools",
  "functions",
  "prompts",
  "resources",
  "stores",
  "blueprints",
]);

const RULES = `You are adding a piece to an application that already exists.

Reply with a JSON array of files and nothing else:

  [{"path": "agents/name.ts", "contents": "..."}]

Rules:
- Every path is relative and starts with one of: ${[...WRITABLE].join(", ")}.
- Write TypeScript that imports from "praecise" and exports one thing by default,
  matching the style of the existing files you are shown.
- Reuse the agents, functions and stores listed. Do not invent services.
- Write the fewest files that do the job.`;

export interface InstallPlan {
  files: FileContents[];
  notes: string[];
}

/**
 * Keep a path only if it stays inside the project and lands somewhere a
 * blueprint is allowed to write. Contents may come from a model, so `../` in a
 * path is not a mistake to be tolerated.
 */
export function safePath(path: unknown): string | undefined {
  if (typeof path !== "string" || !path.trim()) return undefined;
  if (isAbsolute(path)) return undefined;
  const clean = normalize(path).replace(/^(\.[/\\])+/, "");
  if (clean.startsWith("..") || clean.split(/[/\\]/).includes("..")) return undefined;
  const [folder] = clean.split(sep);
  if (!folder || !WRITABLE.has(folder)) return undefined;
  return clean;
}

/** Read a model's file list, dropping anything that is not a writable file. */
export function checkFiles(raw: unknown): InstallPlan {
  const files: FileContents[] = [];
  const notes: string[] = [];
  if (!Array.isArray(raw)) return { files, notes: ["the reply was not a list of files"] };

  for (const candidate of raw) {
    if (!candidate || typeof candidate !== "object") continue;
    const item = candidate as Record<string, unknown>;
    const path = safePath(item.path);
    if (!path) {
      notes.push(`refused to write "${String(item.path)}" — it is outside the project`);
      continue;
    }
    if (typeof item.contents !== "string") {
      notes.push(`skipped "${path}" — it had no contents`);
      continue;
    }
    files.push({ path, contents: item.contents });
  }
  return { files, notes };
}

function parseArray(text: string): unknown {
  const unfenced = text.replace(/^\s*```(?:json)?\s*\n?/, "").replace(/\n?\s*```\s*$/, "");
  const start = unfenced.indexOf("[");
  const end = unfenced.lastIndexOf("]");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

export interface DeriveOptions {
  /** What the app already contains, in prose. */
  describes: string;
  /** A file or two to imitate, so generated code matches the house style. */
  examples?: FileContents[];
  ask(question: string): Promise<string>;
}

/** Work out a blueprint's files from its intent. */
export async function deriveFiles(
  spec: BlueprintSpec,
  options: DeriveOptions,
): Promise<InstallPlan> {
  if (!spec.intent?.trim()) {
    return { files: [], notes: ["this blueprint has neither files nor an intent"] };
  }

  const shown = (options.examples ?? [])
    .map((file) => `--- ${file.path} ---\n${file.contents.slice(0, 2000)}`)
    .join("\n\n");

  const question = [
    RULES,
    `What this app already contains:\n${options.describes}`,
    shown ? `Existing files, for style:\n${shown}` : "",
    `What to add:\n${spec.intent}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const plan = checkFiles(parseArray(await options.ask(question)));
  if (!plan.files.length) plan.notes.push("nothing usable came back for this blueprint");
  return plan;
}

export interface WriteResult {
  written: string[];
  skipped: string[];
}

/** Write a plan's files, leaving anything that already exists alone. */
export async function writeFiles(
  root: string,
  files: FileContents[],
  options: { force?: boolean } = {},
): Promise<WriteResult> {
  const written: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const path = safePath(file.path);
    if (!path) {
      skipped.push(file.path);
      continue;
    }
    const target = resolve(root, path);
    // Belt and braces: a symlinked folder could still lead out of the project.
    if (!target.startsWith(resolve(root) + sep)) {
      skipped.push(file.path);
      continue;
    }
    if (!options.force && (await readFile(target, "utf8").catch(() => undefined)) !== undefined) {
      skipped.push(path);
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.contents, "utf8");
    written.push(path);
  }

  return { written, skipped };
}
