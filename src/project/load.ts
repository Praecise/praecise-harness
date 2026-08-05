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
  Step,
  StoreSpec,
  TemplateSpec,
  ToolSpec,
  WorkflowSpec,
} from "../define.js";
import { isEach, isPlan, isRepeat, isWhen } from "../define.js";
import { canConvert, ingestFile, isTextFormat, type Converter } from "../ingest/index.js";
import { faultsIn } from "../package/describe.js";

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
}

/** How a user module is imported. Swapped in tests; cache-busted on hot reload. */
export type Importer = (fileUrl: string) => Promise<Record<string, unknown>>;

const nativeImport: Importer = (fileUrl) =>
  import(fileUrl) as Promise<Record<string, unknown>>;

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
  warnings: string[],
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
      warnings.push(`${relative(root, file)}: ${(err as Error).message}`);
      continue;
    }
    if (!value || typeof value !== "object") {
      warnings.push(`${relative(root, file)}: expected \`export default ${expect}({ ... })\``);
      continue;
    }
    const spec = value as { kind?: string; name?: string };
    if (spec.kind !== expect) {
      warnings.push(
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
async function loadDocs(root: string, opts: Opts, warnings: string[]): Promise<Doc[]> {
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
          warnings.push(`${DOC_DIR}/${name}: expected \`export default knowledge({ content })\``);
          continue;
        }
        docs.push({ name: value.name ?? name, content: value.content, path: file });
      } catch (err) {
        warnings.push(`${DOC_DIR}/${name}: ${(err as Error).message}`);
      }
      continue;
    }

    if (!canConvert(ext) && !isTextFormat(ext) && !opts.converter) {
      warnings.push(`${DOC_DIR}/${name}${ext}: nothing here can read a "${ext}" file`);
      continue;
    }

    try {
      const { text, note } = await ingestFile(file, {
        cacheDir: opts.cacheDir,
        fallback: opts.converter,
      });
      if (note) warnings.push(`${DOC_DIR}/${name}${ext}: ${note}`);
      if (text.trim()) docs.push({ name, content: text, path: file });
    } catch (err) {
      warnings.push(`${DOC_DIR}/${name}${ext}: ${(err as Error).message}`);
    }
  }

  return docs;
}

/** Blueprints may be `.md` — the prose is the intent, and that is the whole file. */
async function loadBlueprints(
  root: string,
  opts: Opts,
  warnings: string[],
): Promise<Record<string, BlueprintSpec>> {
  const out = await loadKind<BlueprintSpec>(root, "blueprints", "blueprint", opts, warnings);
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
  warnings: string[],
): Promise<T | undefined> {
  for (const ext of [".ts", ".mts", ".js", ".mjs"]) {
    const file = join(root, `${name}${ext}`);
    if (!(await stat(file).catch(() => undefined))?.isFile()) continue;
    try {
      const value = await importDefault(file, opts.importer, opts.version);
      if (typeof value === "function") return { kind: name, run: value } as T;
      if (value && typeof value === "object" && typeof (value as T).run === "function") {
        return value as T;
      }
      warnings.push(`${name}${ext}: expected \`export default ${name}(...)\``);
    } catch (err) {
      warnings.push(`${name}${ext}: ${(err as Error).message}`);
    }
    return undefined;
  }
  return undefined;
}

async function loadConfig(root: string, opts: Opts, warnings: string[]): Promise<AppConfig> {
  for (const ext of [".ts", ".mts", ".js", ".mjs"]) {
    const file = join(root, `praecise.config${ext}`);
    if (!(await stat(file).catch(() => undefined))?.isFile()) continue;
    try {
      const value = await importDefault(file, opts.importer, opts.version);
      if (value && typeof value === "object") return value as AppConfig;
      warnings.push(`praecise.config${ext}: expected \`export default defineConfig({ ... })\``);
    } catch (err) {
      warnings.push(`praecise.config${ext}: ${(err as Error).message}`);
    }
    return {};
  }
  return {};
}

// ── Validation ─────────────────────────────────────────────────────────────

/** Walk a step's nested steps, whatever kind it is. */
function childrenOf(step: Step): Step[][] {
  if (isEach(step)) return [step.do];
  if (isRepeat(step)) return [step.repeat];
  if (isWhen(step)) return [...Object.values(step.is), step.otherwise ?? []];
  return [];
}

