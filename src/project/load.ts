/**
 * The convention loader: a directory becomes a Project.
 *
 *   agents/       one file per agent      → AgentSpec
 *   workflows/    one file per workflow   → WorkflowSpec
 *   memory/       anything readable       → what the app knows up front
 *   tools/        external MCP servers    → ToolSpec
 *   functions/    your own code           → FunctionSpec
 *   prompts/      canned requests         → PromptSpec
 *   resources/    context the app attaches → ResourceSpec
 *   stores/       somewhere to keep things → StoreSpec
 *   blueprints/   installable fragments   → BlueprintSpec (.md allowed)
 *   templates/    whole starter apps      → TemplateSpec
 *   middleware.ts wraps every call
 *   guard.ts      says which tool calls are actually made
 *   praecise.config.ts                    → AppConfig (optional)
 *
 * Nothing here is required. An empty directory loads as an empty project, and a
 * directory with one file in `agents/` is a complete, runnable app.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  AgentSpec,
  AppConfig,
  BlueprintSpec,
  FunctionSpec,
  GuardSpec,
  KnowledgeSpec,
  MiddlewareSpec,
  PromptSpec,
  ResourceSpec,
  StoreSpec,
  TemplateSpec,
  ToolSpec,
  WorkflowSpec,
} from "../define.js";
import { isPlan } from "../define.js";
import { canConvert, ingestFile, isTextFormat, type Converter } from "../ingest/index.js";
import { faultsIn } from "../package/describe.js";
import { buildTypeScript, importerFor } from "./typescript.js";
import {
  danglingAfterIn,
  defectsIn,
  looseReferencesIn,
  walkSteps,
} from "../workflow/defects.js";

/** A document available as grounding. */
export interface Doc {
  /** Stable name — the path under `memory/`, minus extension. */
  name: string;
  content: string;
  /** Absolute path, when it came from a file. */
  path?: string;
}

export interface Project {
  root: string;
  name: string;
  config: AppConfig;
  agents: Record<string, AgentSpec>;
  workflows: Record<string, WorkflowSpec>;
  tools: Record<string, ToolSpec>;
  functions: Record<string, FunctionSpec>;
  prompts: Record<string, PromptSpec>;
  resources: Record<string, ResourceSpec>;
  stores: Record<string, StoreSpec>;
  blueprints: Record<string, BlueprintSpec>;
  templates: Record<string, TemplateSpec>;
  /** From `middleware.ts` at the root, if there is one. */
  middleware?: MiddlewareSpec;
  /** From `guard.ts` at the root, if there is one. */
  guard?: GuardSpec;
  /** Everything under `memory/`, shared by every agent. */
  knowledge: Doc[];
  /** Problems that did not stop the load. Surfaced by `dev` and `check`. */
  warnings: string[];
  /**
   * The subset of `warnings` that is not advice: a file that would not load, a
   * spec that cannot run as written, a document nothing could read.
   *
   * The distinction is what lets a command be honest about its exit code. "This
   * workflow has no description" and "every file in this app threw on import"
   * are both warnings, and a tool that treats them alike either cries wolf or —
   * as this one did — reports success over an app that failed to load. A fault
   * means what ran is not what is on disk.
   *
   * Optional because a project can be assembled in memory and handed to
   * `App.from`, and nothing checked such a project's files — there were none.
   * `loadProject` always sets it, if only to an empty array.
   */
  faults?: string[];
}

/**
 * Where the loader writes what it found wrong.
 *
 * Faults are also warnings: `warnings` stays the whole list in the order it was
 * found, so nothing that reads it loses anything, and `faults` is the part that
 * is not merely worth mentioning.
 */
export class Findings {
  readonly warnings: string[] = [];
  readonly faults: string[] = [];

  /** Worth saying; the app still is what it says it is. */
  advise(text: string): void {
    this.warnings.push(text);
  }

  /** Something did not load, or cannot run. */
  fault(text: string): void {
    this.warnings.push(text);
    this.faults.push(text);
  }
}

/** How a user module is imported. Swapped in tests; cache-busted on hot reload. */
export type Importer = (fileUrl: string) => Promise<Record<string, unknown>>;

const nativeImport: Importer = async (fileUrl) => {
  try {
    return (await import(fileUrl)) as Record<string, unknown>;
  } catch (err) {
    throw explainLoad(fileUrl, err);
  }
};

