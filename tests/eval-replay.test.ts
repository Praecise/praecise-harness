/**
 * Evals from what really happened, and evals of what is happening now.
 *
 * Two claims carry the weight here. A replay runs no tool: the recorded result is what
 * the model reads, so a captured case cannot charge a card twice. And an online score
 * is behind the answer, never in front of it: the request has returned before a grader
 * is asked anything, and a grader that breaks breaks nothing else.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../src/cli/index.js";
import { agent, evaluation, fn, type EvaluationSpec, type Grader, type RecordedRun } from "../src/define.js";
import { evaluationFaults } from "../src/eval/defects.js";
import { EVALUATION_EVENT, scoreAnswer } from "../src/eval/online.js";
import {
  Recordings,
  casesFromRecordings,
  casesFromRuns,
  renderCapturedSuite,
  replayTape,
  type Recording,
} from "../src/eval/replay.js";
import { runEvaluation, type EvalTarget } from "../src/eval/run.js";
import type { CloudEvent } from "../src/events.js";
import type { Span } from "../src/harness/trace.js";
import type { Answer } from "../src/harness/types.js";
import { Notifier } from "../src/notify.js";
import { createApp } from "../src/sdk.js";
import type { Verdict } from "../src/workflow/judge.js";
import type { Run } from "../src/workflow/store.js";
import { FRAMEWORK, MODEL_ENV, cleanup, makeProject, stubModel, type Reply } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(cleanup));
});

const MODELS = {
  house: { url: "https://models.test", credential: "HOUSE_KEY", speaks: "messages" as const, fast: "small", balanced: "mid", best: "large" },
};

const answer = (over: Partial<Answer> = {}): Answer => ({
  text: "",
  path: [],
  usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0, decidingTokens: 0 },
  toolCalls: [],
  harness: "stub",
  ...over,
});

/** An app with one agent that looks stock up through a function, and a count of how often it ran. */
async function shop(replies: Reply[], more: { evals?: Record<string, EvaluationSpec>; options?: object; config?: object } = {}) {
  const root = await makeProject({});
  roots.push(root);
  const ran: unknown[] = [];
  const model = stubModel(replies);
  const app = await createApp(
    {
      root,
      config: { models: MODELS, ...more.config },
      agents: { clerk: agent({ name: "clerk", role: "Answer questions about stock.", tools: ["stock"] }) },
      functions: {
        stock: fn({
          description: "How many of an item are in stock.",
          input: { sku: "the item's code" },
          run: (input) => {
            ran.push(input);
            return { sku: input.sku, left: 7, note: "internal key sk-live_abcdef1234567890" };
          },
        }),
      },
      ...(more.evals ? { evals: more.evals } : {}),
    },
    { env: MODEL_ENV, fetch: model.fetch, ...more.options },
  );
  return { app, root, ran, model };
}

const LOOKUP: Reply = { text: "", tool: { name: "stock", args: { sku: "a1" } } };

