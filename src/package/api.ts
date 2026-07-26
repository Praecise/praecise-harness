/**
 * The same app, offered as code instead of as a list of tools.
 *
 * A tool list is read before it is used: every schema for every tool sits in
 * the caller's context whether or not it ends up calling any of them. A caller
 * that can run code does not need that. It needs a typed module it can import,
 * read the one signature it wants, and call — which is a line per tool rather
 * than a schema per tool.
 *
 * This is a second projection of the same surface, not a second surface. Calls
 * go through the same path the protocol uses, so a thing that is gated is gated
 * here too, and a thing marked internal is absent from both.
 */

import type { PackageManifest } from "./build.js";
import type { McpTool } from "../server/mcp.js";

/** Comment text with nothing in it that could end the comment. */
const safe = (text: string): string => text.replace(/\*\//g, "*\\/");

/** The argument type for one tool, read off the schema it publishes. */
function argsType(tool: McpTool): string {
  const properties = (tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
  const required = new Set((tool.inputSchema.required ?? []) as string[]);
  const entries = Object.entries(properties);
  if (!entries.length) return "Record<string, never>";

  const fields = entries.map(([key, property]) => {
    const hint = property?.description ? `\n    /** ${safe(property.description)} */` : "";
    return `${hint}\n    ${JSON.stringify(key)}${required.has(key) ? "" : "?"}: string;`;
  });
  return `{${fields.join("")}\n  }`;
}

/**
 * The types a consumer reads.
 *
 * Everything is one object rather than a set of named exports, because a name
 * here came from a filename and a filename is not obliged to be a valid
 * identifier. One object takes any name without renaming it behind the
 * author's back.
 */
export function apiTypes(manifest: PackageManifest): string {
  const members = manifest.tools.map((tool) => {
    return `  /** ${safe(tool.description)} */\n  ${JSON.stringify(tool.name)}(args: ${argsType(tool)}): Promise<string>;`;
  });

  return `/**
 * ${safe(manifest.name)} — every published part of the app, as functions.
 *
 * Each one answers with text, and throws if the call was refused or failed.
 * Anything this app keeps to itself is absent here, exactly as it is absent
 * from the tool list.
 */
export interface Api {
${members.join("\n\n") || "  // Nothing is published: every part of this app is marked internal."}
}

declare const api: Api;
export default api;
`;
}

/** The module that backs those types. */
export function apiModule(manifest: PackageManifest): string {
  const caller = JSON.stringify({
    identified: manifest.shape === "local",
    groups: manifest.groups,
    readOnly: manifest.readOnly,
  });

  const members = manifest.tools.map(
    (tool) =>
      `  ${JSON.stringify(tool.name)}: (args) => call(${JSON.stringify(tool.name)}, args),`,
  );

  return `import { App, callPublished } from "praecise";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const caller = ${caller};

// Loaded once, on the first call, so importing this module costs nothing.
let loading;
const open = () =>
  (loading ??= App.load({
    root,
    name: ${JSON.stringify(manifest.name)},
    version: ${JSON.stringify(manifest.version)},
  }));

async function call(name, args) {
  const { text, isError } = await callPublished(await open(), name, args ?? {}, caller);
  if (isError) throw new Error(text);
  return text;
}

export default {
${members.join("\n")}
};
`;
}
