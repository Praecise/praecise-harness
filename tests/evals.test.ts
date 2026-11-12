/**
 * Evals: a suite of cases, each run some number of times and graded on what
 * came out.
 *
 * Most of this file drives the runner with a stub in place of the app, because
 * the claims worth testing are arithmetic and bookkeeping — what counts as a
 * pass, what an undecided judge does to a rate, what one trial may know about
 * another — and none of those needs a model to be wrong about.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../src/cli/index.js";
import type { AgentPlan } from "../src/compile/plan.js";
import { agent, evaluation, fn, workflow, type EvaluationSpec, type Grader } from "../src/define.js";
import { evaluationFaults } from "../src/eval/defects.js";
import { renderReport } from "../src/eval/report.js";
import { runEvaluation, runEvaluations, type EvalTarget } from "../src/eval/run.js";
import type { Answer, Harness } from "../src/harness/types.js";
import { loadProject } from "../src/project/load.js";
import { createApp, defineApp } from "../src/sdk.js";
import { judge, type Verdict } from "../src/workflow/judge.js";
import { FRAMEWORK, MODEL_ENV, cleanup, makeProject, stubModel } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(cleanup));
});

const answer = (over: Partial<Answer> = {}): Answer => ({
  text: "",
  path: [],
  usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0, decidingTokens: 0 },
  toolCalls: [],
  harness: "stub",
  ...over,
});

/** A target that answers from a function, and a judge that says whatever it is told to. */
function stub(
  ask: (input: string, call: number) => Answer | Promise<Answer>,
  verdict: Verdict = { holds: true, why: "" },
): EvalTarget & { asked: unknown[][]; judged: string[][] } {
  const asked: unknown[][] = [];
  const judged: string[][] = [];
  return {
    asked,
    judged,
    ask: async (...args: unknown[]) => {
      asked.push(args);
      return ask(String(args[1]), asked.length - 1);
    },
    run: async (_name, input) => ask(JSON.stringify(input), asked.push([_name, input]) - 1),
    judge: async (rubric, material, lender) => {
      judged.push([rubric, material, lender ?? ""]);
      return verdict;
    },
  };
}

const suite = (expect: Grader[], more: Partial<EvaluationSpec> = {}): EvaluationSpec => ({
  kind: "evaluation",
  name: "support",
  agent: "support",
  cases: [{ name: "the case", input: "a question", expect }],
  ...more,
});

/** Grade one answer against one grader, and say whether it passed and why not. */
async function graded(grader: Grader, given: Partial<Answer>, verdict?: Verdict) {
  const report = await runEvaluation(suite([grader]), stub(() => answer(given), verdict));
  const only = report.cases[0]!.trials[0]!;
  return { status: only.status, reason: only.reasons[0] ?? "" };
}

