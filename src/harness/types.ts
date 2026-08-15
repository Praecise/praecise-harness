/**
 * The runtime contract, satisfied by the built-in runtime in
 * src/harness/builtin.ts. Everything above this line — server, CLI, workflow
 * runner — is written against `Harness` rather than against that file, so a
 * test can stand in its own runtime without touching anything else.
 */

import type { Quality } from "../define.js";
import type { TraceContext } from "./trace.js";
import type { AgentPlan } from "../compile/plan.js";

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /**
   * An opaque token minted by some endpoints alongside a call and demanded back
   * verbatim when the transcript is replayed. It is carried, never read.
   * Dropping it refuses the following turn outright, so a loop that calls one
   * tool succeeds and a loop that calls two fails — which reads as a model that
   * cannot hold a tool rather than as a transcript that was assembled wrong.
   */
  seal?: string;
}

export interface Message {
  role: "user" | "assistant" | "tool";
  content: string;
  /** Set on an assistant message that requested tools. */
  toolCalls?: ToolCall[];
  /** Set on a tool result message. */
  toolCallId?: string;
  /** Tool name, on a tool result message. */
  name?: string;
}

/**
 * What is happening, while it happens.
 *
 * The rule this obeys is that nothing reported here is ever taken back. An
 * interface can show every one of these the moment it arrives and never have to
 * rewrite what it showed.
 *
 * That rule is why `text` is rarer than it would be with one model. Checking an
 * answer means asking again and keeping what holds; climbing means throwing a
 * whole answer away. Neither is compatible with having already shown it. So
 * fragments are sent only from a model whose reply is accepted outright, and
 * where that is not known in advance the answer arrives settled, after the work
 * of settling it has been reported step by step.
 */
export type Progress =
  /** Where the request is going, before anything has been spent on it. */
  | { kind: "routing"; entry: string; rungs: number; verify: boolean; difficulty: number }
  /** A model has been asked. */
  | { kind: "answering"; model: string; effort: number }
  /**
   * A fragment of what the agent is saying, which will not be taken back.
   *
   * These add up to the answer for an agent that answers in one go. An agent
   * that reaches for tools also says something on the way to each one, and that
   * is reported here too, in order, between the tool events it explains — so
   * the fragments read as a transcript while `Answer.text` is the conclusion.
   */
  | { kind: "text"; text: string }
  /** The same model is being asked again, to see whether it says the same thing. */
  | { kind: "checking"; samples: number }
  /** It did, or it did not. */
  | { kind: "checked"; agreement: number; kept: boolean }
  /** A stronger model is being asked instead. */
  | { kind: "climbing"; from: string; to: string; why: string }
  | { kind: "tool"; name: string; args: unknown }
  | { kind: "tool result"; name: string; failed: boolean }
  /** The app said not to make that call, and the model was told why. */
  | { kind: "refused"; name: string; why: string }
  /** Something worth telling the developer, which did not stop the request. */
  | { kind: "note"; text: string }
  | { kind: "done"; answer: Answer }
  | { kind: "failed"; error: string };

export interface AskOptions {
  /**
   * Prior turns, oldest first, where the caller would rather keep its own. Left
   * out, a named conversation supplies them instead.
   */
  history?: Message[];
  /**
   * Which conversation this belongs to.
   *
   * Naming one is all it takes to be in it: what was said before is read back
   * and what is said now is added, so nothing has to be held between turns and
   * a conversation outlives the process that was having it.
   */
  thread?: string;
  signal?: AbortSignal;
  /**
   * Called as the work happens. Passing this is also what makes an answer
   * arrive in fragments where it can; a runtime that does not report progress
   * simply never calls it, and the answer is the same either way.
   */
  onProgress?: (event: Progress) => void;
  /**
   * The most expensive rung this request may reach.
   *
   * A CEILING on the agent's declared ladder, never a raise: an author decided what this
   * agent is worth spending on, and a caller may economise below that and never above it.
   * Without the asymmetry, any surface that forwards a caller's preference — `/ask`, an
   * HTTP route, an MCP tool — becomes a way for an unauthenticated request to spend the
   * operator's most expensive model, which is a denial-of-wallet with extra steps.
   *
   * Trimming the ladder rather than picking one rung keeps the router's own behaviour
   * intact: it still escalates when checking says it should, just not past here.
   */
  ceiling?: Quality;
  /**
   * The trace this request is already part of, when the caller arrived inside one.
   *
   * praecise propagated trace context OUTBOUND — into MCP tool calls — from the day it
   * emitted spans, and ignored it inbound, which meant a request that was already half of
   * somebody's trace started a fresh one here. The two halves then sat in a collector as
   * unrelated records of the same work, which is the failure distributed tracing exists to
   * prevent, arrived at by implementing exactly one direction.
   */
  trace?: TraceContext;
}

/** What the tokens for one request went on. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Of the input, how much the provider served from a prefix it had already read. */
  cachedTokens: number;
  /**
   * Of the total, how much went on working out which model should answer rather
   * than on the answer that stands — extra samples, and any rung climbed past.
   * This is what the router costs, kept separate so it can be argued with.
   */
  decidingTokens: number;
}