/**
 * Turn a runtime's refusal to load a file into something the author can act on.
 *
 * This exists because of one specific, badly-reported failure. Every example in the
 * documentation is a `.ts` file, the framework's own tests run under a transform that
 * makes those work, and a runtime WITHOUT TypeScript support answers the same app with
 * `Unknown file extension ".ts"` — a message that names no cause and no remedy. Worse,
 * it arrives as a per-file `problem` rather than a crash, so the app loads successfully
 * with no agents in it and the first sign of trouble is an empty tool list.
 *
 * Node gained type stripping in 22.6 and turned it on by default in 23.6, but a build
 * compiled without it (`ERR_NO_TYPESCRIPT`) exists and is what some distributions ship,
 * so "upgrade Node" is not on its own a correct instruction.
 */
export function explainLoad(fileUrl: string, err: unknown): Error {
  const code = (err as { code?: string })?.code;
  const isTypeScript = /\.mts$|\.ts(\?|$)/.test(fileUrl);
  if (!isTypeScript || (code !== "ERR_UNKNOWN_FILE_EXTENSION" && code !== "ERR_NO_TYPESCRIPT")) {
    return err as Error;
  }
  const [major, minor] = process.versions.node.split(".").map(Number);
  const stripsByDefault = (major ?? 0) > 23 || ((major ?? 0) === 23 && (minor ?? 0) >= 6);
  const remedy =
    code === "ERR_NO_TYPESCRIPT"
      ? "this Node was built without TypeScript support — run `npm install -D typescript` so praecise can build the app, use a loader (`tsx`), or write it as `.js`"
      : stripsByDefault
        ? "this file uses TypeScript syntax Node cannot strip (enums, namespaces, parameter properties); use plain type annotations, a loader (`tsx`), or `.js`"
        : `Node ${process.versions.node} does not run TypeScript on its own — run \`npm install -D typescript\` so praecise can build the app, start Node with \`--experimental-strip-types\`, use a loader (\`tsx\`), or write the file as \`.js\``;

  return new Error(`TypeScript file could not be loaded — ${remedy}`);
}

export interface LoadOptions {
  importer?: Importer;
  /** Appended to module URLs to defeat the ESM cache during hot reload. */
  version?: string | number;
  /** Where converted documents are cached. Default `<root>/.praecise/ingest`. */
  cacheDir?: string;
  /** Consulted for formats the built-in converters cannot read. */
  converter?: Converter;
}

const CODE_EXT = new Set([".ts", ".mts", ".js", ".mjs"]);

/**
 * Extensions a root file may be written in, in the order they are looked for.
 *
 * Shared with the packager, which used to hardcode `.ts` here and so shipped
 * apps written in `.js` without their `guard.js` — the same list read twice is
 * the bug, so there is one list.
 */
export const ROOT_EXT = [".ts", ".mts", ".js", ".mjs"] as const;

/** The folder holding documents rather than modules. */
const DOC_DIR = "memory";

/** Recursively list files under `dir`, skipping dotfiles and READMEs. */
async function listFiles(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir, { recursive: true });
  } catch {
    return []; // an absent convention folder is not an error
  }
  const files: string[] = [];
  for (const entry of entries) {
    const segments = entry.split(sep);
    if (segments.some((s) => s.startsWith("."))) continue;
    const full = join(dir, entry);
    const info = await stat(full).catch(() => undefined);
    if (!info?.isFile()) continue;
    if (basename(entry).toLowerCase().startsWith("readme.")) continue;
    files.push(full);
  }
  return files;
}

/** `agents/support/index.ts` and `agents/support.ts` both name `support`. */
function moduleName(root: string, file: string): string {
  const rel = relative(root, file);
  const withoutExt = rel.slice(0, rel.length - extname(rel).length);
  const parts = withoutExt.split(sep);
  if (parts.length > 1 && parts[parts.length - 1] === "index") parts.pop();
  return parts.join("/");
}

async function importDefault(
  file: string,
  importer: Importer,
  version: string | number | undefined,
): Promise<unknown> {
  const url = pathToFileURL(file).href + (version === undefined ? "" : `?v=${version}`);
  const mod = await importer(url);
  return mod.default ?? mod;
}

type Opts = Required<Pick<LoadOptions, "importer">> & {
  version?: string | number;
  cacheDir?: string;
  converter?: Converter;
};

/**
 * Load everything of one kind. Files that fail to import, or that do not
 * export the expected shape, become warnings rather than killing the load — a
 * typo in one agent must not take down the whole dev server.
 */
