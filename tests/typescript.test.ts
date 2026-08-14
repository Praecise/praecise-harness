/**
 * The build step, which is what makes a TypeScript app just work.
 *
 * The framework's own suite runs under vitest, which transpiles everything before a test
 * ever sees it — so the suite is exactly the environment in which this feature is
 * invisible and its absence undetectable. That is how the original bug survived: every
 * test passed on a machine where the thing being tested was already handled by something
 * else.
 *
 * So these tests exercise the compiler and the importer DIRECTLY, on real files, rather
 * than by loading a project and hoping the right path was taken.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BUILD_DIR,
  buildTypeScript,
  compilerFrom,
  rewriteSpecifiers,
  runtimeStripsTypes,
  typeScriptFiles,
} from "../src/project/typescript.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * A project INSIDE this package, not in the system temp directory.
 *
 * The compiler is resolved by walking up from the app, exactly as Node resolves a
 * dependency. A project under `/tmp` has nothing above it and correctly finds none —
 * which is a case worth testing on purpose (see the last test) and useless as a default.
 */
async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(process.cwd(), ".tmp-ts-"));
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, contents, "utf8");
  }
  roots.push(root);
  return root;
}

/** This package has TypeScript, so a project nested under it resolves the same one. */
const HAS_COMPILER = Boolean(compilerFrom(process.cwd()));

describe("finding what needs building", () => {
  it("finds TypeScript anywhere in the app, at any depth", async () => {
    const root = await project({
      "agents/support.ts": "export default 1;",
      "functions/nested/deep/thing.mts": "export default 2;",
      "workflows/handle.js": "export default 3;",
    });
    const found = await typeScriptFiles(root);
    expect(found).toContain(join("agents", "support.ts"));
    expect(found).toContain(join("functions", "nested", "deep", "thing.mts"));
    expect(found).not.toContain(join("workflows", "handle.js"));
  });

  it("never walks into node_modules or its own output", async () => {
    // Compiling a dependency tree would be slow, wrong, and would fight whatever built
    // that dependency. Compiling its own output would loop.
    const root = await project({
      "agents/support.ts": "export default 1;",
      "node_modules/some-dep/index.ts": "export default 2;",
      [`${BUILD_DIR}/agents/support.js`]: "export default 3;",
    });
    const found = await typeScriptFiles(root);
    expect(found).toEqual([join("agents", "support.ts")]);
  });

  it("ignores declaration files, which emit nothing", async () => {
    const root = await project({ "types/global.d.ts": "declare const x: number;" });
    expect(await typeScriptFiles(root)).toEqual([]);
  });
});

describe("what the emitted code has to get right", () => {
  it("rewrites a relative .ts specifier, because that file will not be there", () => {
    // An author who writes `./util.ts` names a source file. Beside the build output there
    // is only `./util.js`.
    expect(rewriteSpecifiers(`import { x } from "./util.ts";`)).toBe(`import { x } from "./util.js";`);
    expect(rewriteSpecifiers(`import { x } from "../lib/util.mts";`)).toBe(`import { x } from "../lib/util.js";`);
    expect(rewriteSpecifiers(`const m = await import("./late.ts");`)).toBe(`const m = await import("./late.js");`);
  });

  it("leaves bare specifiers exactly as written", () => {
    // `praecise` still has to resolve through node_modules, which the build directory can
    // still see because Node walks upward and the directory is inside the project.
    const code = `import { agent } from "praecise";\nimport ts from "typescript";`;
    expect(rewriteSpecifiers(code)).toBe(code);
  });

  it("does not touch a .ts that is part of a package name", () => {
    const code = `import x from "some.ts-package";`;
    expect(rewriteSpecifiers(code)).toBe(code);
  });
});

