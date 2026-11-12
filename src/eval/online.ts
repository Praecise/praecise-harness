/**
 * Scoring a live answer with a suite's graders.
 *
 * An eval run before release says the agent was right about the cases somebody thought
 * of. This is the other half: the same graders, read against a sample of what the agent
 * is actually saying, after it has said it. Nothing here can change an answer or hold
 * one up — it is handed an answer that has already been returned.
 *
 * The result is reported the way OpenTelemetry's GenAI conventions report one: a
 * `gen_ai.evaluation.result` event carrying `gen_ai.evaluation.name`, the score as
 * `gen_ai.evaluation.score.value` and `gen_ai.evaluation.score.label`, and why as
 * `gen_ai.evaluation.explanation`. The event rides on a span in the answer's own trace,
 * because a `Tracer` takes spans, and that span is also where the judge's model calls
 * hang — so what scoring cost is in the same place as what it found.
 */

import type { EvalCase, OnlineEval } from "../define.js";
import type { Answer } from "../harness/types.js";
import { newSpanId, type Span, type TraceContext } from "../harness/trace.js";
import { redact } from "../redact.js";
import { grade, type EvalJudge } from "./grade.js";

/** The event name the GenAI conventions give an evaluation's result. */
export const EVALUATION_EVENT = "gen_ai.evaluation.result";

/** What one live answer scored against one suite. */
export interface OnlineScore {
  suite: string;
  agent: string;
  /**
   * The share of graders that passed, of those that could be decided, 0..1. Absent
   * when none could: an undecided answer has no score, not a low one.
   */
  score?: number;
  /** `pass` at or above the suite's threshold, or at full marks where it sets none. */
  label: "pass" | "fail" | "unknown";
  passed: number;
  failed: number;
  unknown: number;
  /** Why, for each grader that did not pass. Redacted. */
  reasons: string[];
  /** Set when the score is under the suite's `threshold`. What `notify` is told about. */
  below: boolean;
  judgeTokens: number;
  durationMs: number;
}

const EXPLANATION = 1000;

/** Grade one live answer against a suite's online graders. Never throws. */
export async function scoreAnswer(
  suite: string,
  agent: string,
  online: OnlineEval,
  input: string,
  answer: Answer,
  judge: EvalJudge,
): Promise<OnlineScore> {
  const started = Date.now();
  const test: EvalCase = { name: "live", input, expect: online.expect };
  let passed = 0;
  let failed = 0;
  let unknown = 0;
  let judgeTokens = 0;
  const reasons: string[] = [];

  for (const grader of online.expect) {
    let graded;
    try {
      graded = await grade(grader, answer, test, judge);
    } catch (err) {
      // A judge that could not be reached has not decided anything.
      graded = { status: "unknown" as const, reason: `could not be graded: ${(err as Error).message}` };
    }
    judgeTokens += graded.tokens ?? 0;
    if (graded.status === "passed") passed++;
    else if (graded.status === "failed") failed++;
    else unknown++;
    if (graded.status !== "passed" && graded.reason) reasons.push(redact(graded.reason));
  }

  const decided = passed + failed;
  const score = decided ? passed / decided : undefined;
  const bar = online.threshold ?? 1;
  return {
    suite,
    agent,
    ...(score === undefined ? {} : { score }),
    label: score === undefined ? "unknown" : score >= bar ? "pass" : "fail",
    passed,
    failed,
    unknown,
    reasons,
    below: score !== undefined && online.threshold !== undefined && score < online.threshold,
    judgeTokens,
    durationMs: Date.now() - started,
  };
}

/**
 * The span a score is reported on, carrying the convention's evaluation event.
 *
 * `context` is this span's own place in the trace — the judge's calls are made under
 * it — and `parent` is the request that was scored.
 */
export function evaluationSpan(
  score: OnlineScore,
  at: { context: TraceContext; parent?: TraceContext; startTime: number; endTime: number; error?: string },
): Span {
  const attributes: Span["attributes"] = {
    "gen_ai.evaluation.name": score.suite,
    ...(score.score === undefined ? {} : { "gen_ai.evaluation.score.value": score.score }),
    "gen_ai.evaluation.score.label": score.label,
    ...(score.reasons.length
      ? { "gen_ai.evaluation.explanation": score.reasons.join("; ").slice(0, EXPLANATION) }
      : {}),
    ...(at.error ? { "error.type": at.error } : {}),
  };
  return {
    name: `evaluate ${score.suite}`,
    kind: "internal",
    traceId: at.context.traceId,
    spanId: at.context.spanId,
    ...(at.parent ? { parentSpanId: at.parent.spanId } : {}),
    startTime: at.startTime,
    endTime: at.endTime,
    attributes: { ...attributes, "gen_ai.agent.name": score.agent },
    status: at.error ? { code: "error", message: at.error } : { code: "ok" },
    events: [{ name: EVALUATION_EVENT, time: at.endTime, attributes }],
  };
}

/** A place in `parent`'s trace for the scoring to happen in. */
export function scoringContext(parent: TraceContext): TraceContext {
  return { traceId: parent.traceId, spanId: newSpanId(), traceState: parent.traceState };
}
