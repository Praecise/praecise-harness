/**
 * Tracing, as OpenTelemetry defines it for generative AI — not as a tracer of our own.
 *
 * The observability gap here was real: praecise kept run records and usage totals, which
 * answer "what happened" and not "why did that take nine seconds and cost forty cents".
 * The obvious fix is a proprietary tracer with a proprietary viewer, and it is the wrong
 * one. Every serious deployment already runs something that ingests OpenTelemetry —
 * Grafana, Honeycomb, Datadog, Jaeger, LangSmith, Phoenix — and a framework that emits
 * its own format asks each of them to write an adapter nobody will.
 *
 * So this emits SPANS in the GenAI semantic convention, and emits nothing else. The
 * convention is specific and worth following exactly, because dashboards key off these
 * names: a span is named `{gen_ai.operation.name} {gen_ai.request.model}`, its kind is
 * CLIENT, `gen_ai.operation.name` and `gen_ai.provider.name` are required, the model and
 * token counts have their own attribute names, and a failure carries `error.type`.
 *
 * ── Why there is no OpenTelemetry dependency ──────────────────────────────────
 *
 * praecise has no runtime dependencies and this does not add the largest one in the
 * ecosystem. A `Tracer` here is an interface with one method, and what it does with a
 * finished span is the application's business: hand it to the real OTel SDK, write it to
 * a file, post it somewhere, or ignore it. The convention is in the DATA, which is the
 * part that has to be right, and the SDK is a transport that every deployment already
 * has an opinion about.
 *
 * ── Why trace context propagates into MCP ─────────────────────────────────────
 *
 * A tool call that crosses into an MCP server is the most interesting span boundary in an
 * agentic system and the easiest one to lose: without propagation the server's work
 * becomes an unrelated trace, and the nine seconds are attributed to nothing. MCP's
 * current revision reserves `traceparent`, `tracestate` and `baggage` in `_meta` for
 * exactly this, following W3C Trace Context, so the ids travel and the two halves join up
 * in whatever collector receives them.
 */

import { randomBytes } from "node:crypto";

/** What a finished span carries. Field names are OpenTelemetry's, not ours. */
export interface Span {
  name: string;
  /** Always `client` for a call that leaves this process. */
  kind: "client" | "internal" | "server";
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startTime: number;
  endTime: number;
  attributes: Record<string, string | number | boolean | undefined>;
  status: { code: "ok" | "error"; message?: string };
}

/**
 * Where a finished span goes.
 *
 * One method, deliberately. Anything richer would be this file inventing an SDK, and the
 * whole point is that the application already has one.
 */
export type Tracer = (span: Span) => void;

/** The operations the convention names. Only these three occur here. */
export type Operation = "chat" | "execute_tool" | "embeddings";

/** A trace and span id, in the hex forms W3C Trace Context requires. */
export const newTraceId = (): string => randomBytes(16).toString("hex");
export const newSpanId = (): string => randomBytes(8).toString("hex");

/**
 * Where in a trace this call sits.
 *
 * Carried explicitly rather than kept in an ambient context, because an ambient context
 * in a runtime with concurrent requests is a way to attribute one caller's work to
 * another — and this framework runs agent turns in parallel by design.
 */
export interface TraceContext {
  traceId: string;
  spanId: string;
  /** Vendor state, passed through untouched. */
  traceState?: string;
}

/**
 * A `traceparent` header, W3C Trace Context version 00.
 *
 * `01` in the flags means sampled. A span nobody records is a span nobody can join to,
 * and the sampling decision belongs to the collector rather than to a framework that
 * cannot see the whole trace.
 */
export function traceparentOf(context: TraceContext): string {
  return `00-${context.traceId}-${context.spanId}-01`;
}

/**
 * Read a `traceparent` back, or nothing when it is not one.
 *
 * Strict on purpose: a malformed header means the upstream is not speaking the standard,
 * and inventing a trace id from a broken one produces a trace that looks joined and is
 * not — which is worse than an obviously separate trace, because nobody investigates it.
 */
