import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentPlan } from "../src/compile/plan.js";
import { workflow, type WorkflowSpec } from "../src/define.js";
import type { Answer, Harness } from "../src/harness/types.js";
import { resumeRun, startRun, type WorkflowDeps } from "../src/workflow/run.js";
import { RunStore } from "../src/workflow/store.js";
import { runCommand } from "../src/workflow/verify.js";

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

function answer(text: string, data?: unknown): Answer {
  return {
    text,
    data,
    path: ["stub"],
    usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, decidingTokens: 0 },
    toolCalls: [],
    harness: "stub",
  };
}

let dir: string;
let store: RunStore;
let asked: string[];
let plans: AgentPlan[];
let tooled: { ref: string; args: unknown }[];

function deps(reply: (input: string) => Answer): WorkflowDeps {
  const harness: Harness = {
    name: "stub",
    async ask(given, input) {
      asked.push(input);
      plans.push(given);
      return reply(input);
    },
  };
  return {
    harness,
    store,
    planFor: async () => plan,
    callTool: async (ref, args) => {
      tooled.push({ ref, args });
      return { ok: ref };
    },
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "praecise-runs-"));
  store = new RunStore(dir);
  asked = [];
  plans = [];
  tooled = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("startRun", () => {
  it("runs steps in order and returns the last output", async () => {
    const spec = workflow({
      name: "chain",
      steps: [
        { id: "first", ask: "Summarise {{topic}}" },
        { id: "second", ask: "Rewrite {{first}}" },
      ],
    });

    const run = await startRun(spec, { topic: "otters" }, deps((input) => answer(`<${input}>`)));

    expect(run.status).toBe("done");
    expect(asked).toEqual(["Summarise otters", "Rewrite <Summarise otters>"]);
    expect(run.result).toBe("<Rewrite <Summarise otters>>");
  });

  it("passes structured data forward with its type intact", async () => {
    const spec = workflow({
      name: "typed",
      steps: [
        { id: "draft", ask: "write" },
        { id: "send", use: "mail.send", with: { body: "{{draft}}" } },
      ],
    });

    await startRun(spec, {}, deps(() => answer("text", { title: "Hi" })));
    expect(tooled).toEqual([{ ref: "mail.send", args: { body: { title: "Hi" } } }]);
  });

  it("iterates an each step and binds the item", async () => {
    const spec = workflow({
      name: "loop",
      steps: [{ id: "all", each: "{{items}}", as: "row", do: [{ id: "one", ask: "see {{row}}" }] }],
    });

    const run = await startRun(spec, { items: ["a", "b"] }, deps((i) => answer(i.toUpperCase())));
    expect(asked).toEqual(["see a", "see b"]);
    expect(run.result).toEqual(["SEE A", "SEE B"]);
  });

  it("respects an each limit", async () => {
    const spec = workflow({
      name: "capped",
      steps: [{ id: "all", each: "{{items}}", max: 1, do: [{ id: "one", ask: "{{item}}" }] }],
    });
    await startRun(spec, { items: ["a", "b", "c"] }, deps((i) => answer(i)));
    expect(asked).toEqual(["a"]);
  });

  it("takes the matching branch of a when step", async () => {
    const spec = workflow({
      name: "branch",
      steps: [
        {
          id: "route",
          when: "{{kind}}",
          is: { refund: [{ id: "r", ask: "refund path" }] },
          otherwise: [{ id: "o", ask: "other path" }],
        },
      ],
    });

    await startRun(spec, { kind: "refund" }, deps((i) => answer(i)));
    expect(asked).toEqual(["refund path"]);

    asked = [];
    await startRun(spec, { kind: "question" }, deps((i) => answer(i)));
    expect(asked).toEqual(["other path"]);
  });

  it("records a failure rather than throwing", async () => {
    const spec = workflow({ name: "boom", steps: [{ id: "x", ask: "go" }] });
    const broken: WorkflowDeps = {
      ...deps(() => answer("")),
      harness: {
        name: "stub",
        ask: async () => {
          throw new Error("provider down");
        },
      },
    };
    const run = await startRun(spec, {}, broken);
    expect(run.status).toBe("failed");
    expect(run.error).toBe("provider down");
  });
});

