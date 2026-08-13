import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentPlan } from "../src/compile/plan.js";
import { workflow, type Step } from "../src/define.js";
import type { Answer, Harness } from "../src/harness/types.js";
import { checkSteps, provisioner } from "../src/workflow/provision.js";
import { resumeRun, startRun, type ProvisionResult, type WorkflowDeps } from "../src/workflow/run.js";
import { RunStore } from "../src/workflow/store.js";

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

function answer(text: string, tokens = 0): Answer {
  return {
    text,
    path: ["stub"],
    usage: { inputTokens: tokens, outputTokens: tokens, cachedTokens: 0, decidingTokens: 0 },
    toolCalls: [],
    harness: "stub",
  };
}

let dir: string;
let store: RunStore;
/** Every step that started, in the order it started — what proves parallelism. */
let started: string[];
let finished: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "praecise-sched-"));
  store = new RunStore(join(dir, "runs"));
  started = [];
  finished = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * Each `ask` holds for as long as its input says, so the order things finish in
 * reveals whether they really overlapped.
 */
function deps(extra: Partial<WorkflowDeps> = {}): WorkflowDeps {
  const harness: Harness = {
    name: "stub",
    async ask(_plan, input) {
      const label = input.split(":")[0]!;
      const delay = Number(input.split(":")[1] ?? 0);
      started.push(label);
      await new Promise((done) => setTimeout(done, delay));
      finished.push(label);
      return answer(`${label} done`, 10);
    },
  };
  return {
    harness,
    store,
    planFor: async () => plan,
    callTool: async (ref, args) => ({ ref, args }),
    ...extra,
  };
}

describe("the ready set", () => {
  it("runs a list in order when no step declares a dependency", async () => {
    const spec = workflow({
      steps: [
        { id: "one", ask: "one:20" },
        { id: "two", ask: "two:0" },
      ],
    });

    const run = await startRun(spec, {}, deps());
    expect(run.status).toBe("done");
    // "two" is faster, so finishing second is only possible if it waited.
    expect(finished).toEqual(["one", "two"]);
  });

  it("runs independent steps at the same time once one declares `after`", async () => {
    const spec = workflow({
      steps: [
        { id: "slow", ask: "slow:40" },
        { id: "quick", ask: "quick:0" },
        { id: "join", ask: "join:0", after: ["slow", "quick"] },
      ],
    });

    const run = await startRun(spec, {}, deps());
    expect(run.status).toBe("done");
    expect(started.slice(0, 2).sort()).toEqual(["quick", "slow"]);
    expect(finished).toEqual(["quick", "slow", "join"]);
    expect(run.result).toBe("join done");
  });

  it("never runs more at once than the concurrency limit allows", async () => {
    let live = 0;
    let peak = 0;
    const spec = workflow({
      steps: [
        { id: "a", ask: "a:20" },
        { id: "b", ask: "b:20" },
        { id: "c", ask: "c:20" },
        { id: "last", ask: "last:0", after: ["a", "b", "c"] },
      ],
    });

    const harness: Harness = {
      name: "stub",
      async ask() {
        peak = Math.max(peak, ++live);
        await new Promise((done) => setTimeout(done, 20));
        live--;
        return answer("ok");
      },
    };

    await startRun(spec, {}, deps({ harness, limits: { concurrency: 2 } }));
    expect(peak).toBe(2);
  });

  it("ignores an `after` naming a step that is not in the list", async () => {
    const spec = workflow({
      steps: [{ id: "only", ask: "only:0", after: ["nowhere"] }],
    });

    const run = await startRun(spec, {}, deps());
    expect(run.status).toBe("done");
    expect(run.outputs.only).toBe("only done");
  });
});