describe("recording", () => {
  it("keeps the question, what each tool returned and the answer, after the answer is back", async () => {
    const kept: Recording[] = [];
    const { app, ran } = await shop([LOOKUP, { text: "There are 7 left." }], { options: { recorder: (r: Recording) => void kept.push(r) } });

    const said = await app.ask("clerk", "how many a1 are left?");
    expect(said.text).toBe("There are 7 left.");
    await app.settled();

    expect(ran).toHaveLength(1);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ agent: "clerk", input: "how many a1 are left?", answer: "There are 7 left." });
    expect(kept[0]!.tools).toHaveLength(1);
    expect(kept[0]!.tools[0]).toMatchObject({ name: "stock", args: { sku: "a1" } });
    expect(kept[0]!.tools[0]!.result).toContain('"left": 7');
    expect(kept[0]!.partial).toBeUndefined();
    await app.close();
  });

  it("marks a turn of a conversation as one that cannot be asked again as it stands", async () => {
    const kept: Recording[] = [];
    const { app } = await shop([{ text: "Yes." }], { options: { recorder: (r: Recording) => void kept.push(r) } });
    await app.ask("clerk", "and the blue one?", { thread: "t1" });
    await app.settled();
    expect(kept[0]!.partial).toContain("conversation");
    expect(casesFromRecordings(kept)).toMatchObject({ cases: [], skipped: [{ id: kept[0]!.id }] });
    await app.close();
  });

  it("a recorder that throws fails nothing, and is listed in problems", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { app } = await shop([{ text: "Seven." }], {
      options: {
        recorder: () => {
          throw new Error("disk full");
        },
      },
    });
    expect((await app.ask("clerk", "how many?")).text).toBe("Seven.");
    await app.settled();
    expect(app.problems.join("\n")).toContain("recording an exchange failed");
    expect(app.problems.join("\n")).toContain("disk full");
    await app.close();
  });

  it("with `record: true` writes files under the state directory, with credentials redacted", async () => {
    const { app, root } = await shop([LOOKUP, { text: "There are 7 left." }], { config: { record: true } });
    await app.ask("clerk", "how many a1 are left? my password=hunter2secret");
    await app.settled();

    const text = await readFile(join(root, ".praecise", "recordings", "clerk.jsonl"), "utf8");
    expect(text).toContain("how many a1 are left?");
    expect(text).not.toContain("sk-live_abcdef1234567890");
    expect(text).not.toContain("hunter2secret");
    expect(text).toContain("[redacted]");

    const captured = await app.capture("clerk");
    expect(captured.target).toEqual({ agent: "clerk" });
    expect(captured.cases).toHaveLength(1);
    expect(captured.cases[0]).toMatchObject({
      expect: [{ reference: "judge" }],
      recorded: { answer: "There are 7 left.", tools: [{ name: "stock", args: { sku: "a1" } }] },
    });
    expect((await app.capture("clerk", { mode: "exact" })).cases[0]!.expect).toEqual([{ reference: "exact" }]);
    await expect(app.capture("nobody")).rejects.toThrow(/no agent or workflow named "nobody"/);
    await app.close();
  });
});

describe("a replay tape", () => {
  it("answers by name and arguments, in the order recorded, and never passes a miss through", () => {
    const { tape, misses } = replayTape([
      { name: "stock", args: { sku: "a1" }, result: "7" },
      { name: "stock", args: { sku: "a1" }, result: "6" },
      { name: "refund", args: { id: 3 }, result: "Error: declined", failed: true },
    ]);
    expect(tape.play!({ name: "stock", args: { sku: "a1" } })).toEqual({ text: "7", failed: false });
    expect(tape.play!({ name: "stock", args: { sku: "a1" } })).toEqual({ text: "6", failed: false });
    // Asked a third time, the last thing it said stands.
    expect(tape.play!({ name: "stock", args: { sku: "a1" } })).toEqual({ text: "6", failed: false });
    expect(tape.play!({ name: "refund", args: { id: 3 } })).toEqual({ text: "Error: declined", failed: true });

    const missed = tape.play!({ name: "stock", args: { sku: "zz" } });
    expect(missed).toMatchObject({ failed: true });
    expect(missed!.text).toContain("Tools are not run during a replay");
    expect(misses).toEqual(["replay: stock was called with arguments the recorded run never used"]);
  });
});