export function parseTraceparent(header: string | null | undefined): TraceContext | undefined {
  if (!header) return undefined;
  const parts = header.trim().split("-");
  if (parts.length < 4) return undefined;
  const [version, traceId, spanId] = parts;
  if (version !== "00" || !traceId || !spanId) return undefined;
  if (!/^[0-9a-f]{32}$/.test(traceId) || !/^[0-9a-f]{16}$/.test(spanId)) return undefined;
  // All-zero ids are explicitly invalid in the spec.
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return undefined;
  return { traceId, spanId };
}

/** The `_meta` keys MCP reserves for trace context. Not ours to rename. */
export function traceMeta(context: TraceContext | undefined): Record<string, string> {
  if (!context) return {};
  return {
    traceparent: traceparentOf(context),
    ...(context.traceState ? { tracestate: context.traceState } : {}),
  };
}

/** What a call needs to say about itself for the span to be conformant. */
export interface SpanRequest {
  operation: Operation;
  /** `anthropic`, `openai`, `gcp.gemini` — the provider, as the convention spells it. */
  provider: string;
  /** The model asked for. Conditionally required, and always available here. */
  model?: string;
  /** For `execute_tool`: what was called. */
  toolName?: string;
  parent?: TraceContext;
}

export interface SpanResult {
  /** The model that actually answered, when it differs from the one asked for. */
  responseModel?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Extra attributes, already named in the convention's vocabulary. */
  attributes?: Record<string, string | number | boolean | undefined>;
}

/**
 * Time one call and hand the span over.
 *
 * Wraps rather than instruments, so a call that throws still produces a span — a failing
 * request is the one most worth having in a trace, and an exception path that skips the
 * span is how a dashboard comes to show only successes and a suspiciously good latency.
 */
export async function traced<T>(
  tracer: Tracer | undefined,
  request: SpanRequest,
  work: (context: TraceContext) => Promise<T>,
  describe?: (value: T) => SpanResult,
): Promise<T> {
  const context: TraceContext = {
    traceId: request.parent?.traceId ?? newTraceId(),
    spanId: newSpanId(),
    traceState: request.parent?.traceState,
  };
  if (!tracer) return work(context);

  const startTime = Date.now();
  const base: Record<string, string | number | boolean | undefined> = {
    "gen_ai.operation.name": request.operation,
    "gen_ai.provider.name": request.provider,
    ...(request.model ? { "gen_ai.request.model": request.model } : {}),
    ...(request.toolName ? { "gen_ai.tool.name": request.toolName } : {}),
  };

  // The convention's name format. Dashboards group on this, so it is not free-form.
  const name =
    request.operation === "execute_tool"
      ? `${request.operation} ${request.toolName ?? ""}`.trim()
      : `${request.operation} ${request.model ?? ""}`.trim();

  try {
    const value = await work(context);
    const described = describe?.(value) ?? {};
    tracer({
      name,
      kind: "client",
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: request.parent?.spanId,
      startTime,
      endTime: Date.now(),
      attributes: {
        ...base,
        ...(described.responseModel ? { "gen_ai.response.model": described.responseModel } : {}),
        ...(described.inputTokens === undefined ? {} : { "gen_ai.usage.input_tokens": described.inputTokens }),
        ...(described.outputTokens === undefined ? {} : { "gen_ai.usage.output_tokens": described.outputTokens }),
        ...described.attributes,
      },
      status: { code: "ok" },
    });
    return value;
  } catch (err) {
    tracer({
      name,
      kind: "client",
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: request.parent?.spanId,
      startTime,
      endTime: Date.now(),
      attributes: {
        ...base,
        // The convention asks for the error TYPE rather than its message: a dashboard
        // groups on the type, and a message containing an id makes every failure unique.
        "error.type": (err as Error)?.constructor?.name ?? "Error",
      },
      status: { code: "error", message: (err as Error)?.message },
    });
    throw err;
  }
}
