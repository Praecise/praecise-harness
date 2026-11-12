/**
 * Reading registries, installing a skill, recording a plugin.
 *
 * Three things are kept true here. Nothing is fetched except by the command that asked:
 * loading an app never reads a registry. Nothing that was fetched is used before its
 * bytes have been checked against the digest the index gave. And nothing that was
 * fetched is run — a skill is text and files, placed under `skills/<name>/` and nowhere
 * else, with no execute bit set by this framework, and what it says is shown to the
 * person who asked for it.
 *
 * A plugin is code, so it is not fetched at all. It is written down in
 * `praecise.plugins.json` with the command that installs it, and the person runs their
 * own package manager, with their own lockfile and their own audit. The app loads it
 * once it is there (see `project/recorded.ts`).
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import { SKILLS_DIR, SKILL_FILE, parseSkillFile, skillFrom } from "../project/skills.js";
import { archiveFormat, unpackArchive, type ArchiveFile } from "./archive.js";
import { fetchable, indexUrlOf, parseIndex, type RegistryEntry } from "./format.js";

/** The file recorded plugins are kept in, beside the config. */
export const PLUGINS_FILE = "praecise.plugins.json";

const INDEX_MAX = 2 * 1024 * 1024;
const SKILL_FILE_MAX = 1024 * 1024;
const ARCHIVE_MAX = 10 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

/** GET a URL into memory, refusing anything that is not https or is larger than `max`. */
async function download(
  url: string,
  max: number,
  fetchImpl: typeof fetch,
): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  if (!fetchable(url)) throw new Error(`${url} is not https, so it is not fetched`);
  const response = await fetchImpl(url, {
    headers: { accept: "*/*" },
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // Where a redirect ended up is held to the same rule as where it started.
  if (response.url && !fetchable(response.url)) throw new Error(`${url} redirected somewhere that is not https`);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? "");
  const tooLarge = (): Error => new Error(`${url} is larger than ${max.toLocaleString("en")} bytes, which is the most this reads`);
  if (Number.isFinite(declared) && declared > max) throw tooLarge();

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
  }
  return { bytes: Buffer.concat(chunks), contentType: response.headers.get("content-type") };
}

/**
 * Read every configured registry's index.
 *
 * One that cannot be read is a problem to report and not a reason to stop: the others
 * are still worth searching.
 */
export async function readRegistries(
  registries: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ entries: RegistryEntry[]; problems: string[] }> {
  const entries: RegistryEntry[] = [];
  const problems: string[] = [];
  for (const registry of registries) {
    let url: string;
    try {
      url = indexUrlOf(registry);
    } catch {
      problems.push(`${JSON.stringify(registry)} in \`registries\` is not a URL`);
      continue;
    }
    try {
      const { bytes } = await download(url, INDEX_MAX, fetchImpl);
      const parsed = parseIndex(JSON.parse(Buffer.from(bytes).toString("utf8")), url);
      entries.push(...parsed.entries);
      problems.push(...parsed.notes.map((note) => `${url}: ${note}`));
    } catch (err) {
      problems.push(`${url}: ${(err as Error).message}`);
    }
  }
  return { entries, problems };
}

/** A skill as it came from a registry: checked, and not yet anywhere on disk. */
export interface FetchedSkill {
  name: string;
  description: string;
  /** SKILL.md below its frontmatter. Somebody else's text. */
  body: string;
  /** Every file of the skill by relative path, SKILL.md among them. */
  files: ArchiveFile[];
  /** What the format's own checks had to say that was not a fault. */
  advice: string[];
}

/**
 * Fetch a skill, verify it, and check it is a skill.
 *
 * The digest is checked over the bytes as they arrived, before an archive is opened: a
 * decompressor is not something to hand bytes nobody vouched for.
 */
export async function fetchSkill(entry: RegistryEntry, fetchImpl: typeof fetch = fetch): Promise<FetchedSkill> {
  if (entry.kind !== "skill" || !entry.digest) throw new Error(`"${entry.name}" is not a skill with a digest`);
  const archive = entry.type === "archive";
  const { bytes, contentType } = await download(entry.source, archive ? ARCHIVE_MAX : SKILL_FILE_MAX, fetchImpl);

  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== entry.digest) {
    throw new Error(
      `what ${entry.source} served does not match the digest its index gives (sha256:${entry.digest}, got sha256:${digest}). ` +
        "Nothing was installed.",
    );
  }

  let files: ArchiveFile[];
  if (archive) {
    const format = archiveFormat(contentType, entry.source, bytes);
    if (!format) throw new Error(`${entry.source} is neither a .tar.gz nor a .zip, which are the archives a skill comes in`);
    files = unpackArchive(bytes, format);
  } else files = [{ path: SKILL_FILE, data: bytes }];

  // At the root, as the convention has it: a skill inside a wrapper folder would be
  // installed as a folder holding a skill, which nothing would then load.
  const main = files.find((file) => file.path === SKILL_FILE);
  if (!main) throw new Error(`the archive has no ${SKILL_FILE} at its root, so it is not a skill`);

  const parsed = parseSkillFile(Buffer.from(main.data).toString("utf8"));
  const checked = parsed.faults.length ? undefined : skillFrom(entry.name, parsed.fields, parsed.body);
  const faults = parsed.faults.length ? parsed.faults : (checked?.faults ?? []);
  if (faults.length || !checked?.skill) {
    throw new Error(`"${entry.name}" is not a skill this app could load:\n  ${faults.join("\n  ")}`);
  }
  return {
    name: entry.name,
    description: checked.skill.description,
    body: checked.skill.body,
    files,
    advice: checked.advice,
  };
}