describe("repeat", () => {
  it("stops as soon as the check holds", async () => {
    let tries = 0;
    const harness: Harness = {
      name: "stub",
      async ask() {
        tries++;
        return answer(tries < 3 ? "no" : "yes");
      },
    };
    const spec = workflow({
      steps: [
        {
          id: "loop",
          repeat: [{ id: "try", ask: "again" }],
          until: { equals: "{{last}}", to: "yes" },
          max: 5,
        },
      ],
    });

    const run = await startRun(spec, {}, deps({ harness }));
    expect(tries).toBe(3);
    expect(run.result).toMatchObject({ attempts: 3, passed: true });
  });

  it("lets a body see what it produced earlier in the same attempt", async () => {
    // Without this a loop can only re-send the same prompt, which is not repair.
    const seen: string[] = [];
    const harness: Harness = {
      name: "stub",
      async ask(_plan, input) {
        seen.push(input);
        return answer(input.startsWith("check") ? "yes" : "draft");
      },
    };
    const spec = workflow({
      steps: [
        {
          id: "loop",
          repeat: [
            { id: "write", ask: "write" },
            { id: "check", ask: "check {{write}}" },
          ],
          until: { equals: "{{check}}", to: "yes" },
          max: 3,
        },
      ],
    });

    const run = await startRun(spec, {}, deps({ harness }));
    expect(seen).toEqual(["write", "check draft"]);
    expect(run.result).toMatchObject({ attempts: 1, passed: true });
  });

  it("reads a bare name as this attempt's step rather than an earlier one", async () => {
    let round = 0;
    const seen: string[] = [];
    const harness: Harness = {
      name: "stub",
      async ask(_plan, input) {
        seen.push(input);
        if (input === "write") return answer(`draft-${++round}`);
        return answer(round < 2 ? "no" : "yes");
      },
    };
    const spec = workflow({
      steps: [
        {
          id: "loop",
          repeat: [
            { id: "write", ask: "write" },
            { id: "check", ask: "check {{write}}" },
          ],
          until: { equals: "{{check}}", to: "yes" },
          max: 3,
        },
      ],
    });

    await startRun(spec, {}, deps({ harness }));
    expect(seen).toEqual(["write", "check draft-1", "write", "check draft-2"]);
  });

  it("hands each attempt what the one before it produced", async () => {
    let round = 0;
    const seen: string[] = [];
    const harness: Harness = {
      name: "stub",
      async ask(_plan, input) {
        seen.push(input);
        if (input.startsWith("fix")) return answer(`draft-${++round}`);
        return answer(round < 3 ? "no" : "yes");
      },
    };
    const spec = workflow({
      steps: [
        {
          id: "loop",
          repeat: [
            { id: "write", ask: "fix {{prior.write}}" },
            { id: "check", ask: "check {{write}}" },
          ],
          until: { equals: "{{check}}", to: "yes" },
          max: 3,
        },
      ],
    });

    await startRun(spec, {}, deps({ harness }));
    const fixes = seen.filter((s) => s.startsWith("fix"));
    expect(fixes).toEqual(["fix ", "fix draft-1", "fix draft-2"]);
  });

  it("gives up at `max` and says it did not pass", async () => {
    const harness: Harness = { name: "stub", ask: async () => answer("no") };
    const spec = workflow({
      steps: [
        {
          id: "loop",
          repeat: [{ id: "try", ask: "again" }],
          until: { equals: "{{last}}", to: "yes" },
          max: 2,
        },
      ],
    });

    const run = await startRun(spec, {}, deps({ harness }));
    expect(run.status).toBe("done");
    expect(run.result).toMatchObject({ attempts: 2, passed: false });
  });

  it("checks by running a command, not by asking", async () => {
    let asked = 0;
    const harness: Harness = {
      name: "stub",
      async ask() {
        asked++;
        return answer("whatever");
      },
    };
    const spec = workflow({
      steps: [
        {
          id: "loop",
          repeat: [{ id: "try", ask: "go" }],
          until: { passes: "node -e process.exit(0)" },
          max: 3,
        },
      ],
    });

    const run = await startRun(spec, {}, deps({ harness }));
    expect(run.result).toMatchObject({ attempts: 1, passed: true });
    // One ask for the step itself; the check cost no model call at all.
    expect(asked).toBe(1);
  });
});

