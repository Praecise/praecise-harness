import { afterEach, describe, expect, it } from "vitest";

import { findCycle, loadProject } from "../src/project/load.js";
import { cleanup, FRAMEWORK, makeProject } from "./helpers.js";

const roots: string[] = [];

async function project(files: Record<string, string>) {
  const root = await makeProject(files);
  roots.push(root);
  return loadProject(root);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(cleanup));
});

describe("the convention folders", () => {
  it("loads every kind from its own folder", async () => {
    const loaded = await project({
      "agents/a.ts": `import { agent } from "${FRAMEWORK}";
        export default agent({ role: "Help." });`,
      "functions/total.ts": `import { fn } from "${FRAMEWORK}";
        export default fn({ description: "Add two numbers.", run: ({ a, b }) => Number(a) + Number(b) });`,
      "prompts/triage.ts": `import { prompt } from "${FRAMEWORK}";
        export default prompt({ description: "Sort a message.", text: "Sort this: {{message}}" });`,
      "resources/orders.ts": `import { resource } from "${FRAMEWORK}";
        export default resource({ description: "Recent orders.", uri: "orders://recent", read: () => "none" });`,
      "stores/main.ts": `import { store } from "${FRAMEWORK}";
        export default store({ of: "sql" });`,
      "templates/blank.ts": `import { template } from "${FRAMEWORK}";
        export default template({ files: [{ path: "agents/a.ts", contents: "" }] });`,
    });

    expect(Object.keys(loaded.functions)).toEqual(["total"]);
    expect(Object.keys(loaded.prompts)).toEqual(["triage"]);
    expect(Object.keys(loaded.resources)).toEqual(["orders"]);
    expect(Object.keys(loaded.stores)).toEqual(["main"]);
    expect(Object.keys(loaded.templates)).toEqual(["blank"]);
    expect(loaded.warnings).toEqual([]);
  });

  it("runs a loaded function", async () => {
    const loaded = await project({
      "functions/total.ts": `import { fn } from "${FRAMEWORK}";
        export default fn({ run: ({ a, b }) => Number(a) + Number(b) });`,
    });
    expect(await loaded.functions.total!.run({ a: 2, b: 3 })).toBe(5);
  });

  it("takes middleware from the project root, as a bare function", async () => {
    const loaded = await project({
      "middleware.ts": `import { middleware } from "${FRAMEWORK}";
        export default middleware(async (call, next) => next());`,
    });
    expect(typeof loaded.middleware?.run).toBe("function");
  });

  it("reads a markdown blueprint as plain-English intent", async () => {
    const loaded = await project({
      "blueprints/support-desk.md": "# Support desk\n\nTriage a message, then reply.\n",
    });
    const found = loaded.blueprints["support-desk"];
    expect(found?.intent).toContain("Triage a message");
    expect(found?.description).toBe("Support desk");
  });

  it("prefers a written blueprint over a markdown one of the same name", async () => {
    const loaded = await project({
      "blueprints/desk.md": "prose",
      "blueprints/desk.ts": `import { blueprint } from "${FRAMEWORK}";
        export default blueprint({ files: [{ path: "agents/x.ts", contents: "" }] });`,
    });
    expect(loaded.blueprints.desk?.files).toHaveLength(1);
    expect(loaded.blueprints.desk?.intent).toBeUndefined();
  });
});

describe("memory/ as the folder of what the app knows", () => {
  it("reads every document in the folder, nested ones included", async () => {
    const loaded = await project({
      "memory/faq.md": "Refunds take 5 days.",
      "memory/policies/returns.md": "Returns within 30 days.",
    });
    const byName = Object.fromEntries(loaded.knowledge.map((d) => [d.name, d.content]));
    expect(Object.keys(byName).sort()).toEqual(["faq", "policies/returns"]);
    expect(byName.faq).toContain("5 days");
  });

  it("converts a non-text document on the way in", async () => {
    const loaded = await project({ "memory/people.csv": "name,city\nAda,London" });
    expect(loaded.knowledge[0]?.content).toBe("name: Ada, city: London");
  });

  it("names the format it cannot read instead of dropping the file", async () => {
    const loaded = await project({ "memory/plan.dwg": "binary" });
    expect(loaded.knowledge).toEqual([]);
    expect(loaded.warnings.join(" ")).toContain(".dwg");
  });
});

describe("validation", () => {
  it("warns when a step waits for something that is not beside it", async () => {
    const loaded = await project({
      "workflows/w.ts": `import { workflow } from "${FRAMEWORK}";
        export default workflow({ steps: [{ id: "a", ask: "hi", after: ["nope"] }] });`,
    });
    expect(loaded.warnings.join(" ")).toContain('waits for "nope"');
  });

  it("catches steps that wait on each other in a circle", async () => {
    const loaded = await project({
      "workflows/w.ts": `import { workflow } from "${FRAMEWORK}";
        export default workflow({ steps: [
          { id: "a", ask: "1", after: ["b"] },
          { id: "b", ask: "2", after: ["a"] },
        ] });`,
    });
    expect(loaded.warnings.join(" ")).toContain("circle");
  });

  it("insists a repeat can end", async () => {
    const loaded = await project({
      "workflows/w.ts": `import { workflow } from "${FRAMEWORK}";
        export default workflow({ steps: [
          { id: "r", repeat: [{ id: "x", ask: "go" }], until: { asks: "done?" }, max: 0 },
        ] });`,
    });
    expect(loaded.warnings.join(" ")).toContain("cannot end");
  });

  it("warns when a plan may draw on an agent that does not exist", async () => {
    const loaded = await project({
      "workflows/w.ts": `import { workflow } from "${FRAMEWORK}";
        export default workflow({ steps: [{ id: "p", plan: "do it", from: ["ghost"] }] });`,
    });
    expect(loaded.warnings.join(" ")).toContain('unknown agent "ghost"');
  });

  it("warns when a vector store has no dimensions", async () => {
    const loaded = await project({
      "stores/v.ts": `import { store } from "${FRAMEWORK}";
        export default store({ of: "vector" });`,
    });
    expect(loaded.warnings.join(" ")).toContain("dimensions");
  });

  it("warns when memory names a store that is not declared", async () => {
    const loaded = await project({
      "agents/a.ts": `import { agent } from "${FRAMEWORK}";
        export default agent({ role: "Help.", memory: { store: "ghost" } });`,
    });
    expect(loaded.warnings.join(" ")).toContain('unknown store "ghost"');
  });
});

describe("findCycle", () => {
  it("returns the loop it found", () => {
    const cycle = findCycle([
      { id: "a", ask: "1", after: ["c"] },
      { id: "b", ask: "2", after: ["a"] },
      { id: "c", ask: "3", after: ["b"] },
    ]);
    expect(cycle?.length).toBe(4);
  });

  it("is quiet about a graph that is merely diamond-shaped", () => {
    expect(
      findCycle([
        { id: "a", ask: "1" },
        { id: "b", ask: "2", after: ["a"] },
        { id: "c", ask: "3", after: ["a"] },
        { id: "d", ask: "4", after: ["b", "c"] },
      ]),
    ).toBeUndefined();
  });
});
