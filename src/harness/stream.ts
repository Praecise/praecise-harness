/**
 * The same request, read as it happens rather than waited for.
 *
 * This is a bridge and not a second way of asking. A runtime reports progress
 * by calling back; an interface would rather loop over something. So the
 * callbacks are queued and handed out in order, and the last thing out is
 * always a `done` or a `failed`.
 *
 * Because it is only a bridge, every runtime gets this for free — one that
 * reports nothing simply yields a single `done`, and the answer is identical.
 */

import type { AgentPlan } from "../compile/plan.js";
import type { AskOptions, Harness, Progress } from "./types.js";

/**
 * Ask, and read what happens in order.
 *
 * The queue is unbounded on purpose: dropping progress to keep it small would
 * mean an interface showing a different sequence of events depending on how
 * fast it read them, and the events are small next to the answer they describe.
 */
export async function* stream(
  harness: Harness,
  plan: AgentPlan,
  input: string,
  options: AskOptions = {},
): AsyncGenerator<Progress> {
  const queue: Progress[] = [];
  let wake: (() => void) | undefined;
  let finished = false;

  const push = (event: Progress): void => {
    queue.push(event);
    wake?.();
    wake = undefined;
  };

  const work = harness
    .ask(plan, input, { ...options, onProgress: push })
    .then(
      (answer) => push({ kind: "done", answer }),
      (err: unknown) => push({ kind: "failed", error: (err as Error).message }),
    )
    .finally(() => {
      finished = true;
      wake?.();
      wake = undefined;
    });

  try {
    for (;;) {
      while (queue.length) yield queue.shift()!;
      if (finished) break;
      await new Promise<void>((resume) => {
        wake = resume;
      });
    }
  } finally {
    // A caller that stops reading half way still leaves a request in flight;
    // waiting for it here is what keeps memory and the routing record written.
    await work;
  }
}