describe("approval", () => {
  const spec = workflow({
    name: "gated",
    steps: [
      { id: "draft", ask: "draft it" },
      { id: "ok", approve: "Send {{draft}}?" },
      { id: "send", ask: "send it" },
    ],
  });

  it("suspends at the gate with the interpolated prompt", async () => {
    const run = await startRun(spec, {}, deps((i) => answer(`[${i}]`)));
    expect(run.status).toBe("waiting");
    expect(run.waitingFor).toEqual({ step: "ok", prompt: "Send [draft it]?" });
    expect(asked).toEqual(["draft it"]);
  });

  it("replays completed steps instead of re-running them", async () => {
    const first = await startRun(spec, {}, deps((i) => answer(`[${i}]`)));
    asked = [];

    const resumed = await resumeRun(first.id, { approved: true }, spec, deps((i) => answer(`[${i}]`)));

    expect(resumed.status).toBe("done");
    expect(asked).toEqual(["send it"]);
    expect(resumed.result).toBe("[send it]");
  });

  it("ends the run on rejection without running the rest", async () => {
    const first = await startRun(spec, {}, deps((i) => answer(i)));
    asked = [];

    const resumed = await resumeRun(
      first.id,
      { approved: false, note: "not yet" },
      spec,
      deps((i) => answer(i)),
    );

    expect(resumed.status).toBe("done");
    expect(resumed.result).toEqual({ approved: false, note: "not yet" });
    expect(asked).toEqual([]);
    expect(resumed.events.at(-1)).toMatchObject({ step: "ok", detail: "rejected" });
  });

  it("refuses to resume a run that is not waiting", async () => {
    const done = await startRun(
      workflow({ name: "quick", steps: [{ id: "a", ask: "x" }] }),
      {},
      deps((i) => answer(i)),
    );
    await expect(resumeRun(done.id, { approved: true }, spec, deps((i) => answer(i)))).rejects.toThrow(
      /not waiting/,
    );
  });
});

describe("the outcome a workflow declares", () => {
  const spec = (outcome: WorkflowSpec["outcome"]) =>
    workflow({ name: "graded", steps: [{ id: "draft", ask: "write it" }], outcome });

  /** Answers the draft normally, and the judge with the verdict given. */
  const verdict = (holds: boolean, why = "because") =>
    deps((input) => (input.startsWith("The claim:") ? answer("", { holds, why }) : answer("a draft")));

  it("reports done when what was asked for is there", async () => {
    const run = await startRun(spec({ asks: "Is there a draft?" }), {}, verdict(true));
    expect(run.status).toBe("done");
    expect(run.outcome).toEqual({ held: true, reasons: ["held"] });
  });

  it("does not report done merely because every step ran", async () => {
    const run = await startRun(spec({ asks: "Is there a draft?" }), {}, verdict(false, "no draft"));
    expect(run.status).toBe("failed");
    expect(run.outcome?.held).toBe(false);
    expect(run.error).toContain("no draft");
  });

  it("holds only when every one of several outcomes holds", async () => {
    const both: WorkflowSpec["outcome"] = [
      { equals: "{{draft}}", to: "a draft" },
      { equals: "{{draft}}", to: "something else" },
    ];
    const run = await startRun(spec(both), {}, verdict(true));
    expect(run.status).toBe("failed");
    expect(run.outcome?.reasons[0]).toBe("held");
    expect(run.outcome?.reasons[1]).toContain("something else");
  });

  it("says nothing about an outcome that was never declared", async () => {
    const run = await startRun(spec(undefined), {}, verdict(false));
    expect(run.status).toBe("done");
    expect(run.outcome).toBeUndefined();
  });

  it("fails the outcome rather than passing it when the judge did not answer in shape", async () => {
    const loose = deps((input) => (input.startsWith("The claim:") ? answer("yes, clearly") : answer("d")));
    const run = await startRun(spec({ asks: "Is there a draft?" }), {}, loose);
    expect(run.status).toBe("failed");
    expect(run.outcome?.held).toBe(false);
  });

  it("puts the question to something carrying none of the work's equipment", async () => {
    const rich: AgentPlan = {
      ...plan,
      instructions: "You are a persuasive copywriter. Always defend your draft.",
      services: [{ name: "web" }] as unknown as AgentPlan["services"],
      locals: [{ name: "lookup" }] as unknown as AgentPlan["locals"],
      memory: true,
      memoryStore: "notes",
    };
    const graded: WorkflowDeps = { ...verdict(true), planFor: async () => rich };

    await startRun(spec({ asks: "Is there a draft?" }), {}, graded);

    const judgePlan = plans.at(-1)!;
    expect(judgePlan.services).toEqual([]);
    expect(judgePlan.locals).toEqual([]);
    expect(judgePlan.memory).toBe(false);
    expect(judgePlan.memoryStore).toBeUndefined();
    expect(judgePlan.instructions).not.toContain("copywriter");
    expect(judgePlan.returns).toMatchObject({ holds: expect.any(String) });
  });

  it("shows the judge what came out and not how it was arrived at", async () => {
    await startRun(spec({ asks: "Is there a draft?" }), { topic: "otters" }, verdict(true));
    const question = asked.at(-1)!;
    expect(question).toContain("Is there a draft?");
    expect(question).toContain("a draft");
    expect(question).toContain("otters");
    expect(question).not.toContain("write it");
  });
});

