/**
 * Running eval suites: every case, some number of times, graded on what came out.
 *
 * Pure. The runner is handed something to ask, something to run and something
 * to judge with, and knows nothing about models, folders or state — which is
 * what lets it be tested without any of them, and what keeps a trial from
 * reaching for a conversation: `ask` here takes an agent and an input and has
 * no parameter a thread could be passed through.
 *
 * Two numbers come back for every case, because one is not enough. `pass@k` is
 * whether any trial passed — the agent CAN do this. `pass^k` is whether every
 * trial did — the agent DOES this. They agree at one trial and come apart with
 * every trial after it, and which one matters is the suite's `bar`.
 */

import type { EvalCase, EvaluationSpec } from "../define.js";
import { Gate } from "../gate.js";
import { money, spentIn, unpriced } from "../harness/cost.js";
import type { Answer } from "../harness/types.js";
import { evaluationFaults } from "./defects.js";
import { grade, type EvalJudge } from "./grade.js";

/** What the runner asks of whatever it is evaluating. */
export interface EvalTarget {
  /**
   * Ask an agent, once, as though for the first time: no conversation, and
   * nothing remembered from or for another trial.
   */
  ask(agent: string, input: string): Promise<Answer>;
  /** Run a workflow to its end and report what it produced, as an answer. */
  run(workflow: string, input: Record<string, unknown>): Promise<Answer>;
  /** Grade a rubric against an answer. May answer `unknown`. */
  judge: EvalJudge;
}

export interface EvalOptions {
  /** Run every case this many times, whatever the suite says. */
  trials?: number;
  /** How many trials may be in flight at once. Default 4. */
  concurrency?: number;
  /** Stop starting trials once a case has missed its bar. */
  bail?: boolean;
  /** Called as each case finishes, in the order they finish. */
  onCase?: (report: CaseReport, suite: string) => void;
}

export interface TrialReport {
  status: "passed" | "failed" | "unknown";
  /** Why, for each grader that did not pass. */
  reasons: string[];
  /** What the answer cost: tokens in and out. */
  tokens: number;
  /** What grading it cost, where a judge was asked. */
  judgeTokens: number;
  durationMs: number;
}

export interface CaseReport {
  name: string;
  /**
   * `undecided` is a case no trial failed and too few passed — every judge that
   * mattered answered "unknown". `skipped` is a case `bail` never started.
   */
  status: "passed" | "failed" | "undecided" | "skipped";
  trials: TrialReport[];
  passed: number;
  failed: number;
  /** Trials a judge could not decide. Counted in neither `passed` nor `failed`. */
  unknown: number;
  /** pass@k: at least one trial passed. */
  passAny: boolean;
  /** pass^k: every trial that was decided passed, and at least one was. */
  passAll: boolean;
  /** Each distinct reason a trial did not pass, with how many trials gave it. */
  reasons: { reason: string; trials: number }[];
  tokens: number;
  judgeTokens: number;
  durationMs: number;
}

export interface SuiteReport {
  suite: string;
  target: { agent: string } | { workflow: string };
  bar: "any" | "all";
  /** Trials per case. */
  trials: number;
  cases: CaseReport[];
  passed: number;
  failed: number;
  undecided: number;
  skipped: number;
  tokens: number;
  judgeTokens: number;
  durationMs: number;
  /** Every case met the bar. */
  ok: boolean;
}

export interface EvalReport {
  suites: SuiteReport[];
  cases: number;
  passed: number;
  tokens: number;
  judgeTokens: number;
  durationMs: number;
  /** Every case of every suite met its bar. What a CI gate reads. */
  ok: boolean;
  /** Set when `bail` stopped the run early, so the counts are not the whole suite. */
  bailed?: true;
}

const DEFAULT_CONCURRENCY = 4;

/** Ask once and grade the answer against everything the case expects. */
async function trial(spec: EvaluationSpec, test: EvalCase, target: EvalTarget): Promise<TrialReport> {
  const started = Date.now();
  const done = (status: TrialReport["status"], reasons: string[], tokens = 0, judgeTokens = 0): TrialReport => ({
    status,
    reasons,
    tokens,
    judgeTokens,
    durationMs: Date.now() - started,
  });

  let answer: Answer;
  try {
    answer =
      spec.agent !== undefined
        ? await target.ask(spec.agent, test.input as string)
        : await target.run(spec.workflow!, test.input as Record<string, unknown>);
  } catch (err) {
    return done("failed", [`no answer: ${(err as Error).message}`]);
  }

  const tokens = answer.usage.inputTokens + answer.usage.outputTokens;
  // Filler text can satisfy `contains` by accident and a judge by sounding
  // finished. Nothing answered, so there is nothing to grade.
  if (answer.placeholder) {
    return done(
      "failed",
      ["no model was reached, so the answer is placeholder text; set the model credential and run again"],
      tokens,
    );
  }

  const reasons: string[] = [];
  let unknown = false;
  let judgeTokens = 0;

  const ceiling = test.budget?.tokens;
  if (ceiling !== undefined && tokens > ceiling) {
    reasons.push(`spent ${tokens.toLocaleString("en")} tokens, over the budget of ${ceiling.toLocaleString("en")}`);
  }
  // A limit in money holds only against an answer that was priced in its currency;
  // one that was not is over a limit nobody could measure it against, and fails.
  const cap = test.budget?.spend;
  if (cap) {
    const blind = unpriced(answer.usage, cap);
    const paid = spentIn(answer.usage.cost, cap);
    if (blind) reasons.push(`cannot be held to a budget of ${money(cap.amount, cap.currency)}: ${blind}`);
    else if (paid > cap.amount) {
      reasons.push(`spent ${money(paid, cap.currency)}, over the budget of ${money(cap.amount, cap.currency)}`);
    }
  }
  let failed = reasons.length > 0;

  // Every grader is asked even after one fails: a report that names the first
  // problem only is a report that has to be re-run to find the second.
  for (const grader of test.expect) {
    const graded = await grade(grader, answer, test, target.judge);
    judgeTokens += graded.tokens ?? 0;
    if (graded.status === "passed") continue;
    if (graded.status === "unknown") unknown = true;
    else failed = true;
    if (graded.reason) reasons.push(graded.reason);
  }

  return done(failed ? "failed" : unknown ? "unknown" : "passed", reasons, tokens, judgeTokens);
}