describe("a grader", () => {
  it("contains: every part has to be in the text", async () => {
    expect((await graded({ contains: "refund" }, { text: "a refund is due" })).status).toBe("passed");
    expect((await graded({ contains: ["refund", "today"] }, { text: "a refund is due today" })).status).toBe("passed");
    const missed = await graded({ contains: ["refund", "manager"] }, { text: "a refund is due" });
    expect(missed.status).toBe("failed");
    expect(missed.reason).toContain('"manager"');
    expect(missed.reason).not.toContain('"refund"');
  });

  it("excludes: none of the parts may be in the text", async () => {
    expect((await graded({ excludes: ["sorry", "cannot"] }, { text: "done" })).status).toBe("passed");
    const found = await graded({ excludes: ["sorry", "cannot"] }, { text: "sorry, no" });
    expect(found).toMatchObject({ status: "failed" });
    expect(found.reason).toContain('"sorry"');
  });

  it("matches: the text is tested against a regular expression source", async () => {
    expect((await graded({ matches: "^order #\\d{4}$" }, { text: "order #1234" })).status).toBe("passed");
    expect((await graded({ matches: "^order #\\d{4}$" }, { text: "order #12" })).status).toBe("failed");
  });

  it("equals: the structured result is compared deeply, and key order is not a difference", async () => {
    const data = { status: "paid", lines: [{ sku: "a", qty: 2 }] };
    expect((await graded({ equals: { lines: [{ qty: 2, sku: "a" }], status: "paid" } }, { data })).status).toBe("passed");
    expect((await graded({ equals: { status: "paid" } }, { data })).status).toBe("failed");
    expect((await graded({ equals: { status: "paid" } }, { text: '{"status":"paid"}' })).status).toBe("failed");
  });

  it("fields: a subset of the structured result, at any depth", async () => {
    const data = { status: "paid", customer: { id: 7, tier: "gold" }, lines: [1, 2] };
    expect((await graded({ fields: { status: "paid", customer: { tier: "gold" } } }, { data })).status).toBe("passed");
    const wrong = await graded({ fields: { customer: { tier: "silver" } } }, { data });
    expect(wrong.status).toBe("failed");
    expect(wrong.reason).toContain("customer.tier");
    // A list is compared whole: part of one is not a subset the grader can name.
    expect((await graded({ fields: { lines: [1] } }, { data })).status).toBe("failed");
    expect((await graded({ fields: { status: "paid" } }, { data: undefined })).status).toBe("failed");
  });

  it("calls and avoids: which tools were reached for, in any order", async () => {
    const toolCalls = [
      { name: "crm__lookup", args: {} },
      { name: "refund", args: {} },
    ];
    // Order is not graded: the outcome is that both were called.
    expect((await graded({ calls: ["refund", "crm.lookup"] }, { toolCalls })).status).toBe("passed");
    expect((await graded({ calls: "lookup" }, { toolCalls })).status).toBe("passed");
    const uncalled = await graded({ calls: ["refund", "escalate"] }, { toolCalls });
    expect(uncalled.status).toBe("failed");
    expect(uncalled.reason).toContain("escalate was not called");

    expect((await graded({ avoids: "delete_account" }, { toolCalls })).status).toBe("passed");
    const reached = await graded({ avoids: ["delete_account", "refund"] }, { toolCalls });
    expect(reached.status).toBe("failed");
    expect(reached.reason).toContain("refund was called");
  });

  it("judge: a rubric, put to the judge with the answer and nothing else", async () => {
    const target = stub(() => answer({ text: "We are sorry for the delay." }), { holds: true, why: "it apologises" });
    const report = await runEvaluation(suite([{ judge: "The reply apologises.", agent: "critic" }]), target);
    expect(report.cases[0]!.status).toBe("passed");
    expect(target.judged).toEqual([["The reply apologises.", "We are sorry for the delay.", "critic"]]);

    const refused = await graded({ judge: "The reply apologises." }, { text: "No." }, { holds: false, why: "no apology" });
    expect(refused).toEqual({ status: "failed", reason: "judged not to hold: no apology" });
  });

  it("check: code decides, and a returned string is the reason it failed", async () => {
    expect((await graded({ check: (a) => a.text.length > 2 }, { text: "long" })).status).toBe("passed");
    expect((await graded({ check: async (a, test) => a.text === test.input }, { text: "a question" })).status).toBe("passed");
    expect(await graded({ check: () => "the total is off by one" }, {})).toEqual({
      status: "failed",
      reason: "the total is off by one",
    });
    expect((await graded({ check: () => false }, {})).reason).toContain("returned false");
    expect((await graded({ check: () => { throw new Error("boom"); } }, {})).reason).toContain("boom");
  });

  it("reports every grader that did not hold, not only the first", async () => {
    const report = await runEvaluation(
      suite([{ contains: "refund" }, { excludes: "sorry" }, { matches: "sorry" }]),
      stub(() => answer({ text: "sorry" })),
    );
    expect(report.cases[0]!.trials[0]!.reasons).toHaveLength(2);
  });
});

