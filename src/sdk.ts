/**
 * The app as a value you import, rather than a folder somebody scans.
 *
 * Praecise Harness has always had one front door: a directory laid out by convention, read
 * at startup. That is the right default — a folder is discoverable, diffable, and lets a
 * file's name be its name — and it is not the only shape an app comes in. This is the
 * second door, and it opens onto exactly the same room.
 *
 * ── Why a second door at all ──────────────────────────────────────────────────
 *
 * Four things are awkward or impossible when an app must be a directory:
 *
 * **Distribution.** A library cannot ship agents. It can ship a folder for you to copy,
 * which is not the same thing — the moment it is copied it stops receiving fixes. With
 * this, a package exports an app, or a piece of one, and `import` does the rest.
 *
 * **Runtimes without a filesystem to scan.** An edge worker, a bundled binary, a browser.
 * The loader needs `readdir` and dynamic `import` of arbitrary paths; a bundler needs to
 * see imports statically. Those requirements are in direct opposition, and this side
 * satisfies the second.
 *
 * **Authoring in TypeScript.** The loader imports source files at RUNTIME, so a `.ts` app
 * needs a runtime that understands TypeScript — the failure this repo just made
 * legible rather than mysterious. An imported app is compiled by whatever compiles the
 * rest of your code, before it ever runs, and the question does not arise.
 *
 * **Composition.** Apps built from parts, generated from a spec, or assembled per tenant
 * are values here, not directory trees written to a temporary path first.
 *
 * ── The property that makes two doors safe ────────────────────────────────────
 *
 * Both produce the same `Project` and run the same `validate`. That is not a tidiness
 * preference: two front doors with two standards is a framework where an app that works
 * one way is rejected the other, and the difference shows up as a bug report nobody can
 * reproduce. Every check the folder loader applies — an agent without a role, memory
 * pointing at a store that does not exist, a workflow with a cycle, a tool the model
 * could not choose from its description — applies here, in the same words.
 *
 * What is deliberately NOT reproduced is anything that is a fact about files: an
 * unreadable document, a module that threw on import, a `.ts` file a runtime would not
 * load. There are no files here, so there is nothing to say.
 */

import { basename, resolve } from "node:path";

import { App, type AppOptions } from "./app.js";
import { Findings, validate, type Doc, type Project } from "./project/load.js";
import type {
  AgentSpec,
  AppConfig,
  BlueprintSpec,
  FunctionSpec,
  GuardSpec,
  MiddlewareSpec,
  PromptSpec,
  ResourceSpec,
  StoreSpec,
  TemplateSpec,
  ToolSpec,
  WorkflowSpec,
} from "./define.js";

/**
 * An app, described in code.
 *
 * The record key is the name, which is the same rule the folder convention uses —
 * `agents/support.ts` is the agent `support`, and `{ agents: { support } }` is the same
 * agent by the same name. One rule, two spellings, so knowing one tells you the other.
 */
export interface AppDefinition {
  name?: string;
  version?: string;
  /**
   * Where this app's state lives: run records, store files, whatever it writes.
   *
   * Nothing is READ from here — that is the whole point of this door — but an app that
   * remembers anything has to remember it somewhere, and a framework that silently chose
   * a directory to write into would be worse than one that says it defaults to the
   * working directory.
   */
  root?: string;
  /** Models, preference, and everything else `defineConfig` accepts. */
  config?: AppConfig;

  agents?: Record<string, AgentSpec>;
  workflows?: Record<string, WorkflowSpec>;
  tools?: Record<string, ToolSpec>;
  functions?: Record<string, FunctionSpec>;
  prompts?: Record<string, PromptSpec>;
  resources?: Record<string, ResourceSpec>;
  stores?: Record<string, StoreSpec>;
  blueprints?: Record<string, BlueprintSpec>;
  templates?: Record<string, TemplateSpec>;

  /** The one guard for the whole app, as `guard.ts` would be. */
  guard?: GuardSpec;
  /** The one middleware for the whole app, as `middleware.ts` would be. */
  middleware?: MiddlewareSpec;
  /** What every agent knows, as `memory/` would hold. */
  knowledge?: Doc[];
}