describe("replaying a captured case", () => {
  const recorded: RecordedRun = {
    answer: "There are 7 left.",
    tools: [{ name: "stock", args: { sku: "a1" }, result: '{"sku":"a1","left":7}' }],
  };
  const suiteOf = (expect: Grader[], over: Partial<RecordedRun> = {}): Record<string, EvaluationSpec> => ({
    recorded: evaluation({
      agent: "clerk",
      cases: [{ name: "a1", input: "how many a1 are left?", expect, recorded: { ...recorded, ...over } }],
    }),
  });

  it("gives the model the recorded result and does not run the tool", async () => {
    const { app, ran, model } = await shop([LOOKUP, { text: "There are 7 left." }], { evals: suiteOf([{ reference: "exact" }]) });
    const report = await app.evaluate();
    expect(report).toMatchObject({ ok: true, passed: 1 });
    expect(ran).toHaveLength(0);
    // What the model was sent back for its call is the recording, word for word.
    expect(JSON.stringify(model.calls[1]!.body.messages)).toContain('{\\"sku\\":\\"a1\\",\\"left\\":7}');
    await app.close();
  });

  it("fails `exact` on a different answer, and names what was recorded", async () => {
    const { app } = await shop([LOOKUP, { text: "Seven remain." }], { evals: suiteOf([{ reference: "exact" }]) });
    const report = await app.evaluate();
    expect(report.ok).toBe(false);
    expect(report.suites[0]!.cases[0]!.reasons[0]!.reason).toContain("There are 7 left.");
    await app.close();
  });

  it("asks the judge only when the words differ, and shows it both answers", async () => {
    const same = await shop([LOOKUP, { text: "There are 7 left." }], { evals: suiteOf([{ reference: "judge" }]) });
    expect((await same.app.evaluate()).ok).toBe(true);
    expect(same.model.calls).toHaveLength(2);
    await same.app.close();

    const reworded = await shop(
      [LOOKUP, { text: "Seven remain." }, ...Array.from({ length: 6 }, () => ({ text: '{"holds": true, "why": "same count"}' }))],
      { evals: suiteOf([{ reference: "judge" }]) },
    );
    const report = await reworded.app.evaluate();
    expect(report).toMatchObject({ ok: true, passed: 1 });
    expect(report.judgeTokens).toBeGreaterThan(0);
    const asked = JSON.stringify(reworded.model.calls[2]!.body.messages);
    expect(asked).toContain("RECORDED ANSWER");
    expect(asked).toContain("There are 7 left.");
    expect(asked).toContain("Seven remain.");
    await reworded.app.close();
  });

  it("answers a call the recording does not hold with an error, runs nothing, and says so in the report", async () => {
    const { app, ran } = await shop(
      [{ text: "", tool: { name: "stock", args: { sku: "b2" } } }, { text: "I could not find out." }],
      { evals: suiteOf([{ reference: "exact" }]) },
    );
    const report = await app.evaluate();
    expect(report.ok).toBe(false);
    expect(ran).toHaveLength(0);
    const reasons = report.suites[0]!.cases[0]!.reasons.map((r) => r.reason).join("\n");
    expect(reasons).toContain("replay: stock was called with arguments the recorded run never used");
    await app.close();
  });
});

describe("the `reference` grader", () => {
  const target = (given: Partial<Answer>, verdict: Verdict = { holds: true, why: "" }): EvalTarget & { judged: string[][] } => {
    const judged: string[][] = [];
    return {
      judged,
      ask: async () => answer(given),
      run: async () => answer(given),
      judge: async (rubric, material) => {
        judged.push([rubric, material]);
        return verdict;
      },
    };
  };
  const one = (grader: Grader, recorded?: RecordedRun): EvaluationSpec => ({
    kind: "evaluation",
    name: "s",
    agent: "a",
    cases: [{ name: "c", input: "q", expect: [grader], ...(recorded ? { recorded } : {}) }],
  });

  it("compares a structured result field for field and asks nobody", async () => {
    const recorded = { answer: "{}", data: { total: 5, lines: [1, 2] } };
    const same = target({ data: { lines: [1, 2], total: 5 } });
    expect((await runEvaluation(one({ reference: "judge" }, recorded), same)).ok).toBe(true);
    expect(same.judged).toHaveLength(0);
    const off = await runEvaluation(one({ reference: "judge" }, recorded), target({ data: { total: 6, lines: [1, 2] } }));
    expect(off.cases[0]!.reasons[0]!.reason).toContain("where the recorded run gave");
  });

  it("an undecided judge leaves the case undecided, and a no fails it with the judge's reason", async () => {
    const recorded = { answer: "It ships Tuesday." };
    const unsure = await runEvaluation(one({ reference: "judge" }, recorded), target({ text: "Soon." }, { holds: false, why: "no date", unknown: true }));
    expect(unsure.cases[0]!.status).toBe("undecided");
    const no = await runEvaluation(one({ reference: "judge" }, recorded), target({ text: "It ships Friday." }, { holds: false, why: "the day changed" }));
    expect(no.cases[0]!.reasons[0]!.reason).toBe("differs from the recorded answer: the day changed");
  });

  it("is a fault on a case with nothing recorded, and in `online`", () => {
    expect(evaluationFaults("s", one({ reference: "judge" })).join("\n")).toContain("this case has none");
    expect(evaluationFaults("s", one({ reference: "loosely" as "judge" }, { answer: "x" })).join("\n")).toContain('"judge"');
    const live: EvaluationSpec = { kind: "evaluation", agent: "a", cases: [], online: { sample: 1, expect: [{ reference: "judge" }] } };
    expect(evaluationFaults("s", live).join("\n")).toContain("a live answer has none");
  });
});