describe("trials", () => {
  // Passes on the second ask only.
  const flaky = () => stub((_input, call) => answer({ text: call === 1 ? "right" : "wrong" }));

  it("pass@k is any trial and pass^k is every trial", async () => {
    const report = await runEvaluation(suite([{ contains: "right" }], { trials: 3 }), flaky(), { concurrency: 1 });
    const only = report.cases[0]!;
    expect(only).toMatchObject({ passed: 1, failed: 2, unknown: 0, passAny: true, passAll: false });
    expect(only.trials).toHaveLength(3);
    // The same reason from two trials is said once, with the count.
    expect(only.reasons).toEqual([{ reason: 'the answer does not contain "right"', trials: 2 }]);
    expect(only.tokens).toBe(45);
  });

  it("the bar decides which of the two a case is held to, and defaults to all", async () => {
    const strict = await runEvaluation(suite([{ contains: "right" }], { trials: 3 }), flaky(), { concurrency: 1 });
    expect(strict).toMatchObject({ bar: "all", ok: false, passed: 0, failed: 1 });
    expect(strict.cases[0]!.status).toBe("failed");

    const lenient = await runEvaluation(suite([{ contains: "right" }], { trials: 3, bar: "any" }), flaky(), {
      concurrency: 1,
    });
    expect(lenient).toMatchObject({ bar: "any", ok: true, passed: 1, failed: 0 });

    const steady = await runEvaluation(suite([{ contains: "r" }], { trials: 3 }), stub(() => answer({ text: "right" })));
    expect(steady.cases[0]).toMatchObject({ passed: 3, passAny: true, passAll: true, status: "passed" });
    expect(steady.ok).toBe(true);
  });

  it("an option overrides the suite's own count, and one trial makes the two rates agree", async () => {
    const target = flaky();
    const report = await runEvaluation(suite([{ contains: "right" }], { trials: 5 }), target, { trials: 1 });
    expect(target.asked).toHaveLength(1);
    expect(report.trials).toBe(1);
    expect(report.cases[0]!.passAny).toBe(report.cases[0]!.passAll);
  });

  it("runs no more than the concurrency allows at once", async () => {
    let inFlight = 0;
    let most = 0;
    const target = stub(async () => {
      most = Math.max(most, ++inFlight);
      await new Promise((go) => setTimeout(go, 5));
      inFlight--;
      return answer({ text: "ok" });
    });
    const spec = suite([{ contains: "ok" }], {
      trials: 4,
      cases: ["a", "b", "c"].map((name) => ({ name, input: name, expect: [{ contains: "ok" }] })),
    });
    const report = await runEvaluation(spec, target, { concurrency: 2 });
    expect(target.asked).toHaveLength(12);
    expect(most).toBe(2);
    expect(report.ok).toBe(true);
  });

  it("a trial that throws is a failed trial with the reason, not a crashed run", async () => {
    const report = await runEvaluation(
      suite([{ contains: "x" }]),
      stub(() => {
        throw new Error("the model endpoint refused");
      }),
    );
    expect(report.cases[0]!.trials[0]).toMatchObject({ status: "failed", reasons: ["no answer: the model endpoint refused"] });
  });

  it("placeholder text is never graded as an answer", async () => {
    const report = await runEvaluation(
      suite([{ contains: "placeholder" }]),
      stub(() => answer({ text: "this is a placeholder response", placeholder: true })),
    );
    expect(report.ok).toBe(false);
    expect(report.cases[0]!.reasons[0]!.reason).toContain("no model was reached");
  });

  it("--bail stops starting trials once a case has missed its bar", async () => {
    const target = stub(() => answer({ text: "wrong" }));
    const spec = suite([], {
      trials: 3,
      cases: ["a", "b"].map((name) => ({ name, input: name, expect: [{ contains: "right" }] })),
    });
    const report = await runEvaluations([spec, { ...spec, name: "second" }], target, { bail: true, concurrency: 1 });
    expect(target.asked).toHaveLength(1);
    expect(report.suites).toHaveLength(1);
    expect(report.suites[0]!.cases.map((c) => c.status)).toEqual(["failed", "skipped"]);
    expect(report).toMatchObject({ ok: false, bailed: true });
  });
});

