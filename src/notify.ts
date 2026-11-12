/**
 * What a run does, told to whoever asked to be told.
 *
 * A caller holding a stream open hears a run as it goes, and a run that waits a week on
 * an approval outlives every such caller. This is the other direction: the app reports
 * each change of a run's status as a CloudEvent, to a function or to a signed webhook.
 *
 * The event says THAT something happened and to which run — never what the run
 * produced. Step outputs, model text and failure messages stay in the run's record,
 * where whoever is allowed to read them already can; a notification goes to a URL
 * somebody typed into a config, which is not the same as being allowed. The one
 * sentence that does travel is a gate's prompt, because "a run is waiting" with no word
 * on what for cannot be acted on.
 */

import { cloudEvent, type CloudEvent } from "./events.js";
import { safeMessage } from "./redact.js";
import { deliverWebhook, type DeliverWebhookOptions, type WebhookTarget } from "./webhooks.js";
import type { RunStatus, RunTransition } from "./workflow/store.js";

/** Where run events go: a function that takes each one, or a signed webhook. */
export type Notify = WebhookTarget | ((event: CloudEvent) => void | Promise<void>);

export const RUN_EVENT_TYPES = {
  started: "com.praecise.run.started",
  waiting: "com.praecise.run.waiting",
  done: "com.praecise.run.done",
  failed: "com.praecise.run.failed",
} as const;

export type RunEventType = (typeof RUN_EVENT_TYPES)[keyof typeof RUN_EVENT_TYPES];

/** What is reported about a live answer that was scored: only that it fell short. */
export const EVAL_EVENT_TYPES = {
  below: "com.praecise.eval.below",
} as const;

/**
 * The `data` of an eval event.
 *
 * The score and where to look, and neither the question nor the answer: those are in
 * the trace, for whoever may read it.
 */
export interface EvalNotice {
  suite: string;
  agent: string;
  score: number;
  threshold: number;
  /** The trace of the answer that was scored. */
  trace: string;
}

/** The event a score under its suite's threshold is reported as. */
export function evalEvent(notice: EvalNotice, source: string): CloudEvent {
  return cloudEvent(EVAL_EVENT_TYPES.below, source, notice, { subject: notice.trace });
}

/** Every event an app sends, by its short name and its full type. */
const SENT: Record<string, string> = { ...RUN_EVENT_TYPES, ...EVAL_EVENT_TYPES };

/** The `data` of a run event. */
export interface RunNotice {
  run: string;
  workflow: string;
  status: RunStatus;
  /** The gate a waiting run stopped at, and what it asks. */
  step?: { id: string; prompt: string };
  /** Whether the workflow's declared outcome held. Why it did or did not is in the run. */
  outcome?: { held: boolean };
}

/**
 * The event a change of status is reported as, or nothing.
 *
 * A run that goes back to running after a gate has not started again, and the four
 * types have no word for it, so it is not reported; what it comes to next is.
 */
export function runEvent(change: RunTransition, source: string): CloudEvent | undefined {
  const kind =
    change.to === "running" ? (change.from === undefined ? "started" : undefined) : change.to;
  if (!kind) return undefined;

  const data: RunNotice = {
    run: change.run,
    workflow: change.workflow,
    status: change.to,
    ...(change.to === "waiting" && change.waitingFor
      ? { step: { id: change.waitingFor.step, prompt: change.waitingFor.prompt } }
      : {}),
    ...(change.outcome ? { outcome: { held: change.outcome.held } } : {}),
  };
  return cloudEvent(RUN_EVENT_TYPES[kind], source, data, { subject: change.run });
}

/** The receiver without its query, which is where a URL keeps anything secret. */
function nameOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "the notify url";
  }
}

/**
 * Reports run events without the run waiting on, or failing with, the report.
 *
 * Events for one run are delivered in the order they happened — a receiver told `done`
 * before `waiting` has been told something false — and runs do not queue behind each
 * other, so one slow delivery holds up only its own run's next event.
 */
export class Notifier {
  /** The most recent report that did not arrive, as a sentence for an operator. */
  failure?: string;

  private readonly target: Notify;
  private readonly source: string;
  private readonly delivery: DeliverWebhookOptions;
  private readonly wanted?: Set<string>;
  private readonly queues = new Map<string, Promise<void>>();

  constructor(target: Notify, options: { source: string } & DeliverWebhookOptions) {
    const { source, ...delivery } = options;
    if (typeof target !== "function") {
      if (!/^https?:\/\//i.test(target.url ?? "")) {
        throw new Error(
          `notify.url must be an http(s) URL; got ${JSON.stringify(target.url ?? null)}. Set it to the address that receives the webhook, or pass a function instead.`,
        );
      }
      if (!target.secret) {
        throw new Error(
          "notify.secret is required: without it the receiver cannot tell this app's events from anyone else's. " +
            "Set it to `whsec_` followed by base64 of at least 24 random bytes, and give the receiver the same value.",
        );
      }
      if (target.events) {
        const known = new Set<string>([...Object.keys(SENT), ...Object.values(SENT)]);
        const unknown = target.events.filter((name) => !known.has(name));
        if (unknown.length) {
          throw new Error(
            `notify.events names ${unknown.map((name) => `"${name}"`).join(", ")}, which this app never sends. ` +
              `The events are ${Object.values(SENT).join(", ")}.`,
          );
        }
        this.wanted = new Set(target.events);
      }
    }
    this.target = target;
    this.source = source;
    this.delivery = delivery;
  }

  /** Take one change of status. Returns at once; delivery happens behind it. */
  report(change: RunTransition): void {
    const event = runEvent(change, this.source);
    if (event) this.enqueue(change.run, event);
  }

  /** Report that a live answer scored under its suite's threshold. Returns at once. */
  score(notice: EvalNotice): void {
    this.enqueue(`eval:${notice.trace}`, evalEvent(notice, this.source));
  }

  /** Deliver behind whatever is already queued under `key`, unless the receiver did not ask for it. */
  private enqueue(key: string, event: CloudEvent): void {
    if (this.wanted && !this.wanted.has(event.type) && !this.wanted.has(event.type.split(".").pop()!)) return;

    const next = (this.queues.get(key) ?? Promise.resolve()).then(() => this.send(event));
    this.queues.set(key, next);
    void next.then(() => {
      if (this.queues.get(key) === next) this.queues.delete(key);
      return undefined;
    });
  }

  /** Resolves once everything reported so far has been delivered or given up on. */
  async settled(): Promise<void> {
    while (this.queues.size) await Promise.all(this.queues.values());
  }

  /** Never rejects: a report that fails is written down, not passed on. */
  private async send(event: CloudEvent): Promise<void> {
    let why: string | undefined;
    const to = typeof this.target === "function" ? "the notify function" : nameOf(this.target.url);
    try {
      if (typeof this.target === "function") {
        await this.target(event);
      } else {
        const result = await deliverWebhook(this.target, event, this.delivery);
        if (!result.delivered) {
          why = `${result.error ?? "it was not accepted"}, after ${result.attempts} attempt${result.attempts === 1 ? "" : "s"}`;
        }
      }
    } catch (err) {
      why = safeMessage(err, "notify");
    }
    if (why) {
      const scored = event.type === EVAL_EVENT_TYPES.below;
      this.failure =
        `${event.type} for ${scored ? "trace" : "run"} ${event.subject} did not reach ${to} at ${new Date().toISOString()}: ${why}. ` +
        (scored
          ? "The answer itself is unaffected, and its trace carries the score the event would have."
          : "The run itself is unaffected, and its record says what the event would have.");
    }
  }
}