/** What the router chose for one request, and how that turned out. */
export interface Routing {
  /** How hard the request looked before anything read it, 0..1. */
  difficulty: number;
  /** The model it started on rather than the cheapest one. */
  entry: string;
  /** Whether that model's answer was checked against itself. */
  verified: boolean;
  /** Whether a stronger model was asked in the end. */
  climbed: boolean;
}

export interface Answer {
  text: string;
  /** Parsed object when the agent declared `returns`, else undefined. */
  data?: unknown;
  /**
   * How much this answer was backed up when it was checked against more of the
   * same model, 0..1. Absent when nothing was checked — a number is reported
   * only where one was measured, and never because a model was asked how it
   * felt about its own work.
   */
  agreement?: number;
  /** Models actually consulted, cheapest first. */
  path: string[];
  usage: Usage;
  routing?: Routing;
  /** Tools invoked while producing this answer. */
  toolCalls: { name: string; args: unknown }[];
  /** Which runtime produced this. */
  harness: string;
  /** Non-fatal notes worth showing the developer. */
  notes?: string[];
  /**
   * Set when no model produced this and the text is filler.
   *
   * A first run with no credential still has to do something, and what it did
   * was return a plausible paragraph and report `done` — indistinguishable from
   * an answer to anything reading the result, which is every caller. A field is
   * the fix rather than a phrase in the prose: `answer.placeholder` is one test,
   * and it is absent from every real answer, so a caller that checks it cannot
   * be fooled by a model that happens to write the same sentence.
   */
  placeholder?: true;
}

export interface Harness {
  readonly name: string;
  ask(plan: AgentPlan, input: string, options?: AskOptions): Promise<Answer>;
  close?(): Promise<void>;
}

// ── Provider wire adapters ─────────────────────────────────────────────────

/** A tool as advertised to a model. */
export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  baseUrl: string;
  apiKey: string;
  system: string;
  messages: Message[];
  /**
   * How much room to work in, 0..1. Zero asks for none. This is decided per
   * request rather than fixed per model: the cheapest thing a router can do for
   * an easy question is not to make a strong model think about it.
   */
  effort: number;
  /** How this endpoint takes that request. Declared by the provider. */
  depth?: "effort" | "budget" | "none";
  tools?: ToolSchema[];
  /** Require a JSON object response. */
  json?: boolean;
  /**
   * The exact shape the reply must take, as JSON Schema.
   *
   * When an endpoint supports it, this is not a request — it is CONSTRAINED DECODING,
   * and a reply outside the schema is not merely unlikely but unreachable. Three of the
   * endpoints this framework speaks to guarantee conformance that way; one of them names
   * the mechanism in its own documentation and says no retry is needed.
   *
   * That is the whole reason this field exists separately from `json`. Asking in prose —
   * "reply with JSON in exactly this shape" — and validating afterwards is a different
   * and worse thing: it fails sometimes, it fails at the end of a generation you already
   * paid for, and the failure looks like a model being stupid rather than a request being
   * under-specified. An adapter that has the native mechanism must use it and never fall
   * back to asking nicely, because the two have different guarantees and a caller cannot
   * tell them apart from the outside.
   */
  schema?: Record<string, unknown>;
  maxTokens?: number;
  signal?: AbortSignal;
  fetch: typeof fetch;
  /**
   * Called with each fragment of the answer as it arrives, which is also what
   * asks the endpoint to stream in the first place.
   *
   * Set only where a fragment can be shown at once and will not be taken back.
   * Which requests those are is the router's business, not the adapter's. What
   * comes back at the end is the same complete response either way, so nothing
   * above here has to know which mode it got.
   */
  onText?: (text: string) => void;
}

export interface ChatResponse {
  text: string;
  toolCalls: ToolCall[];
  /** `cachedTokens` is what the endpoint said it did not have to read again. */
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number };
  /** Provider-native stop reason; "refusal" means the answer should not stand. */
  finishReason?: string;
  /**
   * What the endpoint could not be asked for, said out loud rather than dropped.
   *
   * A wire that cannot send something an author set has two options, and silence is the
   * worse one: the author changed a knob, watched nothing change, and has no way to learn
   * that the knob does not exist on this surface. This is the slot that reaches them.
   * Anything genuinely specific to one wire still belongs on that wire's own response type.
   */
  notes?: string[];
}

export type ChatAdapter = (request: ChatRequest) => Promise<ChatResponse>;

/** Thrown for a non-2xx provider response, so callers can hand off or report. */
export class ProviderError extends Error {
  readonly provider: string;
  readonly status: number;
  readonly body: string;
  constructor(
    provider: string,
    status: number,
    body: string,
  ) {
    super(`${provider} responded ${status}: ${body.slice(0, 300)}`);
    this.provider = provider;
    this.status = status;
    this.body = body;
    this.name = "ProviderError";
  }
}
