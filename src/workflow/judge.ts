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

export interface Verdict {
  holds: boolean;
  why: string;
}

interface Answered {
  holds?: unknown;
  why?: unknown;
}

/**
 * Strip a plan back to something that can only read and answer.
 *
 * Built from a real plan rather than from nothing so the judge runs on the
 * models the app has configured — everything else about the agent is removed.
 */
export function judgePlan(plan: AgentPlan): AgentPlan {
  return {
    ...plan,
    name: `${plan.name}:outcome`,
    description: "Decides whether a claim about some work is true of that work.",
    instructions: INSTRUCTIONS,
    services: [],
    locals: [],
    memory: false,
    memoryStore: undefined,
    memoryRecall: undefined,
    greeting: undefined,
    returns: {
      holds: "true if the material shows the claim to be true",
      why: "the one thing that decided it",
    },
  };
}

/** Ask the judge whether a claim holds of some material. Never throws. */
export async function judge(
  harness: Harness,
  plan: AgentPlan,
  claim: string,
  material: string,
): Promise<Verdict> {
  const question = [
    "The claim:",
    claim.trim() || "(no claim was given)",
    "",
    "The material:",
    material.trim() || "(nothing was produced)",
  ].join("\n");

  let answer;
  try {
    answer = await harness.ask(judgePlan(plan), question);
  } catch (err) {
    return { holds: false, why: `the outcome could not be judged: ${(err as Error).message}` };
  }

  const data = (answer.data ?? {}) as Answered;
  // A judge that did not come back in shape has not judged anything. Reading a
  // "yes" out of loose prose is how a check quietly stops being one.
  if (typeof data.holds !== "boolean") {
    return { holds: false, why: "the outcome could not be judged" };
  }
  return { holds: data.holds, why: typeof data.why === "string" ? data.why : "" };
}
