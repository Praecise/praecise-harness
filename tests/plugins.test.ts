/**
 * A plugin brings a piece of an app, not only commands.
 *
 * It goes in under the app's own folder: installing one can add an agent and can never
 * quietly change what one of the app's own agents is.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { agent, fn, type Plugin } from "../src/define.js";
import { knownReaders, present, registerReader, takesOf } from "../src/harness/modality.js";
import { loadProject } from "../src/project/load.js";
import { createApp, defineApp } from "../src/sdk.js";
import { FRAMEWORK, MODEL_ENV, cleanup, makeProject, stubModel } from "./helpers.js";

const MODELS = { house: { url: "https://models.test", credential: "HOUSE_KEY", speaks: "messages", fast: "small" } };

const kit: Plugin = {
  name: "kit",
  app: {
    agents: { helper: agent({ role: "Help with anything.", quality: "fast", tools: ["lookup"] }) },
    functions: { lookup: fn({ description: "Look an order up.", input: { id: "the order id" }, effect: "read", run: ({ id }) => `order ${id}: delivered` }) },
  },
};

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "praecise-plugins-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("what a plugin brings", () => {
  it("is part of the app: its agent answers and calls its function", async () => {
    const model = stubModel([{ text: "", tool: { name: "lookup", args: { id: "7" } } }, { text: "Delivered." }]);
    const app = await createApp({ root, config: { models: MODELS, plugins: [kit] } }, { env: MODEL_ENV, fetch: model.fetch });

    expect(app.agentNames).toEqual(["helper"]);
    const answer = await app.ask("helper", "where is order 7?");
    expect(answer.text).toBe("Delivered.");
    expect(answer.toolCalls).toEqual([{ name: "lookup", args: { id: "7" } }]);
  });

  it("never replaces what the app defined itself, and says so", () => {
    const project = defineApp({
      root,
      config: { models: MODELS, plugins: [kit] },
      agents: { helper: agent({ role: "The app's own helper." }) },
    });
    expect(project.agents.helper!.role).toBe("The app's own helper.");
    expect(project.functions.lookup).toBeDefined();
    expect(project.warnings.join("\n")).toContain('plugin "kit" brings agent "helper" and this app already has one by that name');
    expect(project.faults ?? []).toEqual([]);
  });

  it("is held to the rules the folder is held to", () => {
    const broken: Plugin = { name: "broken", app: { agents: { empty: { role: "" } as never } } };
    const project = defineApp({ root, config: { models: MODELS, plugins: [broken] } });
    expect((project.faults ?? []).join("\n")).toMatch(/empty/);
  });

  it("needs a name, and one name is one plugin", () => {
    const project = defineApp({ root, config: { plugins: [{ name: "" }, kit, { ...kit }] } });
    const faults = (project.faults ?? []).join("\n");
    expect(faults).toContain("has no name");
    expect(faults).toContain('two plugins are named "kit"');
  });

  it("loads from a folder's config the same way", async () => {
    const dir = await makeProject({
      "praecise.config.ts": `import { defineConfig, agent } from "${FRAMEWORK}";
        export default defineConfig({
          plugins: [{ name: "kit", app: { agents: { helper: agent({ role: "Help with anything." }) } } }],
        });`,
      "agents/own.ts": `import { agent } from "${FRAMEWORK}";\nexport default agent({ role: "The app's own." });`,
    });
    try {
      const project = await loadProject(dir);
      expect(Object.keys(project.agents).sort()).toEqual(["helper", "own"]);
      expect(project.agents.helper!.name).toBe("helper");
    } finally {
      await cleanup(dir);
    }
  });

  it("sets up before the app is planned, so what it registers is there to be used", async () => {
    const reads: Plugin = {
      name: "reads",
      setup: () => registerReader("a flight log", "application/vnd.test-flight-log", () => "Flight log: 3 legs."),
    };
    const model = stubModel([{ text: "ok" }]);
    await createApp({ root, config: { models: MODELS, plugins: [reads] }, agents: { a: agent({ role: "Help." }) } }, { env: MODEL_ENV, fetch: model.fetch });

    expect(knownReaders()).toContain("a flight log");
    const shown = present([{ mime: "application/vnd.test-flight-log", data: "AAEC" }], takesOf("chat"), 500);
    expect(shown.text).toContain("Flight log: 3 legs.");
  });

  it("a setup that throws is reported by name and does not stop the app", async () => {
    const bad: Plugin = {
      name: "bad",
      setup: () => {
        throw new Error("no licence");
      },
    };
    const model = stubModel([{ text: "ok" }]);
    const app = await createApp({ root, config: { models: MODELS, plugins: [bad] }, agents: { a: agent({ role: "Help." }) } }, { env: MODEL_ENV, fetch: model.fetch });
    expect(app.project.warnings.join("\n")).toContain('plugin "bad" failed to set up: no licence');
    expect((await app.ask("a", "hi")).text).toBe("ok");
  });
});