/**
 * An agent's output shape is a default for its steps, not a property of it.
 *
 * The same agent is routinely asked for a judgement at one step and for prose at
 * another. A shape declared once on the agent reaches both, and the step that
 * wanted prose gets a form to fill in without anything reporting that it did —
 * it still answers, still costs, and still looks like an answer.
 */
describe("an output shape asked for by the step", () => {
  const shaped: AgentPlan = {
    ...plan,
    instructions:
      'You judge things.\n\nReply with JSON in exactly this shape, and nothing else:\n{\n  "passed": whether it holds\n}',
    returns: { passed: "whether it holds" },
  };
  const withShaped = (reply: (input: string) => Answer): WorkflowDeps => ({
    ...deps(reply),
    planFor: async () => shaped,
  });

  it("replaces the agent's shape rather than asking for both", async () => {
    const spec = workflow({
      name: "reshaped",
      steps: [{ id: "a", ask: "x", returns: { verdict: "yes or no", why: "one sentence" } }],
    });
    await startRun(spec, {}, withShaped(() => answer("{}", {})));

    const given = plans.at(-1)!;
    expect(given.returns).toEqual({ verdict: "yes or no", why: "one sentence" });
    expect(given.instructions).toContain('"verdict"');
    expect(given.instructions).toContain("You judge things.");
    // The one that matters: two shapes in one prompt is a prompt with no shape.
    expect(given.instructions).not.toContain('"passed"');
    expect(given.instructions.match(/Reply with JSON/g)).toHaveLength(1);
  });

  it("leaves a step that asks for nothing on the agent's own shape", async () => {
    const spec = workflow({ name: "inherited", steps: [{ id: "a", ask: "x" }] });
    await startRun(spec, {}, withShaped(() => answer("{}", {})));

    expect(plans.at(-1)!.returns).toEqual({ passed: "whether it holds" });
  });

  it("shapes a step whose agent declared none", async () => {
    const spec = workflow({
      name: "fresh",
      steps: [{ id: "a", ask: "x", returns: { verdict: "yes or no" } }],
    });
    await startRun(spec, {}, deps(() => answer("{}", {})));

    const given = plans.at(-1)!;
    expect(given.returns).toEqual({ verdict: "yes or no" });
    expect(given.instructions).toContain('"verdict"');
  });

  it("shapes each step of a run separately", async () => {
    const spec = workflow({
      name: "mixed",
      steps: [
        { id: "commit", ask: "What would a right answer look like?" },
        { id: "judge", ask: "Now judge it", returns: { passed: "true or false" } },
      ],
    });
    await startRun(spec, {}, withShaped(() => answer("{}", {})));

    expect(plans[0]!.returns).toEqual({ passed: "whether it holds" });
    expect(plans[1]!.returns).toEqual({ passed: "true or false" });
    expect(plans[1]!.instructions).toContain("true or false");
  });
});

describe("RunStore", () => {
  it("round-trips a run and lists it", async () => {
    const run = await startRun(
      workflow({ name: "saved", steps: [{ id: "a", ask: "x" }] }),
      {},
      deps((i) => answer(i)),
    );
    expect(await store.load(run.id)).toMatchObject({ id: run.id, status: "done" });
    expect((await store.list()).map((r) => r.id)).toContain(run.id);
  });
});

describe("running a verify command", () => {
  it("leaves no timer behind when the command does not exist", async () => {
    // The failure this covers: `spawn`'s own timeout option arms a timer that
    // is not cleared when the spawn fails, so a missing verify command left one
    // live timer per attempt and the process never exited. Observed on a real
    // run — three retries, three timers, a finished run that would not end.
    const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    const result = await runCommand("definitely-not-a-real-command", { timeout: 30_000 });
    expect(result.ok).toBe(false);
    const after = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    // Not equality: vitest has timers of its own that start and expire during
    // the call. The invariant is that this must not ADD one.
    expect(after, "a failed spawn must not leave its kill-timer pending").toBeLessThanOrEqual(before);
  });

  it("still reports a real command's exit status", async () => {
    expect((await runCommand("/usr/bin/true", { timeout: 30_000 })).ok).toBe(true);
    expect((await runCommand("/usr/bin/false", { timeout: 30_000 })).ok).toBe(false);
  });

  it("times out a command that will not finish, and clears up after itself", async () => {
    const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    const result = await runCommand("/bin/sleep 30", { timeout: 250 });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("timed out");
    const after = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    expect(after).toBeLessThanOrEqual(before);
  });
});