/**
 * Write a fetched skill into `skills/<name>/`.
 *
 * Every path is resolved and checked to be under that folder before anything is
 * written, whatever the unpacker already refused: this is the function that touches the
 * disk, so it is the one that has to be sure.
 */
export async function installSkill(
  root: string,
  skill: FetchedSkill,
  options: { force?: boolean } = {},
): Promise<{ dir: string; written: string[] }> {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(skill.name)) throw new Error(`"${skill.name}" is not a name a skill folder can have`);
  const dir = resolve(root, SKILLS_DIR, skill.name);
  const targets = skill.files.map((file) => {
    const target = resolve(dir, file.path);
    if (!target.startsWith(dir + sep)) {
      throw new Error(`${JSON.stringify(file.path)} would be written outside ${SKILLS_DIR}/${skill.name}/; nothing was installed`);
    }
    return { target, file };
  });

  if (await stat(dir).catch(() => undefined)) {
    if (!options.force) {
      throw new Error(`${SKILLS_DIR}/${skill.name} already exists; pass --force to replace it`);
    }
    // Replaced whole: a file the new version dropped must not linger as part of it.
    await rm(dir, { recursive: true, force: true });
  }

  const written: string[] = [];
  for (const { target, file } of targets) {
    await mkdir(dirname(target), { recursive: true });
    // Never executable, whatever the archive said: running one is a decision, not a default.
    await writeFile(target, file.data, { mode: 0o644 });
    written.push(`${SKILLS_DIR}/${skill.name}/${file.path}`);
  }
  return { dir, written: written.sort() };
}

/** A plugin written down for the app to load once its package is installed. */
export interface RecordedPlugin {
  name: string;
  /** What it is imported as. */
  package: string;
  /** What the package manager is given. */
  source: string;
  version?: string;
  /** `sha256:<hex>` of the package tarball, when the index gave one. */
  digest?: string;
  /** The index it was found in. */
  registry: string;
}

/** The recorded plugins of an app, or none. A file that does not parse is said so. */
export async function readRecordedPlugins(root: string): Promise<{ plugins: RecordedPlugin[]; fault?: string }> {
  const text = await readFile(join(root, PLUGINS_FILE), "utf8").catch(() => undefined);
  if (text === undefined) return { plugins: [] };
  try {
    const parsed = JSON.parse(text) as { plugins?: unknown };
    const listed = Array.isArray(parsed?.plugins) ? parsed.plugins : [];
    const plugins = listed.filter(
      (item): item is RecordedPlugin =>
        Boolean(item) &&
        typeof (item as RecordedPlugin).name === "string" &&
        typeof (item as RecordedPlugin).package === "string" &&
        typeof (item as RecordedPlugin).source === "string",
    );
    return { plugins };
  } catch (err) {
    return { plugins: [], fault: `${PLUGINS_FILE}: ${(err as Error).message}` };
  }
}

/** The command that installs a recorded plugin, for the person to run. */
export function installCommand(plugin: Pick<RecordedPlugin, "source" | "version">): string {
  const byUrl = /^(git\+)?https:\/\//.test(plugin.source);
  return `npm install ${plugin.source}${!byUrl && plugin.version ? `@${plugin.version}` : ""}`;
}

/**
 * Write a plugin down in `praecise.plugins.json`. Installs nothing.
 *
 * `replaced` is set when a plugin of that name was already recorded and this took its
 * place — the same name from a different source is worth a second look.
 */
export async function recordPlugin(
  root: string,
  entry: RegistryEntry,
): Promise<{ recorded: RecordedPlugin; replaced?: RecordedPlugin; install: string }> {
  if (entry.kind !== "plugin" || !entry.package) throw new Error(`"${entry.name}" is not a plugin`);
  const held = await readRecordedPlugins(root);
  if (held.fault) throw new Error(`${held.fault}. Fix or delete it, then add the plugin again.`);

  const recorded: RecordedPlugin = {
    name: entry.name,
    package: entry.package,
    source: entry.source,
    ...(entry.version ? { version: entry.version } : {}),
    ...(entry.digest ? { digest: `sha256:${entry.digest}` } : {}),
    registry: entry.registry,
  };
  const replaced = held.plugins.find((plugin) => plugin.name === entry.name);
  const plugins = [...held.plugins.filter((plugin) => plugin.name !== entry.name), recorded].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  await writeFile(join(root, PLUGINS_FILE), `${JSON.stringify({ plugins }, null, 2)}\n`, "utf8");
  return { recorded, ...(replaced ? { replaced } : {}), install: installCommand(recorded) };
}
