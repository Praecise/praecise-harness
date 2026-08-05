/**
 * An app built from a project handed over, rather than one read from a folder.
 *
 * A folder is the usual way to describe an app and it was, until this existed,
 * the only way to run one. Anything that assembled a project in memory —
 * generated it, composed it from parts, decided the arrangement
 * programmatically — held a value of exactly the right type with nowhere to put
 * it, because every entry point began by reading a directory and the
 * constructor was private.
 */

import { afterEach, describe, expect, it } from "vitest";

import { App } from "../src/app.js";
import { agent, defineConfig } from "../src/define.js";
import type { Project } from "../src/project/load.js";
import { MODEL_ENV, TEST_ENDPOINT, cleanup, FRAMEWORK, makeProject, stubModel } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(cleanup)));

/** The same endpoint the other tests use, as a value rather than as source. */
const MODELS = {
  house: {
    url: "https://models.test",
    credential: "HOUSE_KEY",
    speaks: "messages" as const,
    fast: "small",
    balanced: "mid",
    best: "large",
  },
};

/** A project assembled here, the way a composing layer would produce one. */
function inMemory(root: string): Project {
  return {
    root,
    name: "made-up",
    config: defineConfig({ name: "made-up", quality: "fast", models: MODELS }),
    agents: {
      helper: agent({
        name: "helper",
        role: "You answer briefly.",
      }),
    },
    workflows: {},
    tools: {},
    functions: {},
    prompts: {},
    resources: {},
    stores: {},
    blueprints: {},
    templates: {},
    knowledge: [],
    warnings: [],
  };
}

describe("an app from a project already in hand", () => {
  it("runs an agent that was never written to disk", async () => {
    // The point of the whole thing: nothing here came from a folder, and the
    // app still answers.
    const root = await makeProject({});
    roots.push(root);
    const stub = stubModel([{ text: "Made up, and answering." }]);

    const app = await App.from(inMemory(root), { env: MODEL_ENV, fetch: stub.fetch });
    const answer = await app.ask("helper", "are you there?");

    expect(answer.text).toBe("Made up, and answering.");
    expect(app.project.name).toBe("made-up");
    await app.close();
  });

  it("takes its root from the project unless told otherwise", async () => {
    const root = await makeProject({});
    roots.push(root);
    const stub = stubModel([{ text: "ok" }]);

    const fromProject = await App.from(inMemory(root), { env: MODEL_ENV, fetch: stub.fetch });
    expect(fromProject.root).toBe(root);
    await fromProject.close();

    const other = await makeProject({});
    roots.push(other);
    const overridden = await App.from(inMemory(root), {
      root: other,
      env: MODEL_ENV,
      fetch: stub.fetch,
    });
    expect(overridden.root).toBe(other);
    await overridden.close();
  });

  it("gives the same surface as one loaded from a folder", async () => {
    // If `from` produced a differently-capable App, callers would have to know
    // which kind they were holding, and the seam would be a fork.
    const root = await makeProject({
      "praecise.config.ts": `import { defineConfig } from "${FRAMEWORK}";
        export default defineConfig({ name: "made-up", quality: "fast", ${TEST_ENDPOINT} });`,
      "agents/helper.ts": `import { agent } from "${FRAMEWORK}";
        export default agent({ name: "helper", role: "You answer briefly." });`,
    });
    roots.push(root);
    const stub = stubModel([{ text: "ok" }, { text: "ok" }]);

    const loaded = await App.load({ root, env: MODEL_ENV, fetch: stub.fetch });
    const made = await App.from(inMemory(root), { env: MODEL_ENV, fetch: stub.fetch });

    expect(Object.keys(made.plans)).toEqual(Object.keys(loaded.plans));
    expect(made.name).toBe(loaded.name);
    expect(made.stateDir).toBe(loaded.stateDir);
    await loaded.close();
    await made.close();
  });
});
