/**
 * Asking whether the work holds, of something that did not do it.
 *
 * A command that exits non-zero is the strongest check there is and needs
 * nothing from this file. But most of what a workflow produces is prose, and
 * there is no command that reads it. So a question gets asked of a model — and
 * the question is only worth asking if the thing answering is in no position to
 * be defending its own work.
 *
 * So the judge is given nothing but the claim and the material. No tools, so it
 * cannot go and find support for a verdict it has already reached. No memory,
 * so nothing it decided before leans on what it decides now. No knowledge, so
 * it cannot quietly substitute the brief for the evidence. It never sees the
 * producing agent's reasoning, because reasoning is persuasive independently of
 * whether it is right, and an argument for an answer is the one thing most
 * likely to talk a reader into it.
 *
 * What comes back is a verdict and a reason. The reason exists so a failing
 * check says what was missing rather than only that something was.
 */

import type { AgentPlan } from "../compile/plan.js";
import type { Harness } from "../harness/types.js";
import type { TraceContext } from "../harness/trace.js";

const INSTRUCTIONS = [
  "You decide whether a claim about some work is true of that work.",
  "",
  "You did not do the work and you are not defending it. You are given the",
  "claim and the material, and nothing else. Judge only what is in front of",
  "you: if the material does not settle the claim, the claim does not hold.",
  "Confident writing is not evidence. Length is not evidence. Work that",
  "sounds finished is not the same as work that is.",
  "",
  'Answer with "holds": true only if the material shows the claim to be true.',
  'Put in "why" the one thing that decided it — what was missing, or what',
  "settled it.",
].join("\n");

/**
 * What is added when the caller can use a third answer.
 *
 * A workflow has to decide whether to continue, so for it an unsettled claim is
 * a no. An eval is measuring, and there a judge forced to pick turns "I cannot
 * tell" into a failure the agent did not earn or a pass nobody checked.
 */
const ABSTAINING = [
  "One exception. If the material is not enough to tell either way — the claim",
  "is about something the material does not show — do not guess and do not",
  'default to false. Answer with "unknown": true, and put in "why" what you',
  "would have needed to see.",
].join("\n");

export interface Verdict {
  holds: boolean;
  why: string;
  /** The judge could not tell. Only ever set when it was allowed to say so. */
  unknown?: true;
  /** What judging cost, where a model was reached. */
  tokens?: number;
}

export interface JudgeOptions {
  /** Let the judge answer "unknown" rather than forcing a yes or a no. */
  abstain?: boolean;
  /** The trace the judging belongs to, so what it cost sits with what it judged. */
  trace?: TraceContext;
}

interface Answered {
  holds?: unknown;
  why?: unknown;
  unknown?: unknown;
}

/**
 * Strip a plan back to something that can only read and answer.
 *
 * Built from a real plan rather than from nothing so the judge runs on the
 * models the app has configured — everything else about the agent is removed.
 */
export function judgePlan(plan: AgentPlan, options: JudgeOptions = {}): AgentPlan {
  return {
    ...plan,
    name: `${plan.name}:outcome`,
    description: "Decides whether a claim about some work is true of that work.",
    instructions: options.abstain ? `${INSTRUCTIONS}\n\n${ABSTAINING}` : INSTRUCTIONS,
    services: [],
    locals: [],
    memory: false,
    memoryStore: undefined,
    memoryRecall: undefined,
    greeting: undefined,
    returns: {
      holds: "true if the material shows the claim to be true",
      why: "the one thing that decided it",
      ...(options.abstain ? { unknown: "true only if the material is not enough to tell either way" } : {}),
    },
  };
}

/** Ask the judge whether a claim holds of some material. Never throws. */
export async function judge(
  harness: Harness,
  plan: AgentPlan,
  claim: string,
  material: string,
  options: JudgeOptions = {},
): Promise<Verdict> {
  const question = [
    "The claim:",
    claim.trim() || "(no claim was given)",
    "",
    "The material:",
    material.trim() || "(nothing was produced)",
  ].join("\n");

  // Where "unknown" is an answer, a judge that never judged is one: nothing was
  // decided about the work, and calling that a failure would blame the work.
  const unjudged = options.abstain ? ({ unknown: true } as const) : {};

  let answer;
  try {
    answer = options.trace
      ? await harness.ask(judgePlan(plan, options), question, { trace: options.trace })
      : await harness.ask(judgePlan(plan, options), question);
  } catch (err) {
    return { holds: false, why: `the outcome could not be judged: ${(err as Error).message}`, ...unjudged };
  }

  const tokens = answer.usage.inputTokens + answer.usage.outputTokens;
  const data = (answer.data ?? {}) as Answered;
  const why = typeof data.why === "string" ? data.why : "";
  if (options.abstain && data.unknown === true) return { holds: false, why, unknown: true, tokens };
  // A judge that did not come back in shape has not judged anything. Reading a
  // "yes" out of loose prose is how a check quietly stops being one.
  if (typeof data.holds !== "boolean") {
    return { holds: false, why: "the outcome could not be judged", ...unjudged, tokens };
  }
  return { holds: data.holds, why, tokens };
}
