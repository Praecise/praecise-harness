/**
 * Turning a folder into something someone else can run.
 *
 * What comes out is an ordinary npm package: a manifest, a launcher, and the
 * author's own files copied in unchanged. There is no bundle step and no
 * compiled artifact, because the folder already is the app — packaging only
 * settles the questions a stranger would otherwise have to ask. What does it
 * publish, what may it touch, how is it started.
 *
 * Two things are decided here rather than at run time. Which parts are
 * published, since `internal` work has no business leaving the building. And
 * what the tool surface looks like, written down as a manifest so a change to
 * it is a diff someone can review rather than a surprise a caller discovers.
 */

import { cp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { App } from "../app.js";
import {
  groupsOf,
  noticesOf,
  toolsOf,
  PROTOCOL_VERSION,
  type Caller,
  type McpTool,
} from "../server/mcp.js";
import { apiModule, apiTypes } from "./api.js";
import { faultsIn, hintsIn } from "./describe.js";

/** The folders that make up an app, and so the folders that travel with it. */
const CARRIED = [
  "agents",
  "workflows",
  "functions",
  "tools",
  "prompts",
  "resources",
  "stores",
  "memory",
  "middleware.ts",
  "praecise.config.ts",
];

export interface PackageOptions {
  app: App;
  /** Where to write. Defaults to `<root>/dist`. */
  out?: string;
  /**
   * Publish only these groups. Left out, everything not marked internal goes.
   */
  groups?: string[];
  /**
   * How the packaged app decides who it is talking to. `"local"` trusts the
   * caller because a person launched it; `"hosted"` does not, so anything
   * `gated` stays hidden until the caller proves itself.
   */
  shape?: "local" | "hosted";
  /** Publish only what changes nothing. */
  readOnly?: boolean;
  /** Version of the framework to depend on. */
  framework?: string;
}

export interface PackageManifest {
  name: string;
  version: string;
  description?: string;
  protocolVersion: string;
  shape: "local" | "hosted";
  readOnly?: boolean;
  groups: string[];
  tools: McpTool[];
}

/**
 * What a packaged app publishes. Built against the same caller the packaged app
 * will see, so the manifest cannot promise more than the running server allows.
 */
export function manifestFor(app: App, options: PackageOptions = { app }): PackageManifest {
  const shape = options.shape ?? "local";
  const caller: Caller = {
    identified: shape === "local",
    groups: options.groups,
    readOnly: options.readOnly,
  };

  return {
    name: app.name,
    version: app.version,
    description: app.config.description,
    protocolVersion: PROTOCOL_VERSION,
    shape,
    readOnly: options.readOnly,
    groups: options.groups ?? groupsOf(app),
    tools: toolsOf(app, caller),
  };
}

/**
 * The launcher a client runs. Thin on purpose: the app is the folder.
 *
 * Name and version are written in rather than read from the directory, because
 * the directory belongs to whoever installed it and tells us nothing about what
 * this app is called.
 */
function launcher(manifest: PackageManifest): string {
  return `#!/usr/bin/env node
import { App, serveStdio } from "praecise";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const app = await App.load({
  root,
  name: ${JSON.stringify(manifest.name)},
  version: ${JSON.stringify(manifest.version)},
});
const server = serveStdio({ app, caller: ${JSON.stringify({
    identified: manifest.shape === "local",
    groups: manifest.groups,
    readOnly: manifest.readOnly,
  })} });
await server.done;
await app.close();
`;
}

function packageJson(manifest: PackageManifest, framework: string): string {
  return `${JSON.stringify(
    {
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      type: "module",
      bin: { [manifest.name]: "./start.js" },
      // Importable as well as launchable: the tool list and the typed module
      // are two ways into the same app, and which one suits depends on whether
      // the caller can run code.
      main: "./api.js",
      types: "./api.d.ts",
      exports: { ".": { types: "./api.d.ts", default: "./api.js" } },
      files: ["start.js", "api.js", "api.d.ts", "mcp.json", ...CARRIED],
      dependencies: { praecise: framework },
      engines: { node: ">=22" },
    },
    null,
    2,
  )}\n`;
}

/** What a person reads before they trust it. */
function readme(manifest: PackageManifest): string {
  const rows = manifest.tools
    .map((tool) => `- \`${tool.name}\` — ${tool.description}`)
    .join("\n");

  return `# ${manifest.name}

${manifest.description ?? "An agent app published over MCP."}

Run it as an MCP server over stdio:

    npx ${manifest.name}

It speaks MCP revision ${manifest.protocolVersion}.

Or import it, if you would rather write code than read a tool list:

\`\`\`ts
import app from "${manifest.name}";

const answer = await app.${manifest.tools[0]?.name ?? "something"}({ /* … */ });
\`\`\`

Both reach the same app under the same rules.

## What it publishes

${rows || "_Nothing — every part of this app is marked internal._"}

Anything this app keeps to itself is absent from that list and cannot be
reached, whether or not a caller knows its name.
`;
}

export interface PackageResult {
  out: string;
  manifest: PackageManifest;
  files: string[];
  /** Worth saying to whoever built it, without stopping the build. */
  notes: string[];
}

/**
 * Everything in a manifest that a stranger could not act on.
 *
 * Checked here rather than only at load because publishing is the moment it
 * stops being fixable by the person who can fix it. While you are working, an
 * unreadable description is a warning you may be about to address; once it is
 * on someone else's machine it is a caller guessing.
 */
export function faultsInManifest(manifest: PackageManifest): string[] {
  return manifest.tools.flatMap((tool) =>
    faultsIn({
      name: tool.name,
      description: tool.description,
      parameters: hintsIn(tool.inputSchema),
    }).map((fault) => `${tool.name}: ${fault}`),
  );
}

/** Write a distributable package for an app. */
export async function buildPackage(options: PackageOptions): Promise<PackageResult> {
  const { app } = options;
  const out = resolve(options.out ?? join(app.root, "dist"));
  const manifest = manifestFor(app, options);
  const framework = options.framework ?? "^0.1.0";

  const faults = faultsInManifest(manifest);
  if (faults.length) {
    throw new Error(
      `this app is not ready to hand to someone else:\n${faults.map((f) => `  ${f}`).join("\n")}\n\n` +
        `Describe each one, or mark it \`access: "internal"\` if it was never meant to leave.`,
    );
  }

  await mkdir(out, { recursive: true });

  for (const entry of CARRIED) {
    await cp(join(app.root, entry), join(out, entry), { recursive: true }).catch(() => undefined);
  }

  const written = [
    ["package.json", packageJson(manifest, framework)],
    ["mcp.json", `${JSON.stringify(manifest, null, 2)}\n`],
    ["start.js", launcher(manifest)],
    ["api.js", apiModule(manifest)],
    ["api.d.ts", apiTypes(manifest)],
    ["README.md", readme(manifest)],
  ] as const;

  for (const [name, contents] of written) {
    await writeFile(join(out, name), contents, "utf8");
  }

  return {
    out,
    manifest,
    files: written.map(([name]) => name),
    notes: noticesOf(app, {
      identified: manifest.shape === "local",
      groups: options.groups,
      readOnly: options.readOnly,
    }),
  };
}