describe("a judge that cannot tell", () => {
  const unknown: Verdict = { holds: false, why: "the reply does not mention a date", unknown: true, tokens: 7 };

  it("counts as neither a pass nor a failure, and is reported on its own", async () => {
    const report = await runEvaluation(
      suite([{ contains: "refund" }, { judge: "The date given is correct." }], { trials: 2 }),
      stub(() => answer({ text: "a refund" }), unknown),
    );
    const only = report.cases[0]!;
    expect(only).toMatchObject({ passed: 0, failed: 0, unknown: 2, passAny: false, passAll: false, status: "undecided" });
    expect(only.reasons[0]!.reason).toContain("could not tell: the reply does not mention a date");
    expect(only.judgeTokens).toBe(14);
    // Nothing failed, and nothing was shown to pass either: not a green run.
    expect(report).toMatchObject({ ok: false, failed: 0, undecided: 1 });
    expect(renderReport({ suites: [report], cases: 1, passed: 0, tokens: 30, judgeTokens: 14, durationMs: 1, ok: false }).join("\n"))
      .toContain("2 of 2 could not be judged");
  });

  it("is left out of the rate rather than counted against it", async () => {
    let call = 0;
    const target = stub(() => answer({ text: "a refund" }));
    target.judge = async () => (call++ === 0 ? unknown : { holds: true, why: "" });
    const report = await runEvaluation(suite([{ judge: "The date given is correct." }], { trials: 3 }), target, {
      concurrency: 1,
    });
    expect(report.cases[0]).toMatchObject({ passed: 2, failed: 0, unknown: 1, passAll: true, status: "passed" });
  });

  it("a failure beside it is still a failure", async () => {
    const mixed = await graded({ judge: "x" }, { text: "" }, unknown);
    expect(mixed.status).toBe("unknown");
    const report = await runEvaluation(
      suite([{ contains: "refund" }, { judge: "x" }]),
      stub(() => answer({ text: "nothing" }), unknown),
    );
    expect(report.cases[0]!.status).toBe("failed");
  });

  it("is the workflows' own judge, allowed a third answer only when asked", async () => {
    const plan = { name: "critic", instructions: "be a critic", services: [], locals: [] } as unknown as AgentPlan;
    const seen: AgentPlan[] = [];
    const harness = (data: unknown): Harness => ({
      name: "stub",
      ask: async (given) => {
        seen.push(given);
        return answer({ data });
      },
    });

    const abstained = await judge(harness({ unknown: true, why: "no date" }), plan, "claim", "material", { abstain: true });
    expect(abstained).toMatchObject({ holds: false, unknown: true, why: "no date", tokens: 15 });
    expect(seen[0]!.instructions).toContain('"unknown": true');
    expect(seen[0]!.returns).toHaveProperty("unknown");

    // A workflow has to decide, so the same reply there is simply not a yes.
    const forced = await judge(harness({ unknown: true, why: "no date" }), plan, "claim", "material");
    expect(forced.holds).toBe(false);
    expect(forced.unknown).toBeUndefined();
    expect(seen[1]!.instructions).not.toContain('"unknown": true');
    expect(seen[1]!.returns).not.toHaveProperty("unknown");

    // A judge that came back out of shape judged nothing — unknown, where that can be said.
    expect((await judge(harness("prose"), plan, "claim", "material", { abstain: true })).unknown).toBe(true);
  });
});

