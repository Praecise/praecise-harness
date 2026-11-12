/**
 * The moments after a call is allowed, asked of the app the way the guard is asked.
 *
 * A guard speaks before a tool runs. Three more moments decide what an agent ends up
 * believing and when it stops working, and until now the app could watch them and not
 * touch them:
 *
 *   after a tool   — what came back may be rewritten, or withheld with a reason.
 *   before a stop  — the agent may be sent back to work, with a reason, a bounded number of times.
 *   before compact — the earlier work may be kept from being summarised, or the app may
 *                    write the summary itself.
 *
 * They are one seam, `HooksSpec`, and they answer as a guard does: say nothing and what
 * was going to happen happens. An app writes one in `hooks.ts`; a plugin brings one; and
 * where there are several they are asked in order, the app's own first.
 *
 * What a hook that throws means differs by moment, and each is the safe reading. A check
 * on a result that fails has not said the result may be read, so it is withheld. A check
 * on stopping that fails cannot be allowed to hold an agent in a loop, so the agent
 * stops. A check on compaction that fails leaves a transcript that still has to fit, so
 * it is summarised as it would have been.
 */

import type { BeforeCompact, Compacting, HooksSpec, Stopping, ToolOutcome } from "../define.js";

/** How many times one conversation may be sent back to work when it tries to stop. */
export const SENT_BACK = 3;

const MOMENTS = ["afterTool", "beforeStop", "beforeCompact"] as const;

/**
 * A value as hooks, or nothing if it is not any.
 *
 * At least one moment, and nothing under a moment's name that is not a function — a
 * hook that is present and does not load is the dangerous case, exactly as it is for a
 * guard: the file is there, so the app reads as checked, and nothing is checking.
 */
export function hooksFrom(value: unknown): HooksSpec | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const given = value as Record<string, unknown>;
  let any = false;
  for (const moment of MOMENTS) {
    if (given[moment] === undefined) continue;
    if (typeof given[moment] !== "function") return undefined;
    any = true;
  }
  return any ? ({ ...given, kind: "hooks" } as HooksSpec) : undefined;
}

/**
 * Several sets of hooks as one, asked in the order given.
 *
 * After a tool, each sees the result as the one before left it, and the first to
 * withhold it ends the asking. Before a stop and before compaction, the first to say
 * anything is the answer: two reasons to keep working are one reason too many to hand a
 * model, and two summaries of the same work cannot both replace it.
 */
export function composeHooks(all: readonly (HooksSpec | Omit<HooksSpec, "kind"> | undefined)[]): HooksSpec | undefined {
  const sets = all.filter((set): set is HooksSpec => Boolean(set));
  if (!sets.length) return undefined;
  if (sets.length === 1) return { ...sets[0]!, kind: "hooks" };

  const having = <Moment extends (typeof MOMENTS)[number]>(moment: Moment) =>
    sets.filter((set) => typeof set[moment] === "function");
  const after = having("afterTool");
  const stop = having("beforeStop");
  const compact = having("beforeCompact");

  return {
    kind: "hooks",
    ...(after.length
      ? {
          async afterTool(outcome: ToolOutcome) {
            let current = outcome;
            let changed = false;
            for (const set of after) {
              const said = await set.afterTool!(current);
              if (!said) continue;
              if ("reject" in said) return said;
              if (typeof said.result === "string") {
                current = { ...current, result: said.result };
                changed = true;
              }
            }
            return changed ? { result: current.result } : undefined;
          },
        }
      : {}),
    ...(stop.length
      ? {
          async beforeStop(stopping: Stopping) {
            for (const set of stop) {
              const said = await set.beforeStop!(stopping);
              if (typeof said === "string" && said.trim()) return said;
            }
            return undefined;
          },
        }
      : {}),
    ...(compact.length
      ? {
          async beforeCompact(compacting: Compacting) {
            for (const set of compact) {
              const said = await set.beforeCompact!(compacting);
              if (said) return said;
            }
            return undefined;
          },
        }
      : {}),
  };
}

/** What the model is shown for a tool's result, once the app has been asked about it. */
export interface Shown {
  text: string;
  /** Set when the result was withheld: the reason, which is what the model reads instead. */
  rejected?: string;
}

/**
 * Ask the app about a result before the model reads it.
 *
 * A hook that throws is read as withholding the result, as a guard that throws is read
 * as refusing the call.
 */
export async function shownFor(hooks: HooksSpec | undefined, outcome: ToolOutcome): Promise<Shown> {
  if (!hooks?.afterTool) return { text: outcome.result };
  try {
    const said = await hooks.afterTool(outcome);
    if (said && "reject" in said) {
      const why = typeof said.reject === "string" && said.reject.trim() ? said.reject : "The app withheld this result.";
      return { text: why, rejected: why };
    }
    if (said && typeof said.result === "string") return { text: said.result };
    return { text: outcome.result };
  } catch (err) {
    const why = `Not shown: the app's check on this result failed (${(err as Error).message}).`;
    return { text: why, rejected: why };
  }
}

/**
 * Ask the app whether an agent may stop. A sentence back means no, and is why.
 *
 * Bounded by the caller, and a hook that throws lets the agent stop: the alternative is
 * an agent held at work by a check that cannot say what it wants.
 */
export async function objectionTo(
  hooks: HooksSpec | undefined,
  stopping: Stopping,
  note: (text: string) => void,
): Promise<string | undefined> {
  if (!hooks?.beforeStop) return undefined;
  try {
    const said = await hooks.beforeStop(stopping);
    return typeof said === "string" && said.trim() ? said.trim() : undefined;
  } catch (err) {
    note(`the app's check before stopping failed (${(err as Error).message}); the answer stands as it was given`);
    return undefined;
  }
}

/** Ask the app about a stretch of work that is about to be replaced by a summary. */
export async function compactingAs(
  hooks: HooksSpec | undefined,
  compacting: Compacting,
  note: (text: string) => void,
): Promise<BeforeCompact> {
  if (!hooks?.beforeCompact) return undefined;
  try {
    const said = await hooks.beforeCompact(compacting);
    if (said && "keep" in said && said.keep === true) return { keep: true };
    if (said && "summary" in said && typeof said.summary === "string" && said.summary.trim()) {
      return { summary: said.summary.trim() };
    }
    return undefined;
  } catch (err) {
    note(`the app's check before summarising failed (${(err as Error).message}); summarising as usual`);
    return undefined;
  }
}

/** What a model reads when it tried to stop and the app sent it back. */
export const sentBack = (reason: string): string =>
  `[That was not accepted as finished. ${reason}]`;
