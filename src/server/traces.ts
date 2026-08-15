/**
 * The last few traces, kept in memory so a dev server can show them.
 *
 * praecise emits OpenTelemetry GenAI spans and takes no opinion on where they go, which
 * is right for production — every deployment already has a collector — and useless during
 * development, where the whole value is seeing what just happened without configuring
 * anything first. The gap it left was the one that keeps debugging at a terminal: run
 * records say WHAT happened, spans say why it took nine seconds and cost forty cents, and
 * until now nothing rendered them.
 *
 * ── Why bounded, and bounded by traces rather than spans ──────────────────────
 *
 * A dev server that runs for a week must not grow for a week. The cap is on TRACES rather
 * than on individual spans because a trace is the unit anyone looks at: dropping the
 * oldest half of one trace's spans leaves a timeline with holes in it, which is worse
 * than not having that trace at all.
 *
 * ── What this deliberately is not ─────────────────────────────────────────────
 *
 * Not a collector, not durable, not a query engine. It is what fits in memory and answers
 * one question — "what did the last few requests actually do" — for one person watching
 * one server. Anything more is the job of the thing the production tracer feeds.
 */

import type { Span } from "../harness/trace.js";

/** One trace, assembled from the spans that share its id. */
export interface Trace {
  traceId: string;
  spans: Span[];
  startTime: number;
  endTime: number;
  /** Milliseconds from the first span starting to the last one ending. */
  duration: number;
  /** Summed across the trace, which is what a cost question actually asks. */
  inputTokens: number;
  outputTokens: number;
  /** How many spans failed. Non-zero is the reason to look. */
  errors: number;
  /** The most descriptive name in the trace, for a list that has to fit on a line. */
  title: string;
}

const DEFAULT_KEEP = 50;

export class TraceLog {
  private readonly spans = new Map<string, Span[]>();
  /** Insertion order of trace ids, so the oldest is known without sorting. */
  private readonly order: string[] = [];
  private readonly keep: number;

  constructor(keep = DEFAULT_KEEP) {
    this.keep = keep;
  }

  /** The tracer to hand the harness. */
  get tracer(): (span: Span) => void {
    return (span) => this.add(span);
  }

  add(span: Span): void {
    const held = this.spans.get(span.traceId);
    if (held) {
      held.push(span);
      return;
    }
    this.spans.set(span.traceId, [span]);
    this.order.push(span.traceId);
    // Whole traces leave together: half a timeline is worse than none.
    while (this.order.length > this.keep) {
      const oldest = this.order.shift();
      if (oldest) this.spans.delete(oldest);
    }
  }

  /** Newest first, which is the order anyone debugging wants. */
  all(): Trace[] {
    return [...this.order]
      .reverse()
      .map((traceId) => assemble(traceId, this.spans.get(traceId) ?? []))
      .filter((trace): trace is Trace => trace !== undefined);
  }

  one(traceId: string): Trace | undefined {
    const held = this.spans.get(traceId);
    return held ? assemble(traceId, held) : undefined;
  }

  clear(): void {
    this.spans.clear();
    this.order.length = 0;
  }
}

function assemble(traceId: string, spans: Span[]): Trace | undefined {
  if (!spans.length) return undefined;
  const ordered = [...spans].sort((a, b) => a.startTime - b.startTime);
  const startTime = ordered[0]!.startTime;
  const endTime = Math.max(...ordered.map((span) => span.endTime));

  let inputTokens = 0;
  let outputTokens = 0;
  let errors = 0;
  for (const span of ordered) {
    const input = span.attributes["gen_ai.usage.input_tokens"];
    const output = span.attributes["gen_ai.usage.output_tokens"];
    if (typeof input === "number") inputTokens += input;
    if (typeof output === "number") outputTokens += output;
    if (span.status.code === "error") errors += 1;
  }

  return {
    traceId,
    spans: ordered,
    startTime,
    endTime,
    duration: endTime - startTime,
    inputTokens,
    outputTokens,
    errors,
    // The root is the most informative name; failing that, the first span.
    title: (ordered.find((span) => !span.parentSpanId) ?? ordered[0]!).name,
  };
}

/** Where a span sits in the trace's own timeline, as fractions of its width. */
export function laneOf(span: Span, trace: Trace): { left: number; width: number } {
  const span_ms = Math.max(1, trace.duration);
  return {
    left: ((span.startTime - trace.startTime) / span_ms) * 100,
    // A span that took under a millisecond still has to be visible, or a trace of fast
    // calls renders as an empty bar and looks broken rather than fast.
    width: Math.max(0.6, ((span.endTime - span.startTime) / span_ms) * 100),
  };
}
