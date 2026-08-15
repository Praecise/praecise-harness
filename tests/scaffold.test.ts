/**
 * What `praecise init` writes, and the one property that decides whether a new app runs.
 *
 * The folder loader imports source files AT RUNTIME. So the extension the scaffold picks
 * is not a style preference — it decides whether step one of the documented path produces
 * an app that starts. It used to write `.ts` unconditionally, which meant a fresh app on
 * a Node without type stripping did not load at all, and the first thing a new user saw
 * was their own scaffolded file failing to import.
 */
import { describe, expect, it } from "vitest";

import { runtimeReadsTypeScript, scaffold } from "../src/cli/scaffold.js";
import { templates } from "../src/cli/templates.js";
import { PIECES, pieceNamed } from "../src/cli/pieces.js";
import { App } from "../src/app.js";
import { makeProject, cleanup } from "./helpers.js";

const codeFiles = (files: { path: string }[]) =>
  files.map((file) => file.path).filter((path) => /\.(ts|js)$/.test(path));

describe("the scaffold writes what the runtime can run", () => {
  it("asks the runtime rather than guessing from a version number", () => {
    // A Node built without the feature reports honestly, while its version number would
    // have said yes — which is exactly the case that produced the broken first run.
    expect(typeof runtimeReadsTypeScript()).toBe("boolean");
    expect(runtimeReadsTypeScript()).toBe(Boolean(process.features?.typescript));
  });

  it("defaults to TypeScript, because the framework builds it now", () => {
    // It briefly defaulted to whatever the runtime could import, which was a workaround
    // for not having a build step. With one, the documented language is the default and
    // the runtime's own capabilities stop being the author's problem.
    for (const path of codeFiles(scaffold("acme"))) {
      expect(path.endsWith(".ts")).toBe(true);
    }
  });

  it("provisions the compiler it will need", () => {
    // praecise resolves TypeScript from the APP, so a scaffolded app has to bring one.
    // Without this the first `npm install` produces a project that cannot build itself.
    const pkg = scaffold("acme").find((file) => file.path === "package.json");
    const parsed = JSON.parse(pkg!.contents) as { devDependencies?: Record<string, string> };
    expect(parsed.devDependencies?.typescript).toBeTruthy();
  });

  it("asks for no compiler when there is nothing to compile", () => {
    const pkg = scaffold("acme", "js").find((file) => file.path === "package.json");
    const parsed = JSON.parse(pkg!.contents) as { devDependencies?: Record<string, string> };
    expect(parsed.devDependencies).toBeUndefined();
  });

  it("honours an explicit choice, because the author may know better", () => {
    // Authoring in TypeScript and compiling before running is legitimate; the default
    // is for the person who has not decided yet.
    expect(codeFiles(scaffold("acme", "ts")).every((p) => p.endsWith(".ts"))).toBe(true);
    expect(codeFiles(scaffold("acme", "js")).every((p) => p.endsWith(".js"))).toBe(true);
  });

  it("applies the same rule to every template, not only the bare scaffold", () => {
    // A template that scaffolds an app which does not start is a worse first impression
    // than no template at all.
    for (const template of templates("acme", "js")) {
      for (const path of codeFiles(template.files)) expect(path.endsWith(".js")).toBe(true);
    }
  });

  it("does not leave one file behind in the other language", () => {
    // The failure this guards: a scaffold that switched its agent and forgot its
    // functions, giving an app that half-loads and reports a problem for the rest.
    for (const template of templates("acme", "js")) {
      const extensions = new Set(codeFiles(template.files).map((path) => path.slice(path.lastIndexOf("."))));
      expect([...extensions]).toEqual([".js"]);
    }
  });
});

describe("a freshly scaffolded app loads", () => {
  it("produces an app the loader reads without a single problem", async () => {
    // The end-to-end claim, and the only one that matters: `init` then `list` works.
    // `praecise` is rewritten to a path here because the scaffold names the published
    // package, which a test tree does not have installed.
    const framework = new URL("../src/index.ts", import.meta.url).href;
    const files: Record<string, string> = {};
    for (const file of scaffold("acme", "ts")) {
      files[file.path] = file.contents.replace(/from "praecise"/g, `from "${framework}"`);
    }
    // The scaffolded package.json is not part of what the loader reads.
    delete files["package.json"];

    const root = await makeProject(files);
    try {
      const app = await App.load({ root, env: {} });
      expect(app.agentNames).toEqual(["assistant"]);

      // The ONLY thing a fresh app is missing is the key its own `.env` asks for.
      // Nothing failed to load, nothing failed to parse — which is the whole claim.
      // Pinned as an exact set rather than a "no errors" check, so a new problem
      // appearing in a scaffolded app cannot hide behind a loose assertion.
      expect(app.problems).toHaveLength(1);
      expect(app.problems[0]).toContain("no model endpoint configured");
    } finally {
      await cleanup(root);
    }
  });
});

describe("the pieces `add` can write", () => {
  it("offers something for every folder the conventions define", () => {
    // `init` gives you an agent. If `add` cannot write the rest, the second command
    // anybody runs is a dead end — which is what it was.
    const names = PIECES.map((piece) => piece.name);
    expect(names).toEqual(
      expect.arrayContaining(["function", "tool", "store", "workflow", "guard", "memory", "prompt"]),
    );
  });

  it("puts each one where the loader looks for it", () => {
    // The folder IS the wiring, so a piece written to the wrong one is invisible.
    expect(pieceNamed("function")!.path("lookup")).toBe("functions/lookup.ts");
    expect(pieceNamed("store")!.path("catalogue")).toBe("stores/catalogue.ts");
    expect(pieceNamed("memory")!.path("policy")).toBe("memory/policy.md");
    // The guard is one per app, so its name is not the author's to choose.
    expect(pieceNamed("guard")!.path("anything")).toBe("guard.ts");
  });

  it("writes an app that loads with every piece in it", async () => {
    // A piece that does not load is worse than no piece: it is a file the author now
    // has to debug before they have written anything of their own.
    const framework = new URL("../src/index.ts", import.meta.url).href;
    const files: Record<string, string> = {};

    for (const file of scaffold("acme", "ts")) {
      files[file.path] = file.contents.replace(/from "praecise"/g, `from "${framework}"`);
    }
    delete files["package.json"];

    for (const piece of PIECES) {
      const name = piece.name === "guard" ? "guard" : `my${piece.name}`;
      files[piece.path(name)] = piece.contents(name, framework);
    }

    const root = await makeProject(files);
    try {
      const app = await App.load({ root, env: {} });
      // The only complaint is the key the scaffold's own `.env` asks for.
      expect(app.problems.filter((problem) => !problem.includes("no model endpoint"))).toEqual([]);
      expect(app.agentNames).toContain("assistant");
      expect(app.workflowNames).toContain("myworkflow");
    } finally {
      await cleanup(root);
    }
  });

  it("says what to do next, for the pieces that need wiring", () => {
    // A function is invisible until an agent lists it; a guard applies immediately.
    // Saying which is which is the difference between a file and a working app.
    expect(pieceNamed("function")!.next).toMatch(/tools/);
    expect(pieceNamed("guard")!.next).toMatch(/nothing to wire/);
    expect(pieceNamed("memory")!.next).toMatch(/nothing to wire/);
  });
});
