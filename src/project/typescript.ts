/**
 * TypeScript, made to just work — which for a framework means owning a build step rather
 * than hoping the runtime has one.
 *
 * Every example in the documentation is a `.ts` file, and the folder loader imports source
 * files at RUNTIME. That combination only works on a Node that can strip types itself,
 * which is not all of them: the feature arrived in 22.6, became default in 23.6, and is
 * absent entirely from builds compiled without it, which some distributions ship. So a
 * freshly scaffolded app failed to load its own generated agent, and the framework's
 * answer was an error message. An error message is not an answer.
 *
 * The fix is the one every comparable framework already made. Next.js does not strip types
 * at runtime; it compiles, and the author never thinks about it. This compiles too.
 *
 * ── How ───────────────────────────────────────────────────────────────────────
 *
 * Before anything is imported, every `.ts` and `.mts` file under the project is transpiled
 * into `.praecise/build/`, keeping its relative path, and the loader imports from there.
 * Transpiling is type ERASURE plus a module transform — no type checking, no bundling —
 * which is why it takes milliseconds and why it cannot fail on a type error. Checking
 * types is `tsc --noEmit`'s job and belongs in the editor and CI, not between a keystroke
 * and a reload.
 *
 * ── Where the compiler comes from ─────────────────────────────────────────────
 *
 * From the PROJECT, not from here. Praecise has no runtime dependencies and this does not
 * add one: `typescript` is resolved out of the app's own `node_modules`, which any
 * TypeScript project already has, and which `praecise init` now puts there. If a project
 * has `.ts` files and no compiler, that is a missing devDependency and the error says so
 * in one line.
 *
 * The order of preference matters and is deliberate:
 *
 *   1. The runtime, when it strips types natively. Nothing to build, nothing to cache,
 *      no compiler needed — the fastest path is doing nothing.
 *   2. The project's `typescript`.
 *   3. A named error telling the author exactly what to install.
 *
 * ── Why the cache is keyed on content ─────────────────────────────────────────
 *
 * On modification time, a file edited twice within the filesystem's timestamp resolution
 * serves a stale build — which during a hot-reload loop is a change that silently does not
 * take, and the author debugs code that is not running. Hashing the source costs a
 * millisecond and removes the whole class.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdir, readFile, readdir, writeFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Where builds go. Inside the project, so it is gitignored and disposable. */
export const BUILD_DIR = join(".praecise", "build");

/** Extensions that need compiling, and what they become. */
const TS_EXT = [".ts", ".mts"];

/** Never walked: a build output, a dependency tree, or version control. */
const SKIP = new Set(["node_modules", ".praecise", ".git", "dist", "build"]);

/** Whether the current runtime can import TypeScript without help. */
export function runtimeStripsTypes(): boolean {
  return Boolean((process.features as { typescript?: unknown } | undefined)?.typescript);
}

/** Every `.ts`/`.mts` file under a directory, as paths relative to it. */
export async function typeScriptFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".praecise") {
        if (SKIP.has(entry.name)) continue;
      }
      if (SKIP.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (TS_EXT.some((ext) => entry.name.endsWith(ext)) && !entry.name.endsWith(".d.ts")) {
        found.push(relative(root, full));
      }
    }
  };
  await walk(root);
  return found.sort();
}

/**
 * The project's own TypeScript, or nothing.
 *
 * Resolved from the app's directory rather than from this package, so the version an
 * author chose is the version their code is compiled with — and so praecise itself stays
 * free of the dependency.
 */
/**
 * Some files built and some did not.
 *
 * Carried as its own error so the loader can report the broken files while keeping
 * everything that compiled — the difference between "one file is wrong" and "the app is
 * gone", which during an edit is the difference between a usable dev server and a
 * useless one.
 */
export class PartialBuild extends Error {
  constructor(
    readonly broken: string[],
    /**
     * The files that actually compiled, by path.
     *
     * A LIST rather than a count, and that distinction was a bug: `tsc` writes a partial
     * output file even for a source it then fails on, so "was something written?" is not
     * the same question as "did this compile?". Stamping on the former marked a broken
     * file as cached, and its error vanished from every subsequent build — the file stayed
     * broken and stopped being reported.
     */
    readonly good: string[],
  ) {
    super(broken.join("\n"));
  }

