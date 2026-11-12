/**
 * The index a registry is: one JSON document, on any host.
 *
 * There is no central registry and this does not make one. A registry is a file
 * somebody serves — a team's, a vendor's, a person's — and an app lists the ones it
 * reads in its own config. So the only thing to agree on is the file.
 *
 * For skills the file already exists: the Agent Skills discovery index (the
 * `agentskills.io` discovery schema, version 0.2.0), served by convention at
 * `/.well-known/agent-skills/index.json`. It is read here exactly as published:
 *
 *   { "$schema": "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
 *     "skills": [ { "name": "log-triage",
 *                   "type": "skill-md",              // or "archive" (.tar.gz, .zip)
 *                   "description": "…",
 *                   "url": "log-triage/SKILL.md",    // resolved against the index URL
 *                   "digest": "sha256:<64 hex>" } ] } // of the artifact's raw bytes
 *
 * Nothing publishes an index of plugins, so that half is ours, and it is put where the
 * convention leaves room: a `plugins` array beside `skills`, which a reader of the
 * convention ignores as it must ignore any field it does not know.
 *
 *     "plugins": [ { "name": "crm",
 *                    "description": "…",
 *                    "version": "1.4.0",             // optional, also allowed on a skill
 *                    "source": "@acme/praecise-crm", // an npm name, or an https / git+https URL
 *                    "package": "@acme/praecise-crm",// what it is imported as, when source is a URL
 *                    "digest": "sha256:<64 hex>" } ] // of the package tarball, optional
 *
 * An entry that cannot be trusted to mean what it says — a skill with no digest, a URL
 * that is not https — is left out and named, never read approximately.
 */

/** Where the convention serves a site's index. */
export const WELL_KNOWN_SKILLS = "/.well-known/agent-skills/index.json";

/** The schema identifier an index written here declares. */
export const DISCOVERY_SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";

export interface RegistryEntry {
  kind: "skill" | "plugin";
  name: string;
  description: string;
  version?: string;
  /** A skill: the artifact's absolute URL. A plugin: an npm package name, or an https / git+https URL. */
  source: string;
  /** A skill's artifact: one SKILL.md, or an archive with SKILL.md at its root. */
  type?: "skill-md" | "archive";
  /** SHA-256 of the artifact, 64 lowercase hex characters. Always present on a skill. */
  digest?: string;
  /** A plugin: the name it is imported by. */
  package?: string;
  /** The index this entry was read from. */
  registry: string;
}

const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const NPM_NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const DIGEST = /^sha256:([0-9a-f]{64})$/;
const VERSION = /^[\w.+-]{1,64}$/;

const isText = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/** Loopback is the one place plain http is not somebody else's network. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Whether a URL may be fetched: https, or http to this machine.
 *
 * What comes back is checked against a digest, so this is not what keeps a skill
 * honest. It is what keeps the INDEX honest, which has no digest to be checked against.
 */
export function fetchable(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || (parsed.protocol === "http:" && LOOPBACK.has(parsed.hostname));
  } catch {
    return false;
  }
}

/** The index a configured registry names: the URL itself, or an origin's well-known index. */
export function indexUrlOf(registry: string): string {
  const parsed = new URL(registry);
  if (parsed.pathname === "/" || parsed.pathname === "") parsed.pathname = WELL_KNOWN_SKILLS;
  return parsed.href;
}

/**
 * Read an index document into entries.
 *
 * `notes` names every entry that was left out and why, so an index that lists ten
 * things and yields eight says which two.
 */