describe("capturing", () => {
  it("turns finished workflow runs into cases and skips the ones that did not finish", () => {
    const run = (over: Partial<Run>): Run =>
      ({ id: "run-1", workflow: "sum", status: "done", input: { a: 2 }, usage: { inputTokens: 0, outputTokens: 0 }, events: [], startedAt: 1, updatedAt: 2, ...over }) as Run;
    const got = casesFromRuns([
      run({ result: { total: 5, key: "Bearer abcdef1234567890XYZ" } }),
      run({ id: "run-2", result: "five" }),
      run({ id: "run-3", status: "failed" }),
    ]);
    expect(got.cases).toHaveLength(2);
    expect(got.cases[0]!.recorded).toMatchObject({ data: { total: 5, key: "Bearer [redacted]" } });
    expect(got.cases[1]!.recorded).toEqual({ answer: "five", at: 1, id: "run-2" });
    expect(got.skipped).toEqual([{ id: "run-3", why: 'the run ended as "failed"' }]);
  });

  it("`praecise capture` writes a suite the loader reads back, and will not overwrite one", async () => {
    const root = await makeProject({
      "agents/clerk.ts": `import { agent } from "${FRAMEWORK}";
        export default agent({ role: "Answer questions about stock." });`,
    });
    roots.push(root);
    const kept = new Recordings(join(root, ".praecise", "recordings"));
    await kept.write({ id: "aaa111", at: 1, agent: "clerk", input: "how many a1?", answer: "7", tools: [{ name: "stock", args: { sku: "a1" }, result: "7" }] });
    await kept.write({ id: "bbb222", at: 2, agent: "clerk", input: "and b2?", answer: "3", tools: [], partial: "it was a turn of a conversation" });

    const lines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => (lines.push(String(chunk)), true));
    expect(await main(["capture", "clerk", "--dir", root])).toBe(0);
    expect(lines.join("")).toContain("evals/clerk-recorded.ts");
    expect(lines.join("")).toContain("bbb222");

    const file = join(root, "evals", "clerk-recorded.ts");
    const written = await readFile(file, "utf8");
    expect(written).toContain('agent: "clerk"');
    expect(written).toContain('"reference": "judge"');
    expect(written).not.toContain("and b2?");
    expect(await main(["capture", "clerk", "--dir", root])).toBe(1);
    expect(await main(["capture", "clerk", "--dir", root, "--last", "none"])).toBe(1);
    expect(await main(["capture", "--dir", root])).toBe(1);

    // The file is an ordinary suite: pointed at the framework, it loads with no faults.
    await writeFile(file, written.replace('"@praecise/harness"', JSON.stringify(FRAMEWORK)), "utf8");
    const { loadProject } = await import("../src/project/load.js");
    const project = await loadProject(root, { version: "rewritten" });
    expect(project.faults).toEqual([]);
    expect(project.evals!["clerk-recorded"]!.cases[0]).toMatchObject({ input: "how many a1?", recorded: { tools: [{ name: "stock" }] } });
  });

  it("renders a workflow suite that says its steps run for real", () => {
    const text = renderCapturedSuite({ workflow: "sum" }, [], { capturedAt: 0 });
    expect(text).toContain('workflow: "sum"');
    expect(text).toContain("1970-01-01");
    expect(text).toContain("its steps call what they call");
  });
});