/** Check specs for mistakes that would otherwise fail confusingly at run time. */
function validate(project: Project): void {
  const { agents, workflows, stores, warnings } = project;

  for (const [name, spec] of Object.entries(agents)) {
    if (!spec.role?.trim()) warnings.push(`agent "${name}": \`role\` is required`);
    const memory = spec.memory;
    if (memory && typeof memory === "object" && memory.store && !stores[memory.store]) {
      warnings.push(`agent "${name}": memory names unknown store "${memory.store}"`);
    }
  }

  for (const [name, spec] of Object.entries(project.stores)) {
    if (spec.of === "vector" && !spec.dimensions) {
      warnings.push(`store "${name}": a vector store needs \`dimensions\``);
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
        warnings.push(`${kind} "${name}": ${fault}`);
      }
    }
  }

  // An agent is the one case with something to fall back on: with no
  // `description`, its `role` is what gets published. That is fine when the role
  // happens to read as a summary and wrong when it reads as an instruction — a
  // role addressed to the agent tells a caller nothing about whether to call it.
  for (const [name, spec] of Object.entries(agents)) {
    for (const fault of faultsIn({ name, description: spec.description ?? spec.role })) {
      warnings.push(`agent "${name}": ${fault}`);
    }
  }

  const checkSteps = (steps: Step[] | undefined, where: string): void => {
    const seen = new Set<string>();
    for (const step of steps ?? []) {
      if (!step.id) {
        warnings.push(`${where}: every step needs an \`id\``);
        continue;
      }
      if (seen.has(step.id)) warnings.push(`${where}: duplicate step id "${step.id}"`);
      seen.add(step.id);
      if ("ask" in step && step.agent && !agents[step.agent]) {
        warnings.push(`${where}: step "${step.id}" references unknown agent "${step.agent}"`);
      }
      if (isRepeat(step) && !(step.max > 0)) {
        warnings.push(`${where}: step "${step.id}" needs a positive \`max\` — a loop without one cannot end`);
      }
      if (isPlan(step)) {
        for (const agent of step.from ?? []) {
          if (!agents[agent]) {
            warnings.push(`${where}: step "${step.id}" may draw on unknown agent "${agent}"`);
          }
        }
      }
      for (const branch of childrenOf(step)) checkSteps(branch, where);
    }

    // `after` may only name a sibling, and the sibling graph must be acyclic.
    for (const step of steps ?? []) {
      for (const need of step.after ?? []) {
        if (!seen.has(need)) {
          warnings.push(`${where}: step "${step.id}" waits for "${need}", which is not a step beside it`);
        }
      }
    }
    const cycle = findCycle(steps ?? []);
    if (cycle) warnings.push(`${where}: steps wait on each other in a circle — ${cycle.join(" → ")}`);
  };

  for (const [name, spec] of Object.entries(workflows)) {
    if (!spec.steps?.length) warnings.push(`workflow "${name}": needs at least one step`);
    checkSteps(spec.steps, `workflow "${name}"`);
  }
}

/** Depth-first search for a cycle in the `after` graph, returning the loop. */
export function findCycle(steps: Step[]): string[] | undefined {
  const edges = new Map(steps.map((step) => [step.id, step.after ?? []]));
  const state = new Map<string, "open" | "done">();
  const stack: string[] = [];

  const visit = (id: string): string[] | undefined => {
    const mark = state.get(id);
    if (mark === "done") return undefined;
    if (mark === "open") return [...stack.slice(stack.indexOf(id)), id];

    state.set(id, "open");
    stack.push(id);
    for (const next of edges.get(id) ?? []) {
      if (!edges.has(next)) continue;
      const found = visit(next);
      if (found) return found;
    }
    stack.pop();
    state.set(id, "done");
    return undefined;
  };

  for (const step of steps) {
    const found = visit(step.id);
    if (found) return found;
  }
  return undefined;
}

/** Read a project directory. Never throws for user error — collects warnings. */
export async function loadProject(dir: string, options: LoadOptions = {}): Promise<Project> {
  const root = resolve(dir);
  const opts: Opts = {
    importer: options.importer ?? nativeImport,
    version: options.version,
    cacheDir: options.cacheDir ?? join(root, ".praecise", "ingest"),
    converter: options.converter,
  };
  const warnings: string[] = [];

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
    loadConfig(root, opts, warnings),
    loadKind<AgentSpec>(root, "agents", "agent", opts, warnings),
    loadKind<WorkflowSpec>(root, "workflows", "workflow", opts, warnings),
    loadKind<ToolSpec>(root, "tools", "tool", opts, warnings),
    loadKind<FunctionSpec>(root, "functions", "function", opts, warnings),
    loadKind<PromptSpec>(root, "prompts", "prompt", opts, warnings),
    loadKind<ResourceSpec>(root, "resources", "resource", opts, warnings),
    loadKind<StoreSpec>(root, "stores", "store", opts, warnings),
    loadBlueprints(root, opts, warnings),
    loadKind<TemplateSpec>(root, "templates", "template", opts, warnings),
    loadRootHook<MiddlewareSpec>(root, "middleware", opts, warnings),
    loadRootHook<GuardSpec>(root, "guard", opts, warnings),
    loadDocs(root, opts, warnings),
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
    warnings,
  };
  validate(project);
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
