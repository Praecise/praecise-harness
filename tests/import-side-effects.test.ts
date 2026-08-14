/**
 * Importing a framework must do nothing.
 *
 * `import "praecise"` should not print, not touch the filesystem, not bind a port, and
 * not load an experimental runtime module. A library that acts on import is spending the
 * consumer's process on a decision they have not made yet, and the cost lands on people
 * who may not even use the feature responsible.
 *
 * This was not hypothetical. `src/stores/sqlite.ts` imported `node:sqlite` at module
 * scope, the stores barrel imported that driver eagerly to build its scheme table, and the
 * package root re-exports the barrel — so every consumer got
 *
 *     ExperimentalWarning: SQLite is an experimental feature and might change at any time
 *
 * on stderr merely for importing the package, including consumers using Postgres and
 * consumers using no store at all. Found by installing the packed tarball into an empty
 * project and importing it, which is the only test that sees what a user sees.
 *
 * The check is a STATIC walk of the import graph rather than a runtime probe, for one
 * reason: a runtime probe needs `dist/`, and a test that quietly skips when the build is
 * missing is the same silently-green failure this suite exists to refuse.
 */
import { describe, expect, test } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

/** Modules that must never be reachable by a STATIC import from the package root. */
const FORBIDDEN_AT_IMPORT: Record<string, string> = {
  "node:sqlite": "experimental — prints a warning to every consumer's stderr on import",
  "node:test": "a test runner has no business in a shipped import graph",
};

/**
 * Static `import ... from "x"` / `export ... from "x"` specifiers that SURVIVE COMPILATION.
 *
 * Two exclusions, both of which the first draft of this test got wrong:
 *   · `import type { … }` is erased by the compiler and emits nothing, so a type-only
 *     reference to an experimental module is free. Flagging it would push an author toward
 *     losing their types for no runtime benefit.
 *   · Dynamic `import("x")` is the fix, not the bug — deferring a load is the whole point.
 */
function staticSpecifiers(source: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\n)\s*(?:import|export)\s+(?!type\s)[^;\n]*?from\s*["']([^"']+)["']/g;
  const bare = /(?:^|\n)\s*import\s*["']([^"']+)["']/g;      // side-effect import
  for (const m of source.matchAll(re)) if (m[1]) out.push(m[1]);
  for (const m of source.matchAll(bare)) if (m[1]) out.push(m[1]);
  return out;
}

/** Everything statically reachable from an entry file, following relative imports. */
function importGraph(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const walk = (file: string) => {
    if (seen.has(file) || !existsSync(file)) return;
    const source = readFileSync(file, "utf8");
    const specs = staticSpecifiers(source);
    seen.set(file, specs);
    for (const spec of specs) {
      if (!spec.startsWith(".")) continue;
      // TS sources import each other with a .js extension
      const base = resolve(dirname(file), spec).replace(/\.js$/, "");
      for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
        if (existsSync(candidate)) { walk(candidate); break; }
      }
    }
  };
  walk(entry);
  return seen;
}

describe("importing the package is free of side effects", () => {
  const graph = importGraph(resolve(SRC, "index.ts"));

  test("the graph was actually walked (a vacuous pass would prove nothing)", () => {
    expect(graph.size).toBeGreaterThan(10);
    expect([...graph.keys()].some((f) => f.endsWith("index.ts"))).toBe(true);
  });

  for (const [mod, why] of Object.entries(FORBIDDEN_AT_IMPORT)) {
    test(`no module statically imports ${mod} (${why})`, () => {
      const offenders = [...graph.entries()]
        .filter(([, specs]) => specs.includes(mod))
        .map(([file]) => file.slice(SRC.length + 1));
      expect(offenders, `${mod} must be loaded lazily, inside the function that needs it`).toEqual([]);
    });
  }

  test("the sqlite driver is still reachable — deferring the load must not remove the feature", () => {
    const sqlite = resolve(SRC, "stores/sqlite.ts");
    expect(existsSync(sqlite)).toBe(true);
    const source = readFileSync(sqlite, "utf8");
    // it loads it — just not at module scope
    expect(source).toMatch(/import\(["']node:sqlite["']\)/);
    expect(source).toMatch(/import type \{ DatabaseSync \}/);
  });

  test("no module in the graph blocks on a top-level await", () => {
    // Two corrections this check needed, both from its own false positives:
    //   · only a COLUMN-ZERO await is top-level — the first draft matched indented awaits
    //     inside async functions and accused 25 innocent files, which is how a test earns
    //     a permanent `.skip` rather than a fix;
    //   · template literals must be stripped first — `package/build.ts` EMITS a program
    //     containing `await server.done` as a string, and generated code is not code this
    //     module runs.
    // It stays a heuristic lint rather than a parse, and says so.
    const withoutTemplates = (s: string) => s.replace(/`(?:\\[\s\S]|[^`\\])*`/g, "``");
    const blocking: string[] = [];
    for (const file of graph.keys()) {
      if (/^await\s+\S/m.test(withoutTemplates(readFileSync(file, "utf8")))) {
        blocking.push(file.slice(SRC.length + 1));
      }
    }
    expect(blocking, "a top-level await makes importing the package wait on work the consumer did not ask for").toEqual([]);
  });
});