/** Add up a case's trials. `bar` decides what the counts amount to. */
export function summarise(name: string, trials: TrialReport[], bar: "any" | "all"): CaseReport {
  const count = (status: TrialReport["status"]): number => trials.filter((t) => t.status === status).length;
  const passed = count("passed");
  const failed = count("failed");
  const unknown = count("unknown");
  const passAny = passed > 0;
  // An undecided trial is not evidence either way, so it is left out rather
  // than counted against: "every trial passed" is a claim about the trials
  // that were decided, and is not made at all when none was.
  const passAll = passed > 0 && failed === 0;

  const tally = new Map<string, number>();
  for (const one of trials) {
    for (const reason of new Set(one.reasons)) tally.set(reason, (tally.get(reason) ?? 0) + 1);
  }

  const met = bar === "all" ? passAll : passAny;
  const sum = (pick: (t: TrialReport) => number): number => trials.reduce((total, t) => total + pick(t), 0);
  return {
    name,
    status: !trials.length ? "skipped" : met ? "passed" : failed > 0 ? "failed" : "undecided",
    trials,
    passed,
    failed,
    unknown,
    passAny,
    passAll,
    reasons: [...tally].map(([reason, n]) => ({ reason, trials: n })),
    tokens: sum((t) => t.tokens),
    judgeTokens: sum((t) => t.judgeTokens),
    durationMs: sum((t) => t.durationMs),
  };
}

/**
 * Run one suite.
 *
 * Refuses a suite that cannot be run as written rather than reporting on part
 * of it: a case with no graders passes every time, and a number that includes
 * it is not a pass rate.
 */
export async function runEvaluation(
  spec: EvaluationSpec,
  target: EvalTarget,
  options: EvalOptions = {},
): Promise<SuiteReport> {
  const suite = spec.name ?? "eval";
  const faults = evaluationFaults(suite, spec);
  if (faults.length) throw new Error(`this eval cannot run as written:\n  ${faults.join("\n  ")}`);

  const trials = options.trials ?? spec.trials ?? 1;
  if (!(Number.isInteger(trials) && trials >= 1)) {
    throw new Error(`trials is ${String(trials)}; it has to be a whole number, 1 or more`);
  }
  const bar = spec.bar ?? "all";
  const started = Date.now();
  const gate = new Gate(options.concurrency ?? DEFAULT_CONCURRENCY);

  let stopped = false;
  const cases = await Promise.all(
    spec.cases.map(async (test) => {
      const results: TrialReport[] = [];
      await Promise.all(
        Array.from({ length: trials }, () =>
          gate.run(async () => {
            // Checked on entry, with the permit in hand: whatever was already
            // in flight finishes, and nothing new is paid for.
            if (stopped) return;
            results.push(await trial(spec, test, target));
            if (!options.bail) return;
            const sofar = summarise(test.name, results, bar);
            // Under "any" a failure settles nothing until the last trial is in.
            if (bar === "all" ? sofar.failed > 0 : results.length === trials && !sofar.passAny) stopped = true;
          }),
        ),
      );
      const report = summarise(test.name, results, bar);
      options.onCase?.(report, suite);
      return report;
    }),
  );

  const count = (status: CaseReport["status"]): number => cases.filter((c) => c.status === status).length;
  return {
    suite,
    target: spec.agent !== undefined ? { agent: spec.agent } : { workflow: spec.workflow! },
    bar,
    trials,
    cases,
    passed: count("passed"),
    failed: count("failed"),
    undecided: count("undecided"),
    skipped: count("skipped"),
    tokens: cases.reduce((total, c) => total + c.tokens, 0),
    judgeTokens: cases.reduce((total, c) => total + c.judgeTokens, 0),
    durationMs: Date.now() - started,
    ok: cases.every((c) => c.status === "passed"),
  };
}

/** Run several suites, one after another, and add them up. */
export async function runEvaluations(
  specs: EvaluationSpec[],
  target: EvalTarget,
  options: EvalOptions = {},
): Promise<EvalReport> {
  const started = Date.now();
  const suites: SuiteReport[] = [];
  let bailed = false;
  for (const spec of specs) {
    const report = await runEvaluation(spec, target, options);
    suites.push(report);
    if (options.bail && !report.ok) {
      bailed = true;
      break;
    }
  }
  const sum = (pick: (s: SuiteReport) => number): number => suites.reduce((total, s) => total + pick(s), 0);
  return {
    suites,
    cases: sum((s) => s.cases.length),
    passed: sum((s) => s.passed),
    tokens: sum((s) => s.tokens),
    judgeTokens: sum((s) => s.judgeTokens),
    durationMs: Date.now() - started,
    // A run that was cut short did not find out, so it does not get to say yes.
    ok: !bailed && suites.length === specs.length && suites.every((s) => s.ok),
    ...(bailed ? { bailed: true as const } : {}),
  };
}