async function loadKind<T>(
  root: string,
  kind: string,
  expect: string,
  opts: Opts,
  found: Findings,
): Promise<Record<string, T>> {
  const dir = join(root, kind);
  const out: Record<string, T> = {};
  for (const file of await listFiles(dir)) {
    if (!CODE_EXT.has(extname(file))) continue;
    const name = moduleName(dir, file);
    let value: unknown;
    try {
      value = await importDefault(file, opts.importer, opts.version);
    } catch (err) {
      found.fault(`${relative(root, file)}: ${(err as Error).message}`);
      continue;
    }
    if (!value || typeof value !== "object") {
      found.fault(`${relative(root, file)}: expected \`export default ${expect}({ ... })\``);
      continue;
    }
    const spec = value as { kind?: string; name?: string };
    if (spec.kind !== expect) {
      found.fault(
        `${relative(root, file)}: expected \`export default ${expect}({ ... })\`` +
          (spec.kind ? `, got a ${spec.kind}` : ""),
      );
      continue;
    }
    out[spec.name ?? name] = { ...(value as object), name: spec.name ?? name } as T;
  }
  return out;
}

/**
 * Load `memory/`: text verbatim, other formats through the ingest pipeline,
 * code modules via `knowledge()`. A file nothing can read is a warning naming
 * the format, never a silent omission.
 */
async function loadDocs(root: string, opts: Opts, found: Findings): Promise<Doc[]> {
  const docs: Doc[] = [];
  const dir = join(root, DOC_DIR);

  for (const file of await listFiles(dir)) {
    const ext = extname(file).toLowerCase();
    const name = moduleName(dir, file);

    if (CODE_EXT.has(ext)) {
      try {
        const value = (await importDefault(file, opts.importer, opts.version)) as
          | Partial<KnowledgeSpec>
          | undefined;
        if (value?.kind !== "knowledge" || typeof value.content !== "string") {
          found.fault(`${DOC_DIR}/${name}: expected \`export default knowledge({ content })\``);
          continue;
        }
        docs.push({ name: value.name ?? name, content: value.content, path: file });
      } catch (err) {
        found.fault(`${DOC_DIR}/${name}: ${(err as Error).message}`);
      }
      continue;
    }

    if (!canConvert(ext) && !isTextFormat(ext) && !opts.converter) {
      found.fault(`${DOC_DIR}/${name}${ext}: nothing here can read a "${ext}" file`);
      continue;
    }

    try {
      const { text, note } = await ingestFile(file, {
        cacheDir: opts.cacheDir,
        fallback: opts.converter,
      });
      // A note is what the conversion had to settle for; a throw is a document
      // the agent will never see. Only the second one changes what the app is.
      if (note) found.advise(`${DOC_DIR}/${name}${ext}: ${note}`);
      if (text.trim()) docs.push({ name, content: text, path: file });
    } catch (err) {
      found.fault(`${DOC_DIR}/${name}${ext}: ${(err as Error).message}`);
    }
  }

  return docs;
}

/** Blueprints may be `.md` — the prose is the intent, and that is the whole file. */
async function loadBlueprints(
  root: string,
  opts: Opts,
  found: Findings,
): Promise<Record<string, BlueprintSpec>> {
  const out = await loadKind<BlueprintSpec>(root, "blueprints", "blueprint", opts, found);
  const dir = join(root, "blueprints");

  for (const file of await listFiles(dir)) {
    const ext = extname(file).toLowerCase();
    if (ext !== ".md" && ext !== ".txt") continue;
    const name = moduleName(dir, file);
    if (out[name]) continue;
    const intent = await readFile(file, "utf8").catch(() => undefined);
    if (intent === undefined) continue;
    out[name] = {
      kind: "blueprint",
      name,
      description: firstLine(intent),
      intent: intent.trim(),
    };
  }

  return out;
}

