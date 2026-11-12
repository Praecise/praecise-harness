/**
 * A finished workflow run, read as an answer.
 *
 * Graders are written against one shape — text, a structured result, the tools
 * that were called — so a workflow is graded with the same words as an agent
 * rather than with a second vocabulary that means the same things.
 */

import { isUse, type WorkflowSpec } from "../define.js";
import type { Answer } from "../harness/types.js";
import { walkSteps } from "../workflow/defects.js";
import type { Run } from "../workflow/store.js";

/**
 * Throws where the run did not produce a result, with the reason as the
 * message — the runner reports a thrown trial as a failed one.
 */
export function answerOfRun(spec: WorkflowSpec, run: Run): Answer {
  if (run.status === "failed") throw new Error(run.error ?? "the run failed without saying why");
  if (run.status === "waiting") {
    throw new Error(
      `the run stopped at "${run.waitingFor?.step ?? "a gate"}" waiting for approval, and an eval has nobody to give it. ` +
        "Evaluate a workflow without an `approve` step, or the agents on either side of the gate.",
    );
  }
  if (run.status !== "done") throw new Error(`the run ended as "${run.status}" rather than done`);

  // Which tools ran is read off the steps that finished. A step inside a loop
  // is recorded under a scoped id (`each.2.charge`); its own id is the last part.
  const uses = new Map<string, { name: string; args: unknown }>();
  walkSteps(spec.steps, (step) => {
    if (isUse(step)) uses.set(step.id, { name: step.use, args: step.with });
  });
  const toolCalls = run.events
    .filter((event) => event.kind === "done")
    .map((event) => uses.get(event.step) ?? uses.get(event.step.split(".").pop() ?? ""))
    .filter((call): call is { name: string; args: unknown } => call !== undefined);

  const result = run.result;
  return {
    text: typeof result === "string" ? result : JSON.stringify(result ?? null),
    data: result,
    path: [],
    usage: { ...run.usage, cachedTokens: 0, decidingTokens: 0 },
    toolCalls,
    ...(run.tainted ? { tainted: true } : {}),
    harness: "workflow",
  };
}