describe("online evals", () => {
  const online = (expect: Grader[], more: object = {}): Record<string, EvaluationSpec> => ({
    live: evaluation({ agent: "clerk", cases: [], online: { sample: 1, expect, ...more } }),
  });

  it("scores after the answer is back, in the answer's own trace, as the GenAI evaluation event", async () => {
    const spans: Span[] = [];
    let release!: () => void;
    const held = new Promise<void>((done) => (release = done));
    let graded = false;
    const { app } = await shop([LOOKUP, { text: "There are 7 left." }], {
      evals: online([
        { contains: "7" },
        {
          check: async () => {
            await held;
            graded = true;
            return true;
          },
        },
      ]),
      options: { tracer: (span: Span) => void spans.push(span) },
    });

    const said = await app.ask("clerk", "how many a1 are left?");
    // The request is over and the grader has not finished: nothing waited for it.
    expect(said.text).toBe("There are 7 left.");
    expect(graded).toBe(false);
    expect(spans.some((span) => span.name.startsWith("evaluate"))).toBe(false);
    release();
    await app.settled();

    const root = spans.find((span) => span.name === "invoke_agent clerk")!;
    const scored = spans.find((span) => span.name === "evaluate live")!;
    expect(root).toBeDefined();
    expect(root.parentSpanId).toBeUndefined();
    expect(scored.traceId).toBe(root.traceId);
    expect(scored.parentSpanId).toBe(root.spanId);
    expect(scored.events).toHaveLength(1);
    expect(scored.events![0]!.name).toBe(EVALUATION_EVENT);
    expect(scored.events![0]!.attributes).toEqual({
      "gen_ai.evaluation.name": "live",
      "gen_ai.evaluation.score.value": 1,
      "gen_ai.evaluation.score.label": "pass",
    });
    // The model and tool calls of the answer sit in the same trace, under the request.
    const work = spans.filter((span) => span.name.startsWith("chat") || span.name.startsWith("execute_tool"));
    expect(work.length).toBeGreaterThanOrEqual(3);
    expect(work.every((span) => span.traceId === root.traceId && span.parentSpanId === root.spanId)).toBe(true);
    await app.close();
  });

  it("joins a trace the request arrived in, without a span of its own for the request", async () => {
    const spans: Span[] = [];
    const { app } = await shop([{ text: "Seven." }], {
      evals: online([{ contains: "Seven" }]),
      options: { tracer: (span: Span) => void spans.push(span) },
    });
    const trace = { traceId: "a".repeat(32), spanId: "b".repeat(16) };
    await app.ask("clerk", "how many?", { trace });
    await app.settled();
    expect(spans.some((span) => span.name.startsWith("invoke_agent"))).toBe(false);
    expect(spans.find((span) => span.name === "evaluate live")).toMatchObject({ traceId: trace.traceId, parentSpanId: trace.spanId });
    await app.close();
  });

  it("tells notify when a score is under the threshold, and tells it neither the question nor the answer", async () => {
    const events: CloudEvent[] = [];
    const spans: Span[] = [];
    const { app } = await shop([{ text: "I cannot help with that, sk-live_abcdef1234567890." }], {
      evals: online([{ excludes: "cannot" }, { contains: "help" }, { matches: "^Sorry" }], { threshold: 0.5 }),
      options: { tracer: (span: Span) => void spans.push(span), notify: (event: CloudEvent) => void events.push(event) },
    });
    await app.ask("clerk", "how many a1 are left?");
    await app.settled();

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("com.praecise.eval.below");
    const scored = spans.find((span) => span.name === "evaluate live")!;
    expect(events[0]!.data).toEqual({ suite: "live", agent: "clerk", score: 1 / 3, threshold: 0.5, trace: scored.traceId });
    expect(JSON.stringify(events[0])).not.toContain("cannot help");
    expect(JSON.stringify(events[0])).not.toContain("how many");
    expect(scored.attributes["gen_ai.evaluation.score.label"]).toBe("fail");
    expect(scored.attributes["gen_ai.evaluation.explanation"]).toContain('the answer contains "cannot"');
    await app.close();
  });

  it("at or above the threshold, and with a sample of zero, says nothing", async () => {
    const events: CloudEvent[] = [];
    const spans: Span[] = [];
    const options = { tracer: (span: Span) => void spans.push(span), notify: (event: CloudEvent) => void events.push(event) };
    const fine = await shop([{ text: "Seven." }], { evals: online([{ contains: "Seven" }], { threshold: 1 }), options });
    await fine.app.ask("clerk", "how many?");
    await fine.app.settled();
    expect(events).toHaveLength(0);
    expect(spans.filter((span) => span.name === "evaluate live")).toHaveLength(1);
    await fine.app.close();

    spans.length = 0;
    const off = await shop([{ text: "Seven." }], { evals: online([{ contains: "Seven" }], { sample: 0 }), options });
    await off.app.ask("clerk", "how many?");
    await off.app.settled();
    expect(spans.some((span) => span.name.startsWith("evaluate") || span.name.startsWith("invoke_agent"))).toBe(false);
    await off.app.close();
  });

  it("a grader that throws or cannot be decided fails no request and scores what could be decided", async () => {
    const scored = await scoreAnswer(
      "live",
      "clerk",
      {
        sample: 1,
        threshold: 1,
        expect: [
          { contains: "7" },
          { judge: "It is polite." },
          {
            check: () => {
              throw new Error("boom");
            },
          },
        ],
      },
      "q",
      answer({ text: "7 left" }),
      async () => {
        throw new Error("no model");
      },
    );
    expect(scored).toMatchObject({ score: 0.5, label: "fail", passed: 1, failed: 1, unknown: 1, below: true });
    expect(scored.reasons.join("\n")).toContain("could not be graded: no model");

    const none = await scoreAnswer("live", "clerk", { sample: 1, threshold: 1, expect: [{ judge: "x" }] }, "q", answer(), async () => ({ holds: false, why: "", unknown: true }));
    expect(none.score).toBeUndefined();
    expect(none).toMatchObject({ label: "unknown", below: false });
  });

  it("is checked like the rest of a suite, and a suite of only `online` has nothing for `praecise eval` to run", async () => {
    const bad: EvaluationSpec = { kind: "evaluation", workflow: "w", cases: [], online: { sample: 2, expect: [], threshold: 3 } };
    const faults = evaluationFaults("s", bad).join("\n");
    expect(faults).toContain("this suite tests a workflow");
    expect(faults).toContain("`online.sample` is 2");
    expect(faults).toContain("`online.threshold` is 3");
    expect(faults).toContain("`online` has no graders");
    expect(faults).not.toContain("has no cases");

    const { app } = await shop([], { evals: online([{ contains: "x" }]) });
    await expect(app.evaluate("live")).rejects.toThrow(/only scores live answers/);
    await expect(app.evaluate()).rejects.toThrow(/only score live answers/);
    await app.close();
  });

  it("a webhook's `events` may name the eval event, and still refuses one nobody sends", () => {
    const target = { url: "https://hooks.test/in", secret: "whsec_" + "a".repeat(32) };
    expect(() => new Notifier({ ...target, events: ["below", "com.praecise.run.failed"] }, { source: "/apps/x" })).not.toThrow();
    expect(() => new Notifier({ ...target, events: ["scored"] }, { source: "/apps/x" })).toThrow(/com\.praecise\.eval\.below/);
  });
});