describe("each", () => {
  it("runs the body per item, bounded by its own concurrency", async () => {
    let live = 0;
    let peak = 0;
    const harness: Harness = {
      name: "stub",
      async ask(_plan, input) {
        peak = Math.max(peak, ++live);
        await new Promise((done) => setTimeout(done, 10));
        live--;
        return answer(input);
      },
    };
    const spec = workflow({
      steps: [
        {
          id: "fan",
          each: "{{topics}}",
          as: "topic",
          concurrency: 3,
          do: [{ id: "look", ask: "{{topic}}" }],
        },
      ],
    });

    const run = await startRun(spec, { topics: ["a", "b", "c", "d"] }, deps({ harness }));
    expect(run.status).toBe("done");
    expect(peak).toBe(3);
    expect(run.result).toEqual(["a", "b", "c", "d"]);
  });
});

describe("limits", () => {
  it("stops the run when it passes its token budget", async () => {
    const spec = workflow({
      steps: [
        { id: "one", ask: "one:0" },
        { id: "two", ask: "two:0" },
      ],
    });

    const run = await startRun(spec, {}, deps({ limits: { budget: 15 } }));
    expect(run.status).toBe("failed");
    expect(run.error).toContain("budget");
    expect(run.usage.inputTokens).toBe(10);
  });

  it("refuses to provision deeper than the depth limit", async () => {
    const provision = async (): Promise<ProvisionResult> => ({
      steps: [{ id: "inner", plan: "go deeper" }],
    });
    const spec = workflow({ steps: [{ id: "outer", plan: "start" }] });

    const run = await startRun(spec, {}, deps({ provision, limits: { depth: 1 } }));
    expect(run.status).toBe("failed");
    expect(run.error).toContain("past the limit");
  });

  it("says so when a plan step has no planner behind it", async () => {
    const spec = workflow({ steps: [{ id: "outer", plan: "start" }] });
    const run = await startRun(spec, {}, deps());
    expect(run.status).toBe("failed");
    expect(run.error).toContain("no planner");
  });
});

describe("plan", () => {
  const graph: Step[] = [
    { id: "left", ask: "left:20" },
    { id: "right", ask: "right:0" },
    { id: "merge", ask: "merge:0", after: ["left", "right"] },
  ];

  it("runs what the planner returned, in parallel where it can", async () => {
    let calls = 0;
    const provision = async (): Promise<ProvisionResult> => {
      calls++;
      return { steps: graph };
    };
    const spec = workflow({ steps: [{ id: "work", plan: "do the thing" }] });

    const run = await startRun(spec, {}, deps({ provision }));
    expect(run.status).toBe("done");
    expect(calls).toBe(1);
    expect(finished).toEqual(["right", "left", "merge"]);
    expect(run.plans.work?.[0]?.steps).toHaveLength(3);
  });

  it("replays the recorded plan on resume instead of asking again", async () => {
    let calls = 0;
    const provision = async (): Promise<ProvisionResult> => {
      calls++;
      return {
        steps: [
          { id: "draft", ask: "draft:0" },
          { id: "sign", approve: "ok to send?", after: ["draft"] },
          { id: "send", ask: "send:0", after: ["sign"] },
        ],
      };
    };
    const spec = workflow({ steps: [{ id: "work", plan: "do the thing" }] });

    const paused = await startRun(spec, {}, deps({ provision }));
    expect(paused.status).toBe("waiting");
    expect(calls).toBe(1);

    const done = await resumeRun(paused.id, { approved: true }, spec, deps({ provision }));
    expect(done.status).toBe("done");
    // The plan was not re-provisioned, and the finished step was not re-run.
    expect(calls).toBe(1);
    expect(done.plans.work).toHaveLength(1);
    expect(started).toEqual(["draft", "send"]);
  });

  it("re-plans the failed part and keeps the version that failed", async () => {
    let calls = 0;
    const provision = async (request: { because?: string }): Promise<ProvisionResult> => {
      calls++;
      if (!request.because) return { steps: [{ id: "boom", use: "missing.tool" }] };
      return { steps: [{ id: "recover", ask: "recover:0" }] };
    };
    const callTool = async (): Promise<never> => {
      throw new Error("that tool does not exist");
    };
    const spec = workflow({ steps: [{ id: "work", plan: "do the thing" }] });

    const run = await startRun(spec, {}, deps({ provision, callTool }));
    expect(run.status).toBe("done");
    expect(calls).toBe(2);
    expect(run.plans.work).toHaveLength(2);
    expect(run.plans.work?.[1]?.because).toContain("does not exist");
    expect(run.events.some((e) => e.kind === "planned")).toBe(true);
  });

  it("does not re-plan when the author turned revision off", async () => {
    let calls = 0;
    const provision = async (): Promise<ProvisionResult> => {
      calls++;
      return { steps: [{ id: "boom", use: "missing.tool" }] };
    };
    const callTool = async (): Promise<never> => {
      throw new Error("nope");
    };
    const spec = workflow({ steps: [{ id: "work", plan: "go", revise: false }] });

    const run = await startRun(spec, {}, deps({ provision, callTool }));
    expect(run.status).toBe("failed");
    expect(calls).toBe(1);
  });
});