describe("exactly-once side effects", () => {
  it("passes a stable derived idempotency key to a use step and clears inflight on success", async () => {
    const spec = workflow({ name: "pay", steps: [{ id: "charge", use: "billing.charge", with: { amount: 100 } }] });
    let seenKey: string | undefined;
    const base = deps(() => answer("x"));
    const run = await startRun(spec, {}, {
      ...base,
      callTool: async (_ref, _args, opts) => { seenKey = opts?.idempotencyKey; return { ok: true }; },
    });
    expect(run.status).toBe("done");
    expect(seenKey).toMatch(/^idem-/); // a stable, derived key reached the tool
    expect((await store.load(run.id))?.inflight).toBeUndefined(); // cleared once the effect returned
  });

  it("persists inflight BEFORE the effect, so an interrupted side effect is detectable and not silently re-run", async () => {
    const spec = workflow({ name: "pay", steps: [{ id: "charge", use: "billing.charge", with: { amount: 100 } }] });
    const base = deps(() => answer("x"));
    const run = await startRun(spec, {}, {
      ...base,
      callTool: async () => { throw new Error("network died mid-charge"); },
    });
    expect(run.status).toBe("failed");
    const loaded = await store.load(run.id);
    expect(loaded?.inflight?.step).toBe("charge"); // marker survives the crash — the exactly-once evidence
    expect("charge" in (loaded?.outputs ?? {})).toBe(false); // the step never completed
  });
});

describe("approval governance", () => {
  it("records a non-repudiable approval with a signature", async () => {
    const spec = workflow({ name: "gate", steps: [{ id: "ok", approve: "Ship it?" }, { id: "after", ask: "done" }] });
    const first = await startRun(spec, {}, deps(() => answer("x")));
    expect(first.status).toBe("waiting");
    const resumed = await resumeRun(first.id, { approved: true, approver: "cfo@acme" }, spec, deps(() => answer("x")));
    expect(resumed.status).toBe("done");
    expect(resumed.approvals?.[0]).toMatchObject({ step: "ok", approver: "cfo@acme" });
    expect(resumed.approvals?.[0].signature).toMatch(/^sig-stub:/);
  });

  it("a quorum needs two DISTINCT approvers before the run proceeds (two-person rule)", async () => {
    const spec = workflow({
      name: "wire",
      steps: [{ id: "big", approve: "Wire $50k?", requires: { quorum: 2 } }, { id: "after", ask: "done" }],
    });
    const first = await startRun(spec, {}, deps(() => answer("x")));
    expect(first.status).toBe("waiting");
    const one = await resumeRun(first.id, { approved: true, approver: "a@acme" }, spec, deps(() => answer("x")));
    expect(one.status).toBe("waiting"); // one signature is not enough
    expect(one.approvals?.length).toBe(1);
    await expect(
      resumeRun(first.id, { approved: true, approver: "a@acme" }, spec, deps(() => answer("x"))),
    ).rejects.toThrow(/distinct approvers/); // the same human can't be both
    const two = await resumeRun(first.id, { approved: true, approver: "b@acme" }, spec, deps(() => answer("x")));
    expect(two.status).toBe("done");
    expect(two.approvals?.length).toBe(2);
  });
});

describe("OTel GenAI emission", () => {
  it("emits standard-shaped invoke_agent and execute_tool spans with token attributes", async () => {
    const spec = workflow({
      name: "traced",
      steps: [{ id: "draft", ask: "write" }, { id: "send", use: "mail.send", with: { body: "{{draft}}" } }],
    });
    const spans: any[] = [];
    const base = deps(() => answer("hi"));
    await startRun(spec, {}, { ...base, emit: (s) => spans.push(s) });
    const ops = spans.map((s) => s.operation);
    expect(ops).toEqual(["invoke_agent", "execute_tool"]);
    expect(spans[0].attributes["gen_ai.operation.name"]).toBe("invoke_agent");
    expect(spans[0].attributes).toHaveProperty("gen_ai.usage.input_tokens");
    expect(spans[1].attributes["gen_ai.tool.name"]).toBe("mail.send");
    expect(typeof spans[0].durationMs).toBe("number");
  });
});