describe("a budget", () => {
  it("fails a trial that spends more tokens than the case allows", async () => {
    const spec = suite([], {
      cases: [
        { name: "cheap", input: "q", expect: [{ contains: "ok" }], budget: { tokens: 15 } },
        { name: "dear", input: "q", expect: [{ contains: "ok" }], budget: { tokens: 14 } },
      ],
    });
    const report = await runEvaluation(spec, stub(() => answer({ text: "ok" })));
    expect(report.cases.map((c) => c.status)).toEqual(["passed", "failed"]);
    expect(report.cases[1]!.reasons[0]!.reason).toBe("spent 15 tokens, over the budget of 14");
    expect(report).toMatchObject({ ok: false, tokens: 30 });
  });
});

describe("trial isolation", () => {
  it("the runner asks with an agent and an input, and has nothing else to pass", async () => {
    const target = stub(() => answer({ text: "ok" }));
    await runEvaluation(suite([{ contains: "ok" }], { trials: 3 }), target);
    expect(target.asked).toEqual(Array.from({ length: 3 }, () => ["support", "a question"]));
  });

  it("an agent with memory neither reads an earlier trial nor leaves one behind", async () => {
    const root = await makeProject({});
    roots.push(root);
    const model = stubModel(Array.from({ length: 40 }, () => ({ text: "the answer is 42" })));
    const app = await createApp(
      {
        root,
        config: {
          models: {
            house: { url: "https://models.test", credential: "HOUSE_KEY", speaks: "messages", fast: "small", balanced: "mid", best: "large" },
          },
        },
        // Named, because the record is kept under the agent's own name rather than its key.
        agents: { oracle: agent({ name: "oracle", role: "Answer the question.", memory: true }) },
        evals: {
          oracle: evaluation({
            agent: "oracle",
            trials: 3,
            cases: [{ name: "knows it", input: "what is the answer?", expect: [{ contains: "42" }] }],
          }),
        },
      },
      { env: MODEL_ENV, fetch: model.fetch },
    );

    const report = await app.evaluate();
    expect(report).toMatchObject({ ok: true, cases: 1, passed: 1 });
    expect(report.suites[0]).toMatchObject({ suite: "oracle", trials: 3 });

    // Nothing was kept, so nothing can be recalled into the next trial or the next real ask.
    expect(await app.recorded("oracle")).toEqual([]);
    // And no request carried a conversation: each was the one question, asked cold.
    for (const call of model.calls) expect(call.body.messages).toHaveLength(1);
    expect(JSON.stringify(model.calls.at(-1)!.body)).not.toContain("the answer is 42");

    // The agent itself is untouched: asked for real, it remembers as it was declared to.
    await app.ask("oracle", "what is the answer?");
    expect(await app.recorded("oracle")).toHaveLength(1);
    await app.close();
  });
});

