/**
 * What a plugin brings to an app, put where the app's own things are.
 *
 * A plugin is a package that extends an app from `praecise.config.ts`. It could add
 * commands to the CLI and nothing else, which meant a library of agents and functions
 * had two ways in and neither was a line in a config: a folder to copy, which stops
 * receiving fixes the moment it is copied, or a rewrite of the app as code so
 * `mergeApps` could reach it.
 *
 * So a plugin may carry a piece of an app. The piece is merged under the app's own
 * folder — the app is the one stating what it is, and a library that could silently
 * replace an agent the app wrote would make the folder a liar — and every collision is
 * said out loud rather than settled quietly.
 */

import type { Plugin } from "../define.js";
import { hooksFrom } from "../harness/hooks.js";
import type { Findings, Project } from "./load.js";

/** The kinds a plugin may bring. Each is a record on `Project`, keyed by name. */
const KINDS = ["agents", "workflows", "tools", "functions", "prompts", "resources", "stores", "evals"] as const;

type Kind = (typeof KINDS)[number];

/** What each kind's declaration is tagged with, for a piece written as a plain object. */
const TAG: Record<Kind, string> = {
  agents: "agent",
  workflows: "workflow",
  tools: "tool",
  functions: "function",
  prompts: "prompt",
  resources: "resource",
  stores: "store",
  evals: "evaluation",
};

/**
 * Merge every plugin's piece into the project, the app's own definitions winning.
 *
 * Runs before validation, so what a plugin brings is held to exactly the rules the
 * folder is held to: an agent with no role is a fault wherever it came from.
 */
export function mergePlugins(project: Project, plugins: readonly Plugin[] | undefined, found: Findings): void {
  const seen = new Set<string>();
  for (const plugin of plugins ?? []) {
    if (!plugin || typeof plugin.name !== "string" || !plugin.name.trim()) {
      found.fault("a plugin in `plugins` has no name; every plugin needs one, to be named when something it brings goes wrong");
      continue;
    }
    if (seen.has(plugin.name)) {
      found.fault(`two plugins are named "${plugin.name}"; the second is not loaded`);
      continue;
    }
    seen.add(plugin.name);

    // Checked here and composed where the app is assembled: a plugin whose hooks do not
    // load is one whose checks would silently not be made.
    if (plugin.hooks !== undefined && !hooksFrom(plugin.hooks)) {
      found.fault(
        `plugin "${plugin.name}" brings hooks that are not hooks: expected at least one of afterTool, beforeStop, beforeCompact, each a function`,
      );
    }

    for (const kind of KINDS) {
      const brought = plugin.app?.[kind] as Record<string, { name?: string }> | undefined;
      if (!brought) continue;
      const own = (project[kind] ??= {} as never) as Record<string, unknown>;
      for (const [name, spec] of Object.entries(brought)) {
        if (own[name] !== undefined) {
          found.advise(
            `plugin "${plugin.name}" brings ${singular(kind)} "${name}" and this app already has one by that name; the app's is used`,
          );
          continue;
        }
        // Named by its key, as a file names what is in it, and tagged as what it is
        // whether it was written with `agent({...})` or as the bare object.
        own[name] = { kind: TAG[kind], ...spec, name: spec?.name ?? name };
      }
    }
  }
}

const singular = (kind: Kind): string => (kind === "evals" ? "eval" : kind.slice(0, -1));

/**
 * Run each plugin's `setup`, once, before the app is planned.
 *
 * This is where a plugin registers what is process-wide rather than part of an app: a
 * request shape, a reader for a kind of data. A setup that throws is reported with the
 * plugin's name and does not stop the app loading — what it would have registered is
 * missing, and the thing that needed it will say so in its own words.
 */
export async function setupPlugins(plugins: readonly Plugin[] | undefined, problem: (text: string) => void): Promise<void> {
  for (const plugin of plugins ?? []) {
    if (typeof plugin?.setup !== "function") continue;
    try {
      await plugin.setup();
    } catch (err) {
      problem(`plugin "${plugin.name}" failed to set up: ${(err as Error).message}`);
    }
  }
}