export function parseIndex(document: unknown, indexUrl: string): { entries: RegistryEntry[]; notes: string[] } {
  const entries: RegistryEntry[] = [];
  const notes: string[] = [];
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return { entries, notes: ["the index is not a JSON object with a `skills` list"] };
  }
  const held = document as Record<string, unknown>;
  const seen = new Set<string>();
  const take = (entry: RegistryEntry): void => {
    const key = `${entry.kind}:${entry.name}`;
    if (seen.has(key)) return void notes.push(`${entry.kind} "${entry.name}" is listed twice; the first is used`);
    seen.add(key);
    entries.push(entry);
  };
  const versionOf = (raw: Record<string, unknown>): { version?: string } =>
    typeof raw.version === "string" && VERSION.test(raw.version) ? { version: raw.version } : {};

  for (const [at, item] of (Array.isArray(held.skills) ? held.skills : []).entries()) {
    const raw = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const label = isText(raw.name) ? `skill "${raw.name}"` : `skill ${at + 1}`;
    if (!isText(raw.name) || raw.name.length > 64 || !SKILL_NAME.test(raw.name)) {
      notes.push(`${label}: the name must be lowercase letters, digits and single hyphens, 64 at most`);
      continue;
    }
    // The convention's rule: a type this client does not know is skipped, not guessed at.
    if (raw.type !== "skill-md" && raw.type !== "archive") {
      notes.push(`${label}: its type is ${JSON.stringify(raw.type ?? null)}, which is not one this reads (skill-md, archive)`);
      continue;
    }
    if (!isText(raw.description) || raw.description.length > 1024) {
      notes.push(`${label}: it needs a description of 1024 characters at most`);
      continue;
    }
    const digest = typeof raw.digest === "string" ? DIGEST.exec(raw.digest)?.[1] : undefined;
    if (!digest) {
      notes.push(`${label}: it has no \`digest\` of the form sha256:<64 hex>, and nothing is installed unverified`);
      continue;
    }
    let source: string;
    try {
      source = new URL(String(raw.url ?? ""), indexUrl).href;
    } catch {
      notes.push(`${label}: its \`url\` is not one`);
      continue;
    }
    if (!isText(raw.url) || !fetchable(source)) {
      notes.push(`${label}: its \`url\` must be https`);
      continue;
    }
    take({
      kind: "skill",
      name: raw.name,
      description: raw.description.trim(),
      ...versionOf(raw),
      source,
      type: raw.type,
      digest,
      registry: indexUrl,
    });
  }

  for (const [at, item] of (Array.isArray(held.plugins) ? held.plugins : []).entries()) {
    const raw = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const label = isText(raw.name) ? `plugin "${raw.name}"` : `plugin ${at + 1}`;
    if (!isText(raw.name) || raw.name.length > 214 || /\s/.test(raw.name)) {
      notes.push(`${label}: it needs a name with no spaces in it`);
      continue;
    }
    if (!isText(raw.description) || raw.description.length > 1024) {
      notes.push(`${label}: it needs a description of 1024 characters at most`);
      continue;
    }
    const source = isText(raw.source) ? raw.source.trim() : "";
    const byUrl = /^(git\+)?https:\/\/[^\s]+$/.test(source);
    if (!byUrl && !NPM_NAME.test(source)) {
      notes.push(`${label}: its \`source\` must be an npm package name, or an https or git+https URL`);
      continue;
    }
    const named = raw.package ?? (byUrl ? raw.name : source);
    if (typeof named !== "string" || !NPM_NAME.test(named)) {
      notes.push(`${label}: its source is a URL, so it needs \`package\`: the name the package is imported by`);
      continue;
    }
    let digest: string | undefined;
    if (raw.digest !== undefined) {
      digest = typeof raw.digest === "string" ? DIGEST.exec(raw.digest)?.[1] : undefined;
      if (!digest) {
        notes.push(`${label}: its \`digest\` is not of the form sha256:<64 hex>`);
        continue;
      }
    }
    take({
      kind: "plugin",
      name: raw.name,
      description: raw.description.trim(),
      ...versionOf(raw),
      source,
      package: named,
      ...(digest ? { digest } : {}),
      registry: indexUrl,
    });
  }

  if (!Array.isArray(held.skills) && !Array.isArray(held.plugins)) {
    notes.push("the index has neither a `skills` nor a `plugins` list");
  }
  return { entries, notes };
}

/** Entries whose name or description holds every word of `term`, names first. */
export function searchEntries(entries: readonly RegistryEntry[], term: string): RegistryEntry[] {
  const words = term.toLowerCase().split(/\s+/).filter(Boolean);
  const rank = (entry: RegistryEntry): number => {
    const name = entry.name.toLowerCase();
    const text = `${name} ${entry.description.toLowerCase()}`;
    if (!words.every((word) => text.includes(word))) return -1;
    return words.some((word) => name.includes(word)) ? 1 : 0;
  };
  return entries
    .map((entry) => ({ entry, rank: rank(entry) }))
    .filter((ranked) => ranked.rank >= 0)
    .sort((a, b) => b.rank - a.rank || a.entry.name.localeCompare(b.entry.name))
    .map((ranked) => ranked.entry);
}