  /** How many compiled. */
  get built(): number {
    return this.good.length;
  }
}

/** The first compiler diagnostic in a run of output — the one that caused the rest. */
function firstError(output: string): string {
  const line = output.split("\n").find((text) => /error TS\d+/.test(text));
  return (line ?? output.split("\n")[0] ?? "failed to compile").trim();
}

export interface Compiler {
  /** How it works, for the record and for diagnostics. */
  readonly kind: "api" | "tsc";
  /** Compile the whole project's TypeScript into `outDir`. Returns files written. */
  build(root: string, sources: string[], outDir: string): Promise<number>;
}

/**
 * The project's compiler, in the order worth preferring.
 *
 * TypeScript 7 — the native port, and the current release — deliberately does NOT expose
 * `transpileModule` from its package root. It ships `version` and a set of `unstable/*`
 * entry points, and its actual compiler is the `tsc` binary. A build step written against
 * the old in-process API therefore finds no compiler on the version most projects are
 * about to be on, and tells the author to install the thing they already installed.
 *
 * So there are two strategies and both are real:
 *
 *   `api`  TypeScript 6 and earlier: `ts.transpileModule` per file, in process. No
 *          subprocess, no temp files, fastest for a hot reload.
 *   `tsc`  TypeScript 7 and anything else with a `tsc`: one subprocess for the whole
 *          project with `--noCheck`, which emits without type checking. Slower to start
 *          and correct on every version, including the ones that have not shipped yet.
 *
 * `--noCheck` is the load-bearing flag. Type checking is `tsc --noEmit`'s job, in the
 * editor and in CI; a type error must never be the reason a dev server will not start,
 * because the whole point of a dev server is to run the code you are in the middle of
 * writing.
 */