/** A blueprint's title if it has one, else its opening line. */
function firstLine(text: string): string {
  const lines = text.split("\n").filter((line) => line.trim());
  const chosen = lines.find((line) => line.startsWith("#")) ?? lines[0] ?? "";
  return chosen.replace(/^#+\s*/, "").trim().slice(0, 140);
}

/**
 * A single file at the root that exports one thing with a `run`.
 *
 * `middleware.ts` and `guard.ts` are both this shape: write the function on its
 * own, or wrap it so it reads as what it is. Both are accepted.
 */
async function loadRootHook<T extends { kind: string; run: unknown }>(
  root: string,
  name: T["kind"],
  opts: Opts,
  found: Findings,
): Promise<T | undefined> {
  for (const ext of ROOT_EXT) {
    const file = join(root, `${name}${ext}`);
    if (!(await stat(file).catch(() => undefined))?.isFile()) continue;
    try {
      const value = await importDefault(file, opts.importer, opts.version);
      if (typeof value === "function") return { kind: name, run: value } as T;
      if (value && typeof value === "object" && typeof (value as T).run === "function") {
        return value as T;
      }
      // A hook that is present and did not load is the dangerous case: the file
      // is there, so the app reads as guarded, and nothing is guarding it.
      found.fault(`${name}${ext}: expected \`export default ${name}(...)\``);
    } catch (err) {
      found.fault(`${name}${ext}: ${(err as Error).message}`);
    }
    return undefined;
  }
  return undefined;
}

async function loadConfig(root: string, opts: Opts, found: Findings): Promise<AppConfig> {
  for (const ext of ROOT_EXT) {
    const file = join(root, `praecise.config${ext}`);
    if (!(await stat(file).catch(() => undefined))?.isFile()) continue;
    try {
      const value = await importDefault(file, opts.importer, opts.version);
      if (value && typeof value === "object") return value as AppConfig;
      found.fault(`praecise.config${ext}: expected \`export default defineConfig({ ... })\``);
    } catch (err) {
      found.fault(`praecise.config${ext}: ${(err as Error).message}`);
    }
    return {};
  }
  return {};
}

// ── Validation ─────────────────────────────────────────────────────────────

/**
 * Check specs for mistakes that would otherwise fail confusingly at run time.
 *
 * What is a fault here and what is advice is decided by one question: would
 * running this produce a result that lies? A workflow with a cycle reports
 * `done` having done nothing, so it is a fault and the runner refuses it. An
 * undescribed prompt runs exactly as written, so it is advice — worth saying,
 * and never a reason to stop.
 */
export function validate(project: Project, found: Findings): void {
  const { agents, workflows, stores } = project;

  for (const [name, spec] of Object.entries(agents)) {
    if (!spec.role?.trim()) found.fault(`agent "${name}": \`role\` is required`);
    const memory = spec.memory;
    if (memory && typeof memory === "object" && memory.store && !stores[memory.store]) {
      found.fault(`agent "${name}": memory names unknown store "${memory.store}"`);
    }
  }

  for (const [name, spec] of Object.entries(project.stores)) {
    if (spec.of === "vector" && !spec.dimensions) {
      found.fault(`store "${name}": a vector store needs \`dimensions\``);
    }
  }

  // A description is the only thing a model reads before deciding whether to
  // open something. Without one it has the name and nothing else, so anything
  // reachable from outside the app is worth naming properly.
  const described: [string, Record<string, { description?: string; input?: Record<string, string> }>][] = [
    ["workflow", workflows],
    ["function", project.functions],
    ["prompt", project.prompts],
    ["resource", project.resources],
    ["blueprint", project.blueprints],
  ];
  for (const [kind, entries] of described) {
    for (const [name, spec] of Object.entries(entries)) {
      for (const fault of faultsIn({ name, description: spec.description, parameters: spec.input })) {
        found.advise(`${kind} "${name}": ${fault}`);
      }
    }
  }

  // An agent is the one case with something to fall back on: with no
  // `description`, its `role` is what gets published. That is fine when the role
  // happens to read as a summary and wrong when it reads as an instruction — a
  // role addressed to the agent tells a caller nothing about whether to call it.
  for (const [name, spec] of Object.entries(agents)) {
    for (const fault of faultsIn({ name, description: spec.description ?? spec.role })) {
      found.advise(`agent "${name}": ${fault}`);
    }
  }

  for (const [name, spec] of Object.entries(workflows)) {
    const named = spec.name ? spec : { ...spec, name };
    // The same sentences the runner refuses on. One check, so what the
    // dashboard shows and what stops a run can never drift apart.
    for (const defect of defectsIn(named, { agents: Object.keys(agents) })) found.fault(defect);
    for (const loose of looseReferencesIn(named)) found.advise(loose);
    for (const dangling of danglingAfterIn(named)) found.advise(dangling);

    // A `plan` step that names an agent nobody wrote still runs: the planner
    // simply gets a smaller palette. Worth saying, not worth refusing.
    walkSteps(spec.steps, (step) => {
      if (!isPlan(step)) return;
      for (const agent of step.from ?? []) {
        if (!agents[agent]) {
          found.advise(`workflow "${name}": step "${step.id}" may draw on unknown agent "${agent}"`);
        }
      }
    });
  }
}

export { findCycle } from "../workflow/defects.js";

/**
 * Read a project directory. Never throws for user error — collects findings.
 *
 * Deliberately still never throws, even for a fault. The loader's own rule is
 * that a typo in one agent must not take down the whole dev server, and that
 * rule is worth more than an early exit: `praecise dev` has to keep serving the
 * eleven things that loaded so the author can read the diagnosis for the
 * twelfth, and a broken workflow must not make a healthy agent unreachable.
 * Refusal belongs at the point where acting on the fault would do harm — the
 * run path refuses, the packager refuses, and every command that loaded a
 * faulty project says so and exits non-zero.
 */
export async function loadProject(dir: string, options: LoadOptions = {}): Promise<Project> {
  const root = resolve(dir);
  const found = new Findings();

  // TypeScript is compiled before anything is imported, and every entry point gets this
  // for free because they all arrive here. Nothing is built for a JavaScript app, or on a
  // runtime that reads TypeScript natively — in both cases this returns the project itself
  // and writes nothing.
  //
  // An explicitly supplied importer wins: a caller that brought its own module loader
  // (the test suite, a hot-reload harness) is not asking for a build step.
  let importer = options.importer;
  if (!importer) {
    try {
      const built = await buildTypeScript(root);
      importer = importerFor(root, built.root, options.version);
    } catch (err) {
      // A build that fails outright — a syntax error, an unwritable directory — is a
      // fault about the app rather than a crash of the loader, so the rest still loads
      // and `check` reports every problem at once.
      found.fault((err as Error).message);
      importer = nativeImport;
    }
  }

  const opts: Opts = {
    importer,
    version: options.version,
    cacheDir: options.cacheDir ?? join(root, ".praecise", "ingest"),
    converter: options.converter,
  };

  const [
    config,
    agents,
    workflows,
    tools,
    functions,
    prompts,
    resources,
    stores,
    blueprints,
    templates,
    middleware,
    guard,
    knowledge,
  ] = await Promise.all([
    loadConfig(root, opts, found),
    loadKind<AgentSpec>(root, "agents", "agent", opts, found),
    loadKind<WorkflowSpec>(root, "workflows", "workflow", opts, found),
    loadKind<ToolSpec>(root, "tools", "tool", opts, found),
    loadKind<FunctionSpec>(root, "functions", "function", opts, found),
    loadKind<PromptSpec>(root, "prompts", "prompt", opts, found),
    loadKind<ResourceSpec>(root, "resources", "resource", opts, found),
    loadKind<StoreSpec>(root, "stores", "store", opts, found),
    loadBlueprints(root, opts, found),
    loadKind<TemplateSpec>(root, "templates", "template", opts, found),
    loadRootHook<MiddlewareSpec>(root, "middleware", opts, found),
    loadRootHook<GuardSpec>(root, "guard", opts, found),
    loadDocs(root, opts, found),
  ]);

  const project: Project = {
    root,
    name: config.name ?? basename(root),
    config,
    agents,
    workflows,
    tools,
    functions,
    prompts,
    resources,
    stores,
    blueprints,
    templates,
    middleware,
    guard,
    knowledge,
    warnings: found.warnings,
    faults: found.faults,
  };
  validate(project, found);
  return project;
}

/** Resolve an agent's `knows` patterns against the project's documents and disk. */
export async function resolveKnows(project: Project, patterns: string[]): Promise<Doc[]> {
  const docs: Doc[] = [];
  for (const pattern of patterns) {
    // Inline text: anything with whitespace and no path-ish shape.
    if (!/^[\w./*[\]{}-]+$/.test(pattern)) {
      docs.push({ name: "inline", content: pattern });
      continue;
    }
    const named = project.knowledge.filter((d) => d.name === pattern.replace(/\.\w+$/, ""));
    if (named.length) {
      docs.push(...named);
      continue;
    }
    for (const file of await expand(project.root, pattern)) {
      const { text } = await ingestFile(file, {
        cacheDir: join(project.root, ".praecise", "ingest"),
      }).catch(() => ({ text: "" }));
      if (!text) continue;
      docs.push({ name: relative(project.root, file), content: text, path: file });
    }
  }
  return docs;
}

/** Expand a path or glob relative to the project root. */
async function expand(root: string, pattern: string): Promise<string[]> {
  if (!/[*?[]/.test(pattern)) {
    const file = resolve(root, pattern);
    return (await stat(file).catch(() => undefined))?.isFile() ? [file] : [];
  }
  const fs = await import("node:fs/promises");
  const glob = (fs as { glob?: (p: string, o: object) => AsyncIterable<string> }).glob;
  if (!glob) return [];
  const out: string[] = [];
  for await (const match of glob(pattern, { cwd: root })) out.push(resolve(root, match));
  return out;
}
