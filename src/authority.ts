/**
 * The app's authority: the one place that decides whether an action may happen.
 *
 * A guard is the app's own opinion, written in code beside the agents. An
 * authority is the rule set the app answers to — a policy service, a ledger of
 * mandates, a signed delegation — and it is asked after the guard, for every way
 * a tool can be reached: the model's tool loop, a workflow step, HTTP, MCP and
 * the CLI. Nothing in config can widen what it allows.
 *
 * Three answers. `allow` lets the call through. `refuse` ends it with a reason,
 * handed to the model exactly as a guard refusal is. `stepUp` says the action is
 * possible with a person's approval: on a workflow it becomes an approval gate on
 * the run whose signed claim carries `digest`, and the call is asked again with
 * the verified approval attached; in a conversation, where nobody can sign
 * mid-turn, it is a refusal that says what would be needed.
 */

import type { Attempt } from "./define.js";

export type Verdict = { allow: true } | { refuse: string } | { stepUp: string; digest: string };

export interface Authority {
  check(attempt: Attempt): Verdict | Promise<Verdict>;
}

/** Thrown from a direct call that needs a person's approval before it can run. */
export class StepUpRequired extends Error {
  readonly challenge: string;
  readonly digest: string;
  constructor(challenge: string, digest: string) {
    super(`approval required: ${challenge}`);
    this.name = "StepUpRequired";
    this.challenge = challenge;
    this.digest = digest;
  }
}

/**
 * Ask the authority, reading anything but a well-formed answer as a refusal.
 *
 * An authority that throws, times out into an exception, or answers with a shape
 * this runtime does not know has not said yes, and the safe reading of that is no.
 */
export async function judge(authority: Authority, attempt: Attempt): Promise<Verdict> {
  let verdict: Verdict;
  try {
    verdict = await authority.check(attempt);
  } catch (err) {
    return { refuse: `Not allowed: ${(err as Error).message}` };
  }
  if (verdict && "allow" in verdict && verdict.allow === true) return { allow: true };
  if (verdict && "refuse" in verdict && typeof verdict.refuse === "string" && verdict.refuse.trim()) {
    return { refuse: verdict.refuse };
  }
  if (
    verdict &&
    "stepUp" in verdict &&
    typeof verdict.stepUp === "string" &&
    typeof verdict.digest === "string" &&
    verdict.digest.length > 0
  ) {
    return { stepUp: verdict.stepUp, digest: verdict.digest };
  }
  return { refuse: "Not allowed: the authority gave no answer this runtime can act on" };
}

/** The sentence a model reads when an action needs an approval it cannot obtain mid-turn. */
export function stepUpSentence(challenge: string): string {
  return (
    `Not allowed from this conversation: this needs a person's approval (${challenge}). ` +
    `Say so and stop; it can be done from a workflow step that waits for that approval.`
  );
}
