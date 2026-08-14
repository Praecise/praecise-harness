/**
 * A diagnosis nobody acts on.
 *
 * Every case here was already detected by the loader and written to
 * `project.warnings`, where nothing on the run path read it. The workflows ran,
 * did nothing, and reported `{"status":"done","outputs":{}}`.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { App } from "../src/app.js";
import { workflow } from "../src/define.js";
import { main } from "../src/cli/index.js";
import { loadProject } from "../src/project/load.js";
import { defectsIn } from "../src/workflow/defects.js";
import { startRun, type WorkflowDeps } from "../src/workflow/run.js";
import { RunStore } from "../src/workflow/store.js";
import type { AgentPlan } from "../src/compile/plan.js";
import type { Answer, Harness } from "../src/harness/types.js";
import { MODEL_ENV, TEST_MODELS, cleanup, FRAMEWORK, makeProject, stubModel } from "./helpers.js";

const plan: AgentPlan = {
  name: "test",
  description: "test",
  quality: "fast",
  instructions: "",
  rungs: [],
  services: [],
  locals: [],
  memory: false,
  problems: [],
};

const answered: Answer = {
  text: "done",
  path: ["stub"],
  usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, decidingTokens: 0 },
  toolCalls: [],
  harness: "stub",
};

let dir: string;
let store: RunStore;
const roots: string[] = [];

const harness: Harness = { name: "stub", ask: async () => answered };

function deps(extra: Partial<WorkflowDeps> = {}): WorkflowDeps {
  return {
    harness,
    store,
    planFor: async () => plan,
    callTool: async () => ({}),
    ...extra,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "praecise-defects-"));
  store = new RunStore(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await Promise.all(roots.splice(0).map(cleanup));
});

const project = async (files: Record<string, string>) => {
  const root = await makeProject({ ...TEST_MODELS, ...files });
  roots.push(root);
  return root;
};

describe("a workflow that cannot run", () => {
  it("refuses a cycle instead of reporting done having done nothing", async () => {
    const spec = workflow({
      name: "cycle",
      steps: [
        { id: "a", ask: "one", after: ["b"] },
        { id: "b", ask: "two", after: ["a"] },
      ],
    });

    await expect(startRun(spec, {}, deps())).rejects.toThrow(
      /steps wait on each other in a circle — a → b → a/,
    );
    // Nothing was attempted, so nothing is on the record to explain later.
    expect(await store.list()).toEqual([]);
  });

  it("refuses a duplicate step id", async () => {
    const spec = workflow({
      name: "dup",
      steps: [
        { id: "a", ask: "one" },
        { id: "a", ask: "two" },
      ],
    });

    await expect(startRun(spec, {}, deps())).rejects.toThrow(/duplicate step id "a"/);
  });

  it("refuses a step that names an agent nobody wrote, before paying for the graph", async () => {
    const spec = workflow({
      name: "wrong",
      steps: [{ id: "a", ask: "one", agent: "nope" }],
    });

    await expect(startRun(spec, {}, deps({ knownAgents: ["support"] }))).rejects.toThrow(
      /step "a" references unknown agent "nope"/,
    );
  });

  it("checks a nested step as closely as a top-level one", () => {
    const spec = workflow({
      name: "inner",
      steps: [
        {
          id: "loop",
          repeat: [
            { id: "x", ask: "one" },
            { id: "x", ask: "two" },
          ],
          until: { equals: "{{x}}", to: "ok" },
          max: 2,
        },
      ],
    });

    expect(defectsIn(spec)).toContain('workflow "inner": duplicate step id "x"');
  });

  it("says the same sentence whether it is a loader warning or a refusal", async () => {
    const root = await project({
      "workflows/cycle.ts": `import { workflow } from "${FRAMEWORK}";
        export default workflow({
          description: "Goes round in a circle.",
          steps: [
            { id: "a", ask: "one", after: ["b"] },
            { id: "b", ask: "two", after: ["a"] },
          ],
        });`,
    });

    const loaded = await loadProject(root);
    const diagnosis = 'workflow "cycle": steps wait on each other in a circle — a → b → a';
    expect(loaded.warnings).toContain(diagnosis);
    expect(loaded.faults).toContain(diagnosis);

    const app = await App.load({ root, env: MODEL_ENV });
    await expect(app.startWorkflow("cycle", {})).rejects.toThrow(diagnosis);
    await app.close();
  });

  it("refuses the same way for a missing workflow and a broken one — one channel", async () => {
    const root = await project({
      "workflows/broken.ts": `import { workflow } from "${FRAMEWORK}";
        export default workflow({
          description: "Asks an agent that is not here.",
          steps: [{ id: "a", ask: "one", agent: "ghost" }],
        });`,
    });

    const app = await App.load({ root, env: MODEL_ENV });
    // Both are mistakes knowable before anything runs, so both arrive as a
    // throw. Neither invents a Run to record work that never started.
    await expect(app.startWorkflow("nope", {})).rejects.toThrow(/no workflow named "nope"/);
    await expect(app.startWorkflow("broken", {})).rejects.toThrow(/unknown agent "ghost"/);
    expect(await app.runs.list()).toEqual([]);
    await app.close();
  });

  it("still loads: one broken workflow must not take the app down with it", async () => {
    const root = await project({
      "agents/support.ts": `import { agent } from "${FRAMEWORK}";
        export default agent({ role: "Answers questions about orders." });`,
      "workflows/cycle.ts": `import { workflow } from "${FRAMEWORK}";
        export default workflow({
          description: "Goes round in a circle.",
          steps: [
            { id: "a", ask: "one", after: ["b"] },
            { id: "b", ask: "two", after: ["a"] },
          ],
        });`,
    });

    const app = await App.load({ root, env: MODEL_ENV });
    expect(app.agentNames).toEqual(["support"]);
    expect(app.faults).toHaveLength(1);
    await app.close();
  });

  it("does not refuse an `after` naming no sibling — the scheduler defines that one", async () => {
    const spec = workflow({ name: "loose", steps: [{ id: "only", ask: "one", after: ["nowhere"] }] });
    const run = await startRun(spec, {}, deps());
    expect(run.status).toBe("done");

    const root = await project({
      "workflows/loose.ts": `import { workflow } from "${FRAMEWORK}";
        export default workflow({
          description: "Waits on a step that is not there.",
          steps: [{ id: "only", ask: "one", after: ["nowhere"] }],
        });`,
    });
    const loaded = await loadProject(root);
    expect(loaded.warnings.join(" ")).toContain("that wait is dropped");
    expect(loaded.faults).toEqual([]);
  });
});

describe("a reference that names nothing", () => {
  it("fails the run rather than sending the model a prompt with a hole in it", async () => {
    const asked: string[] = [];
    const spec = workflow({
      name: "typo",
      steps: [{ id: "reply", ask: "Reply to: {{mesage}}" }],
    });

    const run = await startRun(spec, { message: "hello" }, deps({
      harness: {
        name: "stub",
        ask: async (_plan, input) => {
          asked.push(input);
          return answered;
        },
      },
    }));

    expect(run.status).toBe("failed");
    expect(run.error).toContain('nothing in scope is called "mesage"');
    expect(run.error).toContain("Did you mean `{{message}}`?");
    expect(asked).toEqual([]); // nothing was paid for
  });

  it("catches the typo at load time too, once the workflow declares its inputs", async () => {
    const root = await project({
      "workflows/typo.ts": `import { workflow } from "${FRAMEWORK}";
        export default workflow({
          description: "Replies to a message.",
          input: { message: "the message to reply to" },
          steps: [{ id: "reply", ask: "Reply to: {{mesage}}" }],
        });`,
    });

    const loaded = await loadProject(root);
    expect(loaded.warnings.join(" ")).toContain("{{mesage}}");
    // Advice, not a fault: a caller may pass more than was declared, so being
    // wrong here should cost a warning rather than a refusal.
    expect(loaded.faults).toEqual([]);
  });

  it("says nothing about a workflow that declared no inputs — there is nothing to check against", async () => {
    const root = await project({
      "workflows/open.ts": `import { workflow } from "${FRAMEWORK}";
        export default workflow({
          description: "Summarises whatever it is given.",
          steps: [{ id: "sum", ask: "Summarise {{topic}}" }],
        });`,
    });

    const loaded = await loadProject(await Promise.resolve(root));
    expect(loaded.warnings.join(" ")).not.toContain("{{topic}}");
  });
});

describe("what a command's exit code means", () => {
  const printed: string[] = [];
  const wrote = process.stdout.write.bind(process.stdout);

  beforeEach(() => {
    printed.length = 0;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      printed.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = wrote;
  });

  it("does not say `nothing here yet` over an app whose files all failed to load", async () => {
    const root = await project({
      "agents/broken.ts": "export default { not: 'an agent' };",
    });

    const code = await main(["list", "--dir", root]);
    const said = printed.join("");

    expect(code).toBe(1);
    expect(said).not.toContain("nothing here yet");
    expect(said).toContain("did not load");
    expect(said).toContain("broken");
  });

  it("still says `nothing here yet` when the folder really is empty", async () => {
    const code = await main(["list", "--dir", await project({})]);
    expect(code).toBe(0);
    expect(printed.join("")).toContain("nothing here yet");
  });

  it("does not fail a healthy app for a missing description or an absent credential", async () => {
    const root = await project({
      "agents/support.ts": `import { agent } from "${FRAMEWORK}";
        export default agent({ role: "Answers questions about orders." });`,
      "functions/doit.ts": `import { fn } from "${FRAMEWORK}";
        export default fn({ run: () => "done" });`,
    });

    // No HOUSE_KEY in this process, and `doit` has no description: both are
    // printed, and neither is grounds for calling the app broken.
    expect(await main(["list", "--dir", root])).toBe(0);
  });

  it("fails, and explains, rather than printing null for a broken workflow", async () => {
    const root = await project({
      "workflows/cycle.ts": `import { workflow } from "${FRAMEWORK}";
        export default workflow({
          description: "Goes round in a circle.",
          steps: [
            { id: "a", ask: "one", after: ["b"] },
            { id: "b", ask: "two", after: ["a"] },
          ],
        });`,
    });

    const code = await main(["run", "cycle", "--dir", root]);
    const said = printed.join("");

    // It printed `null` and exited 0.
    expect(code).toBe(1);
    expect(said).not.toContain("null");
    expect(said).toContain("steps wait on each other in a circle");
    // And it never started: the refusal is the pre-flight one, not a run that
    // got under way and then discovered it had nowhere to go.
    expect(said).toContain("cannot run as written");
  });
});

describe("an app that has models it cannot reach", () => {
  it("reports its answer as a placeholder rather than as an answer", async () => {
    const root = await project({
      "agents/support.ts": `import { agent } from "${FRAMEWORK}";
        export default agent({ role: "Answers questions about orders." });`,
    });

    // Configured with the test endpoint, and no credential in this environment.
    const app = await App.load({ root, env: {}, fetch: stubModel([]).fetch });
    await expect(app.ask("support", "hi")).rejects.toThrow(/could not reach any of them/);
    await app.close();
  });
});