describe("checking what a planner returned", () => {
  const allowed = { agents: new Set(["writer"]), tools: new Set(["search"]), max: 8 };

  it("keeps steps that name a real agent and a real tool", () => {
    const { steps, notes } = checkSteps(
      [
        { id: "find", use: "search", with: { q: "x" } },
        { id: "write", ask: "write it up", agent: "writer", after: ["find"] },
      ],
      allowed,
    );
    expect(steps).toHaveLength(2);
    expect(notes).toEqual([]);
    expect(steps[1]).toMatchObject({ agent: "writer", after: ["find"] });
  });

  it("drops a step calling a tool the app does not have", () => {
    const { steps, notes } = checkSteps([{ id: "x", use: "launch_missiles" }], allowed);
    expect(steps).toEqual([]);
    expect(notes[0]).toContain("no tool called");
  });

  it("keeps the step but drops an agent that does not exist", () => {
    const { steps, notes } = checkSteps([{ id: "x", ask: "do it", agent: "ghost" }], allowed);
    expect(steps).toHaveLength(1);
    expect(steps[0]).not.toHaveProperty("agent");
    expect(notes[0]).toContain("does not exist");
  });

  it("drops an `after` that points forward, so a cycle cannot be built", () => {
    const { steps } = checkSteps(
      [
        { id: "first", ask: "a", after: ["second"] },
        { id: "second", ask: "b", after: ["first"] },
      ],
      allowed,
    );
    expect(steps[0]).not.toHaveProperty("after");
    expect(steps[1]).toMatchObject({ after: ["first"] });
  });

  it("makes ids unique and caps the list at max", () => {
    const { steps, notes } = checkSteps(
      [
        { id: "same", ask: "a" },
        { id: "same", ask: "b" },
        { id: "third", ask: "c" },
      ],
      { ...allowed, max: 2 },
    );
    expect(steps.map((step) => step.id)).toEqual(["same", "same_1"]);
    expect(notes.join(" ")).toContain("only the first 2");
  });
});

describe("provisioning non-escalation", () => {
  const manifest = { agents: [{ name: "a", description: "an agent" }], tools: [{ name: "safe" }, { name: "dangerous" }] };
  const prov = provisioner({
    harness: { name: "stub", async ask() { return answer('[{"id":"s1","use":"safe"},{"id":"s2","use":"dangerous"}]'); } },
    planner: async () => plan,
    manifest: () => manifest,
  });

  it("a plan's tools ceiling drops a non-granted tool (a plan cannot widen its authority)", async () => {
    const granted = await prov({ brief: "do", from: [], tools: ["safe"], max: 5, depth: 0, scope: {} });
    const used = granted.steps.map((s: any) => s.use);
    expect(used).toContain("safe");
    expect(used).not.toContain("dangerous");
    expect((granted.notes ?? []).join(" ")).toMatch(/dangerous/);
  });

  it("without a ceiling, every manifest tool is available (unchanged behaviour)", async () => {
    const open = await prov({ brief: "do", from: [], max: 5, depth: 0, scope: {} });
    expect(open.steps.map((s: any) => s.use)).toContain("dangerous");
  });
});