describe("what the loader refuses", () => {
  const agents = { support: agent({ role: "Help customers with their orders." }) };
  const faultsOf = (evals: Record<string, EvaluationSpec>) => defineApp({ agents, evals }).faults ?? [];
  const cases = [{ name: "one", input: "q", expect: [{ contains: "x" }] }];

  it("a suite that names a target the app does not have", () => {
    expect(faultsOf({ a: evaluation({ agent: "suport", cases }) })).toEqual([
      'eval "a": tests unknown agent "suport" (known: support)',
    ]);
    expect(faultsOf({ a: evaluation({ workflow: "triage", cases: [{ name: "one", input: {}, expect: [{ equals: 1 }] }] }) })[0])
      .toContain('tests unknown workflow "triage"');
    expect(faultsOf({ a: { kind: "evaluation", cases } })[0]).toContain("names nothing to test");
    expect(faultsOf({ a: { kind: "evaluation", agent: "support", workflow: "w", cases } })[0]).toContain("both");
  });

  it("a suite with no cases", () => {
    expect(faultsOf({ a: evaluation({ agent: "support", cases: [] }) })).toEqual([
      'eval "a": has no cases, so it would pass without testing anything; add one to `cases`',
    ]);
  });

  it("a case with no graders", () => {
    expect(faultsOf({ a: evaluation({ agent: "support", cases: [{ name: "one", input: "q", expect: [] }] }) })).toEqual([
      'eval "a": case "one" has no graders, so every answer would pass; say what has to be true in `expect`',
    ]);
  });

  it("graders, inputs and settings that cannot mean anything", () => {
    const bad = (expect: unknown[], more: Partial<EvaluationSpec> = {}) =>
      evaluationFaults("a", { kind: "evaluation", agent: "support", cases: [{ name: "one", input: "q", expect: expect as Grader[] }], ...more }, {
        agents: ["support"],
        workflows: [],
      }).join("\n");

    expect(bad([{ contain: "x" }])).toContain("grader 1 is none of contains, excludes");
    expect(bad([{ contains: "x", excludes: "y" }])).toContain("contains and excludes at once");
    expect(bad([{ matches: "(" }])).toContain("is not a regular expression");
    expect(bad([{ judge: "is it kind?", agent: "critic" }])).toContain('`judge` names unknown agent "critic"');
    expect(bad([{ contains: "x" }], { trials: 0 })).toContain("`trials` is 0");
    expect(bad([{ contains: "x" }], { bar: "most" as "all" })).toContain('`bar` is "most"');
    expect(evaluationFaults("a", { kind: "evaluation", agent: "support", cases: [{ name: "one", input: {}, expect: [{ equals: 1 }] }] }).join())
      .toContain("has to be a non-empty string");
    expect(bad([{ contains: "x" }])).toBe("");
  });

  it("a faulted suite is refused by the code door and by the runner", async () => {
    await expect(createApp({ agents, evals: { a: evaluation({ agent: "support", cases: [] }) } })).rejects.toThrow(/has no cases/);
    await expect(runEvaluation(suite([]), stub(() => answer()))).rejects.toThrow(/has no graders/);
  });

  it("reads evals/ from a folder, naming each suite after its file", async () => {
    const root = await makeProject({
      "agents/support.ts": `import { agent } from "${FRAMEWORK}";
        export default agent({ role: "Help customers with their orders." });`,
      "evals/refunds.ts": `import { evaluation } from "${FRAMEWORK}";
        export default evaluation({ agent: "support", cases: [{ name: "one", input: "q", expect: [{ contains: "x" }] }] });`,
      "evals/empty.ts": `import { evaluation } from "${FRAMEWORK}";
        export default evaluation({ agent: "nobody", cases: [] });`,
      "evals/wrong.ts": `import { agent } from "${FRAMEWORK}";
        export default agent({ role: "Not an eval." });`,
    });
    roots.push(root);

    const project = await loadProject(root);
    expect(Object.keys(project.evals ?? {}).sort()).toEqual(["empty", "refunds"]);
    expect(project.evals!.refunds).toMatchObject({ kind: "evaluation", name: "refunds", agent: "support" });
    const faults = (project.faults ?? []).join("\n");
    expect(faults).toContain('eval "empty": tests unknown agent "nobody"');
    expect(faults).toContain('eval "empty": has no cases');
    expect(faults).toContain("expected `export default evaluation({ ... })`, got a agent");
    expect(faults).not.toContain('eval "refunds"');
  });
});