export function compilerFrom(root: string): Compiler | undefined {
  const project = resolve(root);

  // ── Strategy 1: the in-process API, where it exists ──────────────────────
  try {
    const require = createRequire(join(project, "noop.js"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ts = require("typescript") as any;
    if (typeof ts?.transpileModule === "function") {
      return {
        kind: "api",
        async build(from: string, sources: string[], outDir: string): Promise<number> {
          let written = 0;
          for (const relPath of sources) {
            const source = await readFile(join(from, relPath), "utf8");
            const out = ts.transpileModule(source, {
              fileName: join(from, relPath),
              compilerOptions: {
                target: ts.ScriptTarget?.ES2022 ?? 9,
                module: ts.ModuleKind?.ESNext ?? 99,
                moduleResolution: ts.ModuleResolutionKind?.Bundler ?? 100,
                isolatedModules: true,
                inlineSourceMap: true,
                inlineSources: true,
              },
            });
            const target = join(outDir, outputFor(relPath));
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, rewriteSpecifiers(String(out.outputText ?? "")), "utf8");
            written += 1;
          }
          return written;
        },
      };
    }
  } catch {
    // Not installed, or not loadable. The next strategy may still work.
  }

  // ── Strategy 2: the project's own `tsc` ──────────────────────────────────
  const binary = tscFrom(project);
  if (!binary) return undefined;

  return {
    kind: "tsc",
    async build(from: string, sources: string[], outDir: string): Promise<number> {
      await mkdir(outDir, { recursive: true });

      const run = (files: string[]): Promise<string | undefined> =>
        new Promise((done) => {
          const child = spawn(
            binary,
            [
              "--noCheck",
              // Any TypeScript project has a `tsconfig.json`, and TypeScript 7 refuses to
              // combine one with files named on the command line (TS5112). Ignoring it is
              // also the more predictable choice: this emit is fully described by the flags
              // below, so what praecise builds does not shift with an editor setting.
              //
              // The cost is real and worth naming: `paths` aliases, `jsx`, and
              // `experimentalDecorators` from a project's config do not apply here. An app
              // that needs them should compile itself and point praecise at the output.
              "--ignoreConfig",
              "--outDir",
              outDir,
              "--rootDir",
              from,
              "--module",
              "esnext",
              "--target",
              "es2022",
              "--moduleResolution",
              "bundler",
              "--inlineSourceMap",
              "--inlineSources",
              ...files.map((relPath) => join(from, relPath)),
            ],
            { cwd: from, shell: false, stdio: ["ignore", "pipe", "pipe"] },
          );
          let said = "";
          child.stdout.on("data", (chunk: Buffer) => (said += chunk.toString()));
          child.stderr.on("data", (chunk: Buffer) => (said += chunk.toString()));
          child.on("error", (err: Error) => done(`could not run ${binary}: ${err.message}`));
          // `--noCheck` means a non-zero exit is a real emit failure — a syntax error, an
          // unwritable directory — not somebody's type not lining up.
          child.on("exit", (code) => done(code === 0 ? undefined : said.trim()));
        });

      /** Point relative `.ts` specifiers at what was actually written. */
      const settle = async (files: string[]): Promise<void> => {
        for (const relPath of files) {
          const target = join(outDir, outputFor(relPath));
          const emitted = await readFile(target, "utf8").catch(() => undefined);
          if (emitted === undefined) continue;
          await writeFile(target, rewriteSpecifiers(emitted), "utf8");
        }
      };

      const batch = await run(sources);
      if (!batch) {
        await settle(sources);
        return sources.length;
      }

      // ── One broken file must not empty the whole app ──────────────────────
      //
      // `tsc` compiles the batch in one process and emits NOTHING when any file in it
      // fails. Mid-edit that is catastrophic for a dev loop: a half-typed function takes
      // out every agent in the project, and the healthy files then report "could not be
      // loaded" — which is not even true of them.
      //
      // So a failed batch is retried file by file. The good ones build and keep working;
      // only the genuinely broken one is reported, with its own compiler error. The extra
      // pass costs something exactly when something is already wrong, and nothing at all
      // when things are fine.
      const broken: string[] = [];
      const good: string[] = [];
      for (const relPath of sources) {
        const failed = await run([relPath]);
        if (failed) broken.push(`${relPath}: ${firstError(failed)}`);
        else good.push(relPath);
      }
      await settle(good);
      if (broken.length) throw new PartialBuild(broken, good);
      return good.length;
    },
  };
}

/**
 * The project's `tsc`, walking up as Node's own resolution does.
 *
 * Checking only `<project>/node_modules` would be wrong wherever dependencies are
 * hoisted — a monorepo, a workspace, a pnpm layout — which is a large share of real
 * projects and every one of them would be told to install a compiler that is already
 * there, one directory up.
 *
 * Never a global `tsc`. A build that depends on what happens to be on someone's PATH
 * produces different output on two machines from identical source, and the difference is
 * invisible until it matters.
 */
function tscFrom(project: string): string | undefined {
  let dir = project;
  for (;;) {
    for (const candidate of [
      join(dir, "node_modules", ".bin", "tsc"),
      join(dir, "node_modules", "typescript", "bin", "tsc"),
    ]) {
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Rewrite relative specifiers that name a `.ts` file.
 *
 * An author who writes `./util.ts` is naming a file that will not exist beside the built
 * output. Everything else is left exactly as written — a bare specifier still resolves
 * through `node_modules`, which the build directory can still see, because Node walks
 * upward and `.praecise/build` is inside the project.
 */
export function rewriteSpecifiers(code: string): string {
  return code.replace(
    /(\bfrom\s*|\bimport\s*\(\s*)(["'])(\.\.?\/[^"']*?)\.m?ts\2/g,
    (_all, lead: string, quote: string, path: string) => `${lead}${quote}${path}.js${quote}`,
  );
}

/** What one file compiles to, and where it goes. */
const outputFor = (relPath: string): string => relPath.replace(/\.mts$/, ".mjs").replace(/\.ts$/, ".js");

export interface BuildResult {
  /** Where to load the app from: the build directory, or the project itself. */
  root: string;
  /** How many files were compiled. Zero means nothing needed it. */
  compiled: number;
  /** Files served from cache rather than recompiled. */
  cached: number;
  /** Why nothing was built, when nothing was. */
  reason?: string;
  /** Which strategy compiled it: the in-process API, or the project's `tsc`. */
  how?: "api" | "tsc";
}

/**
 * Compile a project's TypeScript, if it has any and the runtime needs it compiled.
 *
 * Returns the directory to load from. When there is nothing to do — a JavaScript app, or
 * a runtime that reads TypeScript natively — that is the project itself and not one byte
 * is written.
 */
export async function buildTypeScript(root: string): Promise<BuildResult> {
  const project = resolve(root);

  if (runtimeStripsTypes()) {
    return { root: project, compiled: 0, cached: 0, reason: "the runtime reads TypeScript natively" };
  }

  const sources = await typeScriptFiles(project);
  if (!sources.length) {
    return { root: project, compiled: 0, cached: 0, reason: "no TypeScript in this app" };
  }

  const compiler = compilerFrom(project);
  if (!compiler) {
    // Not an error, and this took a regression to learn. `process.features.typescript`
    // answers "can NODE strip types", which is not the same question as "can this app be
    // imported": a test runner, `tsx`, or any loader hook can import TypeScript on a Node
    // that reports `false`. Throwing here broke every one of those, in environments where
    // nothing was wrong.
    //
    // So a missing compiler means "do not build", not "cannot run". The import is then
    // attempted directly, and if the runtime genuinely cannot read the file, that failure
    // is reported per-file with the remedy attached — which is both more accurate and
    // more specific than a guess made before anything was tried.
    return { root: project, compiled: 0, cached: 0, reason: "no compiler; importing directly" };
  }

  const outDir = join(project, BUILD_DIR);

  // Which files actually need rebuilding. Keyed on CONTENT, not modification time: two
  // edits inside one filesystem timestamp tick would otherwise serve a stale build, the
  // change silently would not take, and the author would debug code that is not running.
  const stale: string[] = [];
  const digests = new Map<string, string>();
  let cached = 0;

  for (const relPath of sources) {
    const source = await readFile(join(project, relPath), "utf8");
    const digest = createHash("sha256").update(source).digest("hex").slice(0, 16);
    digests.set(relPath, digest);

    const target = join(outDir, outputFor(relPath));
    const previous = await readFile(`${target}.hash`, "utf8").catch(() => "");
    if (previous === digest && (await stat(target).catch(() => undefined))) {
      cached += 1;
      continue;
    }
    stale.push(relPath);
  }

  if (!stale.length) return { root: outDir, compiled: 0, cached, how: compiler.kind };

  let compiled = 0;
  try {
    compiled = await compiler.build(project, stale, outDir);
  } catch (err) {
    // A partial build is the normal state of an app being edited. Stamp what DID build so
    // it is served from cache next time, then report only what did not — the loader keeps
    // every working agent and names the one file that is broken.
    if (err instanceof PartialBuild) {
      // Stamp only what COMPILED. A file that failed keeps no stamp, so it is rebuilt and
      // re-reported on every load until it is fixed — which is the only behaviour that
      // does not quietly lose an error.
      for (const relPath of err.good) {
        await writeFile(`${join(outDir, outputFor(relPath))}.hash`, digests.get(relPath) ?? "", "utf8");
      }
      throw err;
    }
    throw err;
  }

  for (const relPath of stale) {
    await writeFile(`${join(outDir, outputFor(relPath))}.hash`, digests.get(relPath) ?? "", "utf8");
  }

  return { root: outDir, compiled, cached, how: compiler.kind };
}

/**
 * An importer that loads a project's modules, compiling TypeScript when it must.
 *
 * This is the whole integration: `loadProject` already takes an `Importer`, so handing it
 * one that knows about the build directory makes every entry point — `dev`, `run`, `list`,
 * `mcp`, `package`, and `App.load` — work with TypeScript at once, with no entry point
 * having to know that TypeScript exists.
 */
export function importerFor(projectRoot: string, buildRoot: string, version?: string | number) {
  const project = resolve(projectRoot);
  const build = resolve(buildRoot);

  return async (fileUrl: string): Promise<Record<string, unknown>> => {
    let url = fileUrl;
    if (build !== project) {
      const bare = fileUrl.split("?")[0] ?? fileUrl;
      const path = decodeURIComponent(new URL(bare).pathname);
      if (TS_EXT.some((ext) => path.endsWith(ext))) {
        const built = join(build, outputFor(relative(project, path)));
        url = pathToFileURL(built).href;
        // Cache-busting is preserved: a hot reload must not be handed the module it was
        // reloading away from.
        if (version !== undefined) url += `?v=${version}`;
      }
    }
    return (await import(url)) as Record<string, unknown>;
  };
}
