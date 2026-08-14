/**
 * Blueprints and templates: the two ways an app grows without being typed out.
 *
 * A blueprint that ships files is a copy. One that only states an intent is
 * worked out by a model, so the tests that matter are the ones that check what
 * comes back is treated as untrusted: paths that leave the project, files that
 * would overwrite work, replies that are not files at all.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { App } from "../src/app.js";
import { checkFiles, deriveFiles, safePath, writeFiles } from "../src/project/install.js";
import { templates } from "../src/cli/templates.js";
import {
  MODEL_ENV,
  TEST_ENDPOINT,
  TEST_MODELS,
  cleanup,
  FRAMEWORK,
  makeProject,
  stubModel,
} from "./helpers.js";

const roots: string[] = [];

async function project(files: Record<string, string>) {
  const root = await makeProject({ ...TEST_MODELS, ...files });
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(cleanup));
});

describe("safePath", () => {
  it("keeps a path into a folder a blueprint may write", () => {
    expect(safePath("agents/helper.ts")).toBe("agents/helper.ts");
    expect(safePath("./memory/notes.md")).toBe("memory/notes.md");
  });

  it("refuses to leave the project", () => {
    expect(safePath("../secrets.ts")).toBeUndefined();
    expect(safePath("agents/../../secrets.ts")).toBeUndefined();
    expect(safePath("/etc/passwd")).toBeUndefined();
  });

  it("refuses a folder that is not part of the convention", () => {
    expect(safePath("src/index.ts")).toBeUndefined();
    expect(safePath("praecise.config.ts")).toBeUndefined();
    expect(safePath("")).toBeUndefined();
  });
});

describe("checkFiles", () => {
  it("says why it dropped a file instead of dropping it quietly", () => {
    const plan = checkFiles([
      { path: "agents/ok.ts", contents: "export default 1;" },
      { path: "../escape.ts", contents: "bad" },
      { path: "agents/empty.ts" },
    ]);
    expect(plan.files.map((file) => file.path)).toEqual(["agents/ok.ts"]);
    expect(plan.notes.join(" ")).toContain("outside the project");
    expect(plan.notes.join(" ")).toContain("no contents");
  });

  it("treats a reply that is not a list as no files at all", () => {
    expect(checkFiles({ path: "agents/a.ts" }).files).toEqual([]);
  });
});

describe("writeFiles", () => {
  it("writes into folders that do not exist yet", async () => {
    const root = await project({});
    const result = await writeFiles(root, [
      { path: "agents/new.ts", contents: "export default 1;" },
    ]);
    expect(result.written).toEqual(["agents/new.ts"]);
    expect(await readFile(resolve(root, "agents/new.ts"), "utf8")).toBe("export default 1;");
  });

  it("leaves an existing file alone unless forced", async () => {
    const root = await project({ "agents/a.ts": "mine" });

    const first = await writeFiles(root, [{ path: "agents/a.ts", contents: "theirs" }]);
    expect(first).toEqual({ written: [], skipped: ["agents/a.ts"] });
    expect(await readFile(resolve(root, "agents/a.ts"), "utf8")).toBe("mine");

    await writeFiles(root, [{ path: "agents/a.ts", contents: "theirs" }], { force: true });
    expect(await readFile(resolve(root, "agents/a.ts"), "utf8")).toBe("theirs");
  });

  it("skips a path that would escape the project", async () => {
    const root = await project({});
    const result = await writeFiles(root, [{ path: "../escaped.ts", contents: "bad" }]);
    expect(result).toEqual({ written: [], skipped: ["../escaped.ts"] });
  });
});

describe("deriveFiles", () => {
  const spec = { kind: "blueprint" as const, intent: "Add an agent that greets people." };

  it("asks with the app's description and its style examples", async () => {
    const asked: string[] = [];
    const plan = await deriveFiles(spec, {
      describes: "The app is called \"acme\".",
      examples: [{ path: "agents/support.ts", contents: "export default support;" }],
      ask: async (question) => {
        asked.push(question);
        return `[{"path":"agents/greeter.ts","contents":"export default greeter;"}]`;
      },
    });

    expect(plan.files).toEqual([
      { path: "agents/greeter.ts", contents: "export default greeter;" },
    ]);
    expect(asked[0]).toContain("acme");
    expect(asked[0]).toContain("agents/support.ts");
    expect(asked[0]).toContain("Add an agent that greets people.");
  });

  it("reads a fenced reply, because models wrap JSON in one", async () => {
    const plan = await deriveFiles(spec, {
      describes: "",
      ask: async () => '```json\n[{"path":"agents/g.ts","contents":"x"}]\n```',
    });
    expect(plan.files).toHaveLength(1);
  });

  it("says nothing usable came back rather than writing junk", async () => {
    const plan = await deriveFiles(spec, { describes: "", ask: async () => "Sure! I can help." });
    expect(plan.files).toEqual([]);
    expect(plan.notes.join(" ")).toContain("nothing usable");
  });

  it("does not ask at all when there is no intent", async () => {
    let asked = false;
    const plan = await deriveFiles(
      { kind: "blueprint" },
      {
        describes: "",
        ask: async () => {
          asked = true;
          return "[]";
        },
      },
    );
    expect(asked).toBe(false);
    expect(plan.notes.join(" ")).toContain("neither files nor an intent");
  });
});

describe("app.add", () => {
  const BASE = {
    "praecise.config.ts": `import { defineConfig } from "${FRAMEWORK}";
      export default defineConfig({ name: "acme", ${TEST_ENDPOINT} });`,
    "agents/support.ts": `import { agent } from "${FRAMEWORK}";
      export default agent({ role: "Support for Acme.", description: "Answers questions." });`,
  };

  it("copies a blueprint that ships its own files, without asking a model", async () => {
    const root = await project({
      ...BASE,
      "blueprints/notes.ts": `import { blueprint } from "${FRAMEWORK}";
        export default blueprint({ files: [{ path: "memory/notes.md", contents: "Hello." }] });`,
    });
    const stub = stubModel([]);
    const app = await App.load({ root, env: MODEL_ENV, fetch: stub.fetch });

    const result = await app.add("notes");

    expect(result.written).toEqual(["memory/notes.md"]);
    expect(stub.calls).toHaveLength(0);
  });

  it("works out a markdown blueprint against what the app already has", async () => {
    const root = await project({
      ...BASE,
      "blueprints/greeter.md": "# Greeter\n\nAdd an agent that greets new customers.\n",
    });
    const stub = stubModel([
      { text: `[{"path":"agents/greeter.ts","contents":"export default greeter;"}]` },
    ]);
    const app = await App.load({ root, env: MODEL_ENV, fetch: stub.fetch });

    const result = await app.add("greeter");

    expect(result.written).toEqual(["agents/greeter.ts"]);
    // The app described itself, so the model had parts to build from.
    const asked = JSON.stringify(stub.calls[0]?.body.messages);
    expect(asked).toContain("acme");
    expect(asked).toContain("support");
    expect(asked).toContain("greets new customers");
  });

  it("refuses a path the model made up outside the project", async () => {
    const root = await project({
      ...BASE,
      "blueprints/greeter.md": "# Greeter\n\nAdd a greeter.\n",
    });
    const stub = stubModel([
      { text: `[{"path":"../../evil.ts","contents":"bad"}]` },
    ]);
    const app = await App.load({ root, env: MODEL_ENV, fetch: stub.fetch });

    const result = await app.add("greeter");

    expect(result.written).toEqual([]);
    expect(result.notes.join(" ")).toContain("outside the project");
  });

  it("warns about a credential the blueprint needs before it will work", async () => {
    const root = await project({
      ...BASE,
      "tools/ledger.ts": `import { tool } from "${FRAMEWORK}";
        export default tool({ url: "https://ledger.internal/mcp", credential: "LEDGER_TOKEN" });`,
      "blueprints/billing.ts": `import { blueprint } from "${FRAMEWORK}";
        export default blueprint({
          needs: ["ledger"],
          files: [{ path: "memory/billing.md", contents: "x" }],
        });`,
    });
    const app = await App.load({ root, env: MODEL_ENV, fetch: stubModel([]).fetch });

    const result = await app.add("billing");

    expect(result.written).toEqual(["memory/billing.md"]);
    expect(result.notes.join(" ")).toContain("ledger");
  });

  it("refuses a name it does not know", async () => {
    const root = await project(BASE);
    const app = await App.load({ root, env: MODEL_ENV, fetch: stubModel([]).fetch });
    await expect(app.add("ghost")).rejects.toThrow(/no blueprint named/);
  });
});

describe("templates", () => {
  it("gives every template the base scaffold and a name", () => {
    // Asked for TypeScript explicitly: the DEFAULT extension now follows what the
    // runtime can import, which `tests/scaffold.test.ts` covers. This test is about the
    // structure of a template, so it pins the language rather than depending on the host.
    for (const spec of templates("acme", "ts")) {
      expect(spec.name).toBeTruthy();
      expect(spec.description).toBeTruthy();
      const paths = spec.files!.map((file) => file.path);
      // No config file: a template is a folder of conventions, nothing else.
      expect(paths).toContain("package.json");
      expect(paths).toContain("agents/assistant.ts");
      expect(new Set(paths).size).toBe(paths.length);
    }
  });

  it("loads as a real project, whichever one is picked", async () => {
    for (const spec of templates("acme", "ts")) {
      const files = Object.fromEntries(
        spec.files!.map((file) => [
          file.path,
          // The scaffold imports "praecise" by name, which a temp dir cannot
          // resolve, so it is pointed at the source for the test.
          file.contents.replace(/from "praecise"/g, `from "${FRAMEWORK}"`),
        ]),
      );
      const root = await project(files);
      const app = await App.load({ root, env: MODEL_ENV, fetch: stubModel([]).fetch });
      expect(app.problems).toEqual([]);
      expect(app.agentNames.length + app.workflowNames.length).toBeGreaterThan(0);
    }
  });
});
