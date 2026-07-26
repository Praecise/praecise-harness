import { afterEach, describe, expect, it } from "vitest";

import { loadProject, resolveKnows } from "../src/project/load.js";
import { cleanup, FRAMEWORK, makeProject } from "./helpers.js";

const roots: string[] = [];
const project = async (files: Record<string, string>) => {
  const root = await makeProject(files);
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map(cleanup));
});

describe("loadProject", () => {
  it("finds agents, workflows, and knowledge by convention", async () => {
    const root = await project({
      "agents/support.ts": `import { agent } from "${FRAMEWORK}";
        export default agent({ role: "Answers customer questions about orders." });`,
      "workflows/triage.ts": `import { workflow } from "${FRAMEWORK}";
        export default workflow({
          description: "Sorts an incoming message into a queue.",
          steps: [{ id: "one", ask: "hello" }],
        });`,
      "memory/faq.md": "# FAQ\nRefunds take 5 days.",
    });

    const loaded = await loadProject(root);
    expect(Object.keys(loaded.agents)).toEqual(["support"]);
    expect(Object.keys(loaded.workflows)).toEqual(["triage"]);
    expect(loaded.knowledge[0]?.name).toBe("faq");
    expect(loaded.warnings).toEqual([]);
  });

  it("names things after their file when the spec does not", async () => {
    const root = await project({
      "agents/billing.ts": `import { agent } from "${FRAMEWORK}";
        export default agent({ role: "Billing." });`,
    });
    const loaded = await loadProject(root);
    expect(loaded.agents.billing?.name).toBe("billing");
  });

  it("is an empty project, not an error, when the folders are absent", async () => {
    const loaded = await loadProject(await project({ "README.md": "hi" }));
    expect(loaded.agents).toEqual({});
    expect(loaded.warnings).toEqual([]);
  });

  it("warns instead of throwing when a module is broken", async () => {
    const root = await project({
      "agents/broken.ts": "export default { not: 'an agent' };",
      "agents/fine.ts": `import { agent } from "${FRAMEWORK}";
        export default agent({ role: "Fine." });`,
    });
    const loaded = await loadProject(root);
    expect(Object.keys(loaded.agents)).toEqual(["fine"]);
    expect(loaded.warnings.join(" ")).toContain("broken");
  });

  it("reads praecise.config.ts", async () => {
    const root = await project({
      "praecise.config.ts": `import { defineConfig } from "${FRAMEWORK}";
        export default defineConfig({ name: "acme", quality: "best", port: 4100 });`,
    });
    const loaded = await loadProject(root);
    expect(loaded.name).toBe("acme");
    expect(loaded.config.quality).toBe("best");
    expect(loaded.config.port).toBe(4100);
  });

  it("flags duplicate step ids in a workflow", async () => {
    const root = await project({
      "workflows/dup.ts": `import { workflow } from "${FRAMEWORK}";
        export default workflow({ steps: [{ id: "a", ask: "x" }, { id: "a", ask: "y" }] });`,
    });
    const loaded = await loadProject(root);
    expect(loaded.warnings.join(" ")).toContain("a");
  });
});

describe("resolveKnows", () => {
  it("matches a glob under memory/", async () => {
    const root = await project({
      "memory/a.md": "alpha",
      "memory/b.md": "beta",
    });
    const loaded = await loadProject(root);
    const docs = await resolveKnows(loaded, ["memory/*.md"]);
    expect(docs.map((d) => d.content).sort()).toEqual(["alpha", "beta"]);
  });

  it("treats a sentence as inline knowledge", async () => {
    const loaded = await loadProject(await project({}));
    const docs = await resolveKnows(loaded, ["Refunds take five business days."]);
    expect(docs[0]?.content).toBe("Refunds take five business days.");
  });
});