describe("praecise eval", () => {
  /** A workflow that only calls a function, so the command runs end to end with no model. */
  const project = (total: number) =>
    makeProject({
      "functions/add.ts": `import { fn } from "${FRAMEWORK}";
        export default fn({
          description: "Add two numbers and return the total.",
          input: { a: "the first number", b: "the second number" },
          run: ({ a, b }) => ({ total: Number(a) + Number(b) }),
        });`,
      "workflows/sum.ts": `import { workflow } from "${FRAMEWORK}";
        export default workflow({
          description: "Add two numbers and return the total.",
          input: { a: "the first number", b: "the second number" },
          steps: [{ id: "added", use: "add", with: { a: "{{a}}", b: "{{b}}" } }],
        });`,
      "evals/sum.ts": `import { evaluation } from "${FRAMEWORK}";
        export default evaluation({
          workflow: "sum",
          trials: 2,
          cases: [{
            name: "two and three",
            input: { a: 2, b: 3 },
            expect: [{ fields: { total: ${total} } }, { calls: "add" }, { check: (answer) => answer.usage.inputTokens === 0 }],
          }],
        });`,
    });

  const captured = (): string[] => {
    const lines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => (lines.push(String(chunk)), true));
    return lines;
  };

  it("exits 0 when every case meets its bar, and prints the table", async () => {
    const root = await project(5);
    roots.push(root);
    const lines = captured();
    expect(await main(["eval", "--dir", root])).toBe(0);
    const printed = lines.join("");
    expect(printed).toContain("sum · workflow sum · 2 trials · bar: all");
    expect(printed).toContain("pass@k");
    expect(printed).toContain("✓ two and three");
    expect(printed).toContain("1 of 1 case met the bar");
  });

  it("exits 1 when a case misses it, and says why", async () => {
    const root = await project(6);
    roots.push(root);
    const lines = captured();
    expect(await main(["eval", "sum", "--dir", root, "--trials", "1"])).toBe(1);
    const printed = lines.join("");
    expect(printed).toContain("✗ two and three");
    expect(printed).toContain("1× the result's total is not what was expected");
  });

  it("--json prints the report, and the exit code still gates", async () => {
    const root = await project(6);
    roots.push(root);
    const lines = captured();
    expect(await main(["eval", "--dir", root, "--json", "--bail"])).toBe(1);
    const report = JSON.parse(lines.join("")) as { ok: boolean; bailed?: boolean; suites: { cases: { failed: number }[] }[] };
    expect(report).toMatchObject({ ok: false, bailed: true });
    // Trials already in flight when the first one failed are allowed to finish.
    expect(report.suites[0]!.cases[0]!.failed).toBeGreaterThanOrEqual(1);
  });

  it("exits 1 for an unknown suite, a bad --trials, and an app with no evals", async () => {
    const root = await project(5);
    const bare = await makeProject({});
    roots.push(root, bare);
    const lines = captured();
    expect(await main(["eval", "nope", "--dir", root])).toBe(1);
    expect(lines.join("")).toContain('no eval named "nope" (known: sum)');
    expect(await main(["eval", "--dir", root, "--trials", "many"])).toBe(1);
    expect(await main(["eval", "--dir", bare])).toBe(1);
    expect(lines.join("")).toContain("this app has no evals");
  });

  it("is a built-in, so a plugin of the same name cannot take it over", async () => {
    const root = await project(5);
    roots.push(root);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      `${root}/praecise.config.ts`,
      `import { defineConfig } from "${FRAMEWORK}";
       export default defineConfig({ plugins: [{ name: "eval", commands: { sum: { describe: "hijack", run: () => 7 } } }] });`,
    );
    captured();
    expect(await main(["eval", "sum", "--dir", root])).toBe(0);
  });

  it("is listed in the usage", async () => {
    const lines = captured();
    await main(["help"]);
    expect(lines.join("")).toMatch(/praecise eval.*\[suite\]/);
    expect(lines.join("")).toContain("--trials <n>");
    expect(lines.join("")).toContain("--bail");
  });
});

// The declarations are values like any other, so a suite can be built in code.
describe("evaluation()", () => {
  it("stamps the kind and keeps what was written", () => {
    const spec = evaluation({ agent: "support", bar: "any", trials: 3, cases: [{ name: "one", input: "q", expect: [{ contains: "x" }] }] });
    expect(spec).toMatchObject({ kind: "evaluation", agent: "support", bar: "any", trials: 3 });
    // Unused here, and imported so the workflow and function helpers are typechecked beside it.
    expect(typeof workflow).toBe("function");
    expect(typeof fn).toBe("function");
  });
});