describe("building", () => {
  it("writes nothing for an app with no TypeScript", async () => {
    const root = await project({ "agents/support.js": "export default 1;" });
    const built = await buildTypeScript(root);
    expect(built.compiled).toBe(0);
    expect(built.root).toBe(root);
    await expect(readFile(join(root, BUILD_DIR, "agents", "support.js"), "utf8")).rejects.toThrow();
  });

  it.skipIf(!HAS_COMPILER)("compiles TypeScript into the build directory", async () => {
    const root = await project({
      "agents/support.ts": `const role: string = "Help.";\nexport default { role };`,
    });
    const built = await buildTypeScript(root);

    if (runtimeStripsTypes()) {
      // On a runtime that reads TypeScript, the fastest path is doing nothing at all.
      expect(built.compiled).toBe(0);
      expect(built.root).toBe(root);
      return;
    }

    expect(built.compiled).toBe(1);
    const output = await readFile(join(root, BUILD_DIR, "agents", "support.js"), "utf8");
    expect(output).toContain("Help.");
    // The annotation is gone; the value survives.
    expect(output).not.toMatch(/const role:\s*string/);
  });

  it.skipIf(!HAS_COMPILER || runtimeStripsTypes())(
    "emits syntax the runtime's own stripper refuses outright",
    async () => {
      // Enums and parameter properties are not erasable — they have runtime meaning — so
      // Node's stripper rejects them. This is the concrete advantage of owning a real
      // compiler rather than depending on the runtime having one.
      const root = await project({
        "functions/score.ts": `enum Band { Low = "low", High = "high" }
class Scorer { constructor(private readonly limit: number) {} band(v: number) { return v >= this.limit ? Band.High : Band.Low; } }
export default new Scorer(10).band(20);`,
      });
      await buildTypeScript(root);
      const output = await readFile(join(root, BUILD_DIR, "functions", "score.js"), "utf8");
      expect(output).toContain("Band");
      expect(output).toContain("this.limit");
    },
  );

  it.skipIf(!HAS_COMPILER || runtimeStripsTypes())("serves an unchanged file from cache", async () => {
    const root = await project({ "agents/support.ts": `export default { role: "Help." };` });
    expect((await buildTypeScript(root)).compiled).toBe(1);

    const again = await buildTypeScript(root);
    expect(again.compiled).toBe(0);
    expect(again.cached).toBe(1);
  });

  it.skipIf(!HAS_COMPILER || runtimeStripsTypes())("rebuilds on content, not on timestamp", async () => {
    // The failure this prevents: two edits inside one filesystem timestamp tick serve a
    // stale build, the change silently does not take, and the author debugs code that is
    // not running.
    const root = await project({ "agents/support.ts": `export default { role: "First." };` });
    await buildTypeScript(root);

    // Written back with a timestamp that may well be identical.
    await writeFile(join(root, "agents", "support.ts"), `export default { role: "Second." };`, "utf8");
    const again = await buildTypeScript(root);

    expect(again.compiled).toBe(1);
    expect(await readFile(join(root, BUILD_DIR, "agents", "support.js"), "utf8")).toContain("Second.");
  });

  it.skipIf(runtimeStripsTypes())("does not build when there is no compiler, and says so", async () => {
    // A regression taught this. `process.features.typescript` answers "can NODE strip
    // types", which is NOT "can this app be imported" — a test runner or a loader hook
    // imports TypeScript perfectly well on a Node that reports false. Refusing here broke
    // every such environment, where nothing was wrong.
    //
    // So a missing compiler means "do not build". Whether the file can actually be
    // imported is then decided by trying, and reported per file with the remedy attached.
    const root = await mkdtemp(join(tmpdir(), "praecise-bare-"));
    roots.push(root);
    await mkdir(join(root, "agents"), { recursive: true });
    await writeFile(join(root, "agents", "support.ts"), "export default 1;", "utf8");
    await writeFile(join(root, "package.json"), `{"name":"bare","type":"module"}`, "utf8");

    const built = await buildTypeScript(root);
    expect(built.compiled).toBe(0);
    // Load from the project itself, so a runtime that CAN import TypeScript still does.
    expect(built.root).toBe(root);
    expect(built.reason).toContain("no compiler");
  });
});
