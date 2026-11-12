/**
 * Plugins the app wrote down rather than imported: `praecise.plugins.json`.
 *
 * `praecise.config.ts` is code, and a command that edits somebody's code to add an
 * import is a command that will one day edit it wrong. So `praecise add <plugin>`
 * writes a line of JSON beside the config instead, and this reads it: each recorded
 * plugin is imported from the app's own `node_modules` and joins the ones the config
 * lists, under them, so a plugin the config names is never replaced by a recorded one.
 *
 * The framework runs no package manager. A plugin that is recorded and not installed
 * is said so, with the command that installs it, and the app loads without it.
 */

import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { Plugin } from "../define.js";
import { PLUGINS_FILE, installCommand, readRecordedPlugins } from "../registry/install.js";
import type { Findings } from "./load.js";

/** The file a package is imported from, read off its own package.json. */
function entryOf(manifest: Record<string, unknown>): string {
  const pick = (value: unknown): string | undefined => {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const held = value as Record<string, unknown>;
    // The package's root, then the conditions an import is resolved under, in order.
    return pick(held["."]) ?? pick(held.import) ?? pick(held.node) ?? pick(held.default);
  };
  const main = typeof manifest.main === "string" ? manifest.main : undefined;
  return pick(manifest.exports) ?? (typeof manifest.module === "string" ? manifest.module : undefined) ?? main ?? "index.js";
}

/** Find an installed package the way Node does: `node_modules` here, then in each folder above. */
async function installedAt(root: string, name: string): Promise<string | undefined> {
  for (let dir = resolve(root); ; dir = dirname(dir)) {
    const at = join(dir, "node_modules", name);
    if ((await stat(join(at, "package.json")).catch(() => undefined))?.isFile()) return at;
    if (dirname(dir) === dir) return undefined;
  }
}

/** Import every recorded plugin that is installed, and say which are not. */
export async function loadRecordedPlugins(root: string, found: Findings): Promise<Plugin[]> {
  const { plugins, fault } = await readRecordedPlugins(root);
  if (fault) found.fault(fault);

  const out: Plugin[] = [];
  for (const recorded of plugins) {
    const at = await installedAt(root, recorded.package);
    if (!at) {
      found.advise(
        `plugin "${recorded.name}" is recorded in ${PLUGINS_FILE} and is not installed; run \`${installCommand(recorded)}\``,
      );
      continue;
    }
    try {
      const manifest = JSON.parse(await readFile(join(at, "package.json"), "utf8")) as Record<string, unknown>;
      const module = (await import(pathToFileURL(resolve(at, entryOf(manifest))).href)) as Record<string, unknown>;
      const plugin = (module.default ?? module.plugin) as Plugin | undefined;
      if (!plugin || typeof plugin !== "object" || typeof plugin.name !== "string") {
        found.fault(`plugin "${recorded.name}": ${recorded.package} does not export a plugin as its default export`);
        continue;
      }
      out.push(plugin);
    } catch (err) {
      found.fault(`plugin "${recorded.name}": ${recorded.package} did not load: ${(err as Error).message}`);
    }
  }
  return out;
}
