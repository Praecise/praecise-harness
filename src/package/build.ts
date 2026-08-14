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

import { cp, mkdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { App } from "../app.js";
import { ROOT_EXT } from "../project/load.js";
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
const CARRIED_DIRS = [
  "agents",
  "workflows",
  "functions",
  "tools",
  "prompts",
  "resources",
  "stores",
  "memory",
];

/**
 * The root files, named without an extension because the loader accepts four.
 *
 * This list used to say `guard.ts`, and the copy that failed was swallowed — so
 * packaging an app written in JavaScript shipped it without its guard, and said
 * nothing. A security control that disappears in transit is the one kind of bug
 * that gets quieter the worse it is, so the extension is worked out from what is
 * actually on disk and a control that was declared and could not be copied stops
 * the build.
 */
const CARRIED_FILES = ["middleware", "guard", "praecise.config"] as const;

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

/**
 * npm's own rule for a package name, and the reserved names it will not take.
 * Kept as the last word here rather than as a shape we hope npm agrees with:
 * a package that installs nowhere is not a package.
 */
const NPM_NAME = /^(?:@[a-z0-9-*~][a-z0-9-*._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const RESERVED = new Set(["node_modules", "favicon.ico"]);

/**
 * The name npm will take, from the name a person chose.
 *
 * These are two different names and the packager used to conflate them: an app
 * called `"Acme Support"` — the README's own example — emitted
 * `"name": "Acme Support"` and `bin: { "Acme Support": … }`, which npm rejects
 * outright and `npx` cannot resolve. The package was broken in the one way that
 * packaging exists to prevent, and nothing said so.
 *
 * Only the identifiers are slugged. What the app calls itself stays exactly as
 * written, on the manifest, in the README heading, and in what the running app
 * reports as its name — a person's name for their app is not the packager's to
 * rewrite.
 */
export function npmNameFor(name: string): string {
  const part = (value: string): string =>
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._~-]+/g, "-")
      .replace(/^[._~-]+/, "")
      .replace(/[._~-]+$/, "");

  const scoped = name.trim().match(/^@([^/]+)\/(.+)$/);
  const slug = scoped ? `@${part(scoped[1]!)}/${part(scoped[2]!)}` : part(name);

  if (!NPM_NAME.test(slug) || slug.length > 214 || RESERVED.has(slug)) {
    throw new Error(
      `this app is called "${name}", and there is no npm package name in it — ` +
        `slugging it leaves "${slug}", which npm will not install. ` +
        `An npm name is lowercase, at most 214 characters, and starts with a letter, a digit, "-" or "~". ` +
        `Set \`name\` in praecise.config.ts to something containing at least one of those.`,
    );
  }
  return slug;
}

export interface PackageManifest {
  name: string;
  /**
   * The same app, named the way npm needs it: what `npx` resolves and what the
   * `bin` entry is keyed on. Derived, never authored.
   */
  packageName: string;
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
    packageName: npmNameFor(app.name),
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

function packageJson(manifest: PackageManifest, framework: string, carried: string[]): string {
  return `${JSON.stringify(
    {
      name: manifest.packageName,
      version: manifest.version,
      description: manifest.description,
      type: "module",
      bin: { [manifest.packageName]: "./start.js" },
      // Importable as well as launchable: the tool list and the typed module
      // are two ways into the same app, and which one suits depends on whether
      // the caller can run code.
      main: "./api.js",
      types: "./api.d.ts",
      exports: { ".": { types: "./api.d.ts", default: "./api.js" } },
      // What was actually copied, not what an app might have had. A `files` list
      // naming something absent is harmless; one missing something present drops
      // it from the published tarball, which is how a guard would vanish twice.
      files: ["start.js", "api.js", "api.d.ts", "mcp.json", ...carried],
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

    npx ${manifest.packageName}

It speaks MCP revision ${manifest.protocolVersion}.

Or import it, if you would rather write code than read a tool list:

\`\`\`ts
import app from "${manifest.packageName}";

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

/**
 * The root file for each thing an app can have one of, whatever it was written in.
 *
 * Returned as a map so the caller can tell "there is no guard here" from "the
 * guard is called guard.mjs" — a distinction the old `.ts`-only list could not
 * make, and the reason a `.js` app shipped unguarded.
 */
async function rootFilesIn(root: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const base of CARRIED_FILES) {
    for (const ext of ROOT_EXT) {
      const name = `${base}${ext}`;
      if ((await stat(join(root, name)).catch(() => undefined))?.isFile()) {
        found.set(base, name);
        break;
      }
    }
  }
  return found;
}

/**
 * Refuse to publish an app whose controls would not travel with it.
 *
 * A `guard` decides which tool calls are actually made and `middleware` wraps
 * every call: an app that arrives without them is not a degraded copy of the
 * app, it is a different and more permissive one. Checked before anything is
 * written, so a refusal leaves no half-built package behind.
 */
function controlsTravel(app: App, roots: Map<string, string>): void {
  const declared: [string, boolean][] = [
    ["guard", Boolean(app.project.guard)],
    ["middleware", Boolean(app.project.middleware)],
  ];

  for (const [base, present] of declared) {
    if (!present || roots.has(base)) continue;
    throw new Error(
      `this app has a ${base}, and there is no ${ROOT_EXT.map((ext) => `${base}${ext}`).join(", ")} ` +
        `in ${app.root} to package with it. The package would run without it — for a guard, that is every ` +
        `tool call the app refuses today going through unasked. Package from the directory the app was ` +
        `loaded from, or take the ${base} out of the app if it was not meant to be there.`,
    );
  }
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

  const roots = await rootFilesIn(app.root);
  controlsTravel(app, roots);

  await mkdir(out, { recursive: true });

  const carried: string[] = [];
  for (const dir of CARRIED_DIRS) {
    try {
      await cp(join(app.root, dir), join(out, dir), { recursive: true });
      carried.push(dir);
    } catch (err) {
      // An app that has no `stores/` is an app, not a failure. Anything else —
      // a permission, a full disk, a broken symlink — took a folder of the app
      // out of the package, and must not pass for a folder that was never there.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        // `cause` keeps the original error reachable — the errno, the path, the stack —
        // rather than flattening it into a string that has already lost them.
        throw new Error(`could not package ${dir}/: ${(err as Error).message}`, { cause: err });
      }
    }
  }
  for (const name of roots.values()) {
    try {
      await cp(join(app.root, name), join(out, name));
      carried.push(name);
    } catch (err) {
      throw new Error(`could not package ${name}: ${(err as Error).message}`, { cause: err });
    }
  }

  const written = [
    ["package.json", packageJson(manifest, framework, carried)],
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