/**
 * Build a project from a definition, checking it exactly as a folder would be checked.
 *
 * Returns the project rather than an app so that the result can be inspected, merged, or
 * handed somewhere else before anything is started. `project.warnings` and
 * `project.faults` say what was found; a fault means the app will not run as written, and
 * `createApp` refuses on one rather than starting something known to be broken.
 */
export function defineApp(definition: AppDefinition): Project {
  const found = new Findings();
  const root = resolve(definition.root ?? process.cwd());
  const config = definition.config ?? {};

  const project: Project = {
    root,
    name: definition.name ?? config.name ?? basename(root),
    config: {
      ...config,
      ...(definition.name ? { name: definition.name } : {}),
      ...(definition.version ? { version: definition.version } : {}),
    },
    agents: { ...definition.agents },
    workflows: { ...definition.workflows },
    tools: { ...definition.tools },
    functions: { ...definition.functions },
    prompts: { ...definition.prompts },
    resources: { ...definition.resources },
    stores: { ...definition.stores },
    blueprints: { ...definition.blueprints },
    templates: { ...definition.templates },
    middleware: definition.middleware,
    guard: definition.guard,
    knowledge: definition.knowledge ?? [],
    warnings: found.warnings,
    faults: found.faults,
  };

  // The same function the folder loader calls, on the same shape, in the same order.
  validate(project, found);
  return project;
}

/**
 * A definition, ready to run.
 *
 * Refuses on a fault. The folder loader keeps a faulted project so `dev` and `check` can
 * report every problem at once rather than one per run, which is right for a command
 * whose job is to tell you what is wrong. Starting an app in code is a different moment:
 * the caller is about to serve requests with it, and an app missing the agent those
 * requests name should fail here rather than at the first one.
 */
export async function createApp(definition: AppDefinition, options: AppOptions = {}): Promise<App> {
  const project = defineApp(definition);
  if (project.faults?.length) {
    throw new Error(
      `this app cannot run as written:\n  ${project.faults.join("\n  ")}`,
    );
  }
  return App.from(project, options);
}

/**
 * Combine definitions, so an app can be assembled from parts that do not know each other.
 *
 * This is what makes an app distributable: a package exports the agents and functions it
 * owns, an application merges them with its own, and neither had to know the other's
 * shape. Later definitions win on a name collision, because the merge order is the
 * caller's statement of precedence — an application overriding a library's agent is the
 * point, not an accident.
 *
 * Collisions are REPORTED, not silent. Two packages that both export an agent called
 * `support` produce an app where one of them is simply gone, and that is exactly the kind
 * of thing nobody notices until the wrong one answers.
 */
export function mergeApps(...definitions: AppDefinition[]): AppDefinition & { collisions: string[] } {
  const collisions: string[] = [];
  const merged: AppDefinition & { collisions: string[] } = { collisions };

  const KINDS = [
    "agents",
    "workflows",
    "tools",
    "functions",
    "prompts",
    "resources",
    "stores",
    "blueprints",
    "templates",
  ] as const;

  for (const definition of definitions) {
    for (const kind of KINDS) {
      const incoming = definition[kind];
      if (!incoming) continue;
      const existing = (merged[kind] ?? {}) as Record<string, unknown>;
      for (const name of Object.keys(incoming)) {
        if (name in existing) collisions.push(`${kind.replace(/s$/, "")} "${name}" is defined more than once`);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (merged as any)[kind] = { ...existing, ...incoming };
    }

    if (definition.knowledge?.length) {
      merged.knowledge = [...(merged.knowledge ?? []), ...definition.knowledge];
    }
    // The single-valued parts are last-wins with no merge to attempt: two guards is not
    // a guard, and quietly running only one of them would be the worst outcome available.
    if (definition.guard) {
      if (merged.guard) collisions.push("more than one guard was supplied; the last one wins");
      merged.guard = definition.guard;
    }
    if (definition.middleware) {
      if (merged.middleware) collisions.push("more than one middleware was supplied; the last one wins");
      merged.middleware = definition.middleware;
    }
    if (definition.config) merged.config = { ...merged.config, ...definition.config };
    if (definition.name) merged.name = definition.name;
    if (definition.version) merged.version = definition.version;
    if (definition.root) merged.root = definition.root;
  }

  return merged;
}
