/**
 * The runtime contract, satisfied by the built-in runtime in
 * src/harness/builtin.ts. Everything above this line — server, CLI, workflow
 * runner — is written against `Harness` rather than against that file, so a
 * test can stand in its own runtime without touching anything else.
 */

import type { AnswerSelf } from "./selves.js";
import type { Effect, Quality } from "../define.js";
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

/**
 * Something sent along with a question that is not text: an image, a PDF, a recording.
 *
 * Either the bytes themselves, base64-encoded, or a URL the endpoint can fetch. Which
 * kinds an endpoint can read is the endpoint's business; one it cannot take is left out
 * of that request and said so in a note, never sent in a shape that reads as an error
 * about something else.
 */
export interface Attachment {
  /** The media type, e.g. `image/png` or `application/pdf`. */
  mime: string;
  /** The bytes, base64-encoded. */
  data?: string;
  /** Where the endpoint can fetch it instead. */
  url?: string;
  /** A file name, for the endpoints that show one to the model. */
  name?: string;
}

/**
 * An interactive view a tool brought with its result: an MCP App.
 *
 * A service's tool may name a `ui://` resource, an HTML page meant to be shown beside the
 * conversation and fed the tool's input and result. This runtime has no screen. It reads
 * the page from the service that declared it and hands it on whole, with what the page
 * has to be told, so that a front end can render it in a sandbox of its own. Nothing here
 * runs the page, and nothing in it reaches a model.
 */
export interface UiView {
  /** The service whose tool this is, as the app names it. The view may call that service only. */
  service: string;
  /** The tool that was called, by the service's own name for it. */
  tool: string;
  /** The `ui://` resource the tool declared. */
  resourceUri: string;
  /** `text/html;profile=mcp-app`. */
  mimeType: string;
  /** The page, as the service served it. Untrusted: it is rendered in a sandbox or not at all. */
  html: string;
  /**
   * What the resource asked of whoever renders it: the origins it may load from (`csp`),
   * the device permissions it wants (`permissions`), a `domain`, `prefersBorder`. A
   * renderer builds the frame's policy from this and allows nothing it does not name.
   */
  meta?: Record<string, unknown>;
  /** The arguments the tool was called with: what `ui/notifications/tool-input` carries. */
  toolInput: Record<string, unknown>;
  /** The tool's result as the service returned it: what `ui/notifications/tool-result` carries. */
  toolResult: Record<string, unknown>;
}

/**
 * Why a reply ended, in one vocabulary whichever endpoint wrote it.
 *
 *   "end"     — it finished             "tools"  — it asked for tools
 *   "length"  — it ran out of room      "refusal" — it declined
 *   "filter"  — the endpoint withheld it  "paused" — it stopped part-way and can go on
 *   "error"   — the endpoint gave up on the reply
 */
export type Stop = "end" | "tools" | "length" | "refusal" | "filter" | "paused" | "error";

export interface Message {
  role: "user" | "assistant" | "tool";
  content: string;
  /**
   * What a turn carries besides its text: what was sent with a question, or what a tool
   * handed back with its result — a screenshot, a camera frame, a chart.
   */
  attachments?: Attachment[];
  /**
   * What the endpoint that wrote this turn wants handed back untouched.
   *
   * Reasoning is the usual content: signed thinking blocks, encrypted reasoning items,
   * thought steps. An endpoint that reasons between tool calls expects its own reasoning
   * back with the results, and one that does not get it either refuses the turn or
   * answers as though it had never thought. Opaque here — written by a wire, read only
   * by that same wire, and never carried to another model: the runtime keeps it inside
   * the one rung's conversation it came from.
   */
  replay?: unknown[];
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
  /** A tool brought an interactive view with its result, for a front end to render. */
  | { kind: "ui"; view: UiView }
  /** Something worth telling the developer, which did not stop the request. */
  | { kind: "note"; text: string }
  /**
   * The self this agent is has been read for the request. `ticket` is what a
   * person rates the answer with: bound to them when the app has a ticket secret.
   */
  | { kind: "self"; handle: string; ticket?: string; drewOn: string[] }
  | { kind: "done"; answer: Answer }
  | { kind: "failed"; error: string };

export interface AskOptions {
  /** Start the ask already tainted: something untrusted was read before it began. */
  tainted?: boolean;
  /**
   * What the request is about, when the input carries more than the question.
   *
   * An app that grounds a request — retrieved passages, live figures, a profile
   * of an attached file — sends all of it as the input, because that is what the
   * model must read. None of it is what the person asked, and a self that
   * remembers the wrapper remembers the wrong thing: its memory is looked up by
   * this, and its record of the work reads back with it. Defaults to the input.
   */
  task?: string;
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
   * The cheapest rung this request may start on.
   *
   * The mirror of `ceiling`, and it exists because a ceiling cannot express the
   * one thing a cascade needs after its cheap answer failed: DO NOT ASK THAT
   * MODEL AGAIN. Lifting a ceiling does not move a request up the ladder --
   * the router still enters cheapest-first -- so a caller that rejected the
   * small model's answer and re-asked was served by the same small model,
   * paying for it twice before climbing.
   *
   * Bounded by the same rule as the ceiling, from the other side: it can only
   * REMOVE rungs the agent already declared, never add one. A floor cannot
   * reach a model its author did not put on this agent's ladder, so the
   * denial-of-wallet the ceiling's asymmetry guards against is not opened up
   * here -- the most a floor can do is decline to try the cheap rungs first,
   * which is exactly what a caller holding evidence against them should do.
   *
   * With both set the floor is clamped to the ceiling: a caller asking to start
   * above where it is allowed to finish gets the ceiling, not an empty ladder.
   */
  floor?: Quality;
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
  /**
   * Who the request is for, as the app vouches for them. Names the self of an
   * agent whose self is per person, and binds the answer's ticket to them.
   */
  caller?: { person?: string };
  /** Where the request comes from, for the self's per-surface persona. */
  surface?: string;
  /** Nobody is waiting on this one: a self provider may let it wait behind interactive work. */
  background?: boolean;
  /**
   * What is sent with the question besides its text: images, documents.
   *
   * They belong to this request. A named conversation keeps what was said, not what was
   * shown, so a later turn that needs the file again is sent it again.
   */
  attachments?: Attachment[];
  /**
   * How many agents deep this request already is. Set by the runtime when one agent asks
   * another; a caller has no reason to.
   */
  depth?: number;
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
  /** Of the input, how much the provider was paid to keep for next time. */
  cacheWriteTokens?: number;
  /** Of the output, how much was reasoning nobody read. */
  reasoningTokens?: number;
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
  /** What the model made that is not text — an image, speech — where the endpoint returned any. */
  attachments?: Attachment[];
  /**
   * The interactive views tools brought with their results, in the order the calls were
   * made. For a front end to render; see `UiView`. Absent when no tool brought one.
   */
  ui?: UiView[];
  /** Set when untrusted output was read while producing this answer. */
  tainted?: boolean;
  /** What the endpoints offered as proof of the calls behind this answer (`ChatResponse.evidence`). */
  evidence?: unknown[];
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
  /** The self that gave this answer, when the agent is one. */
  self?: AnswerSelf;
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
  /**
   * What calling it does to the world, as the SERVER declared it.
   *
   * `server/mcp.ts` emits these hints for everything this app publishes, and until now the
   * client threw the same hints away on the way back in — so praecise told other clients that
   * a tool was destructive and could not tell itself. Every remote tool arrived flattened to
   * one privilege level: Google's `delete_event` was indistinguishable from `list_events`.
   *
   * Absent when the server said nothing. That is deliberately NOT the same as `"write"`: a
   * caller deciding whether to gate an action needs to know the difference between a server
   * that declared a safe tool and one that declared nothing at all, and collapsing the two
   * here would spend the distinction before anyone could read it.
   */
  effect?: Effect;
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
  /**
   * The words this endpoint takes for depth, shallowest first. Three unless the provider
   * said otherwise — `low`, `medium`, `high` — because those are the three every
   * endpoint that takes a word at all accepts.
   */
  levels?: readonly string[];
  /**
   * How much of the start of `system` is the same on every request, in characters.
   *
   * What follows it was written for this request — what was recalled, what a self has
   * been reading. An endpoint that keeps a prefix for next time is told where the part
   * worth keeping ends, and one that does not ignores this and reads `system` whole.
   */
  stable?: number;
  /** Mark what is worth keeping for next time, where the endpoint has to be told. Default true. */
  cache?: boolean;
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
  /**
   * Extra headers this endpoint needs, as the provider declared them.
   *
   * Applied last, over everything the wire would otherwise send, because an app that
   * names a header has said something more specific than the wire's default.
   */
  headers?: Record<string, string>;
  /**
   * The header the credential is sent in, where the endpoint does not take a bearer.
   *
   * Some gated endpoints read `Authorization: Bearer` as an anonymous caller and refuse
   * it, and want their own key header instead. Expressing that here rather than in the
   * app is what keeps the credential where it belongs: the harness resolves it from the
   * environment, and nothing above has to read a secret in order to place it.
   */
  credentialHeader?: string;
  /**
   * Fields this endpoint needs that the protocol does not name.
   *
   * Merged UNDER what the wire built, so what a request actually asks for always wins
   * and a config cannot replace the model or the conversation. This is the seam that
   * lets a deployment turn a runtime-specific flag on or off — a template switch on a
   * self-hosted server, say — without a fork of the wire it rides in.
   */
  body?: Record<string, unknown>;
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
  /**
   * `cachedTokens` is what the endpoint said it did not have to read again, and is part
   * of `inputTokens` on every wire, whichever way the endpoint itself counts it.
   */
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
  };
  /** Why the reply ended, as the endpoint put it. Kept for the record. */
  finishReason?: string;
  /** Why the reply ended, in the one vocabulary decisions are made on. */
  stop?: Stop;
  /** What this endpoint wants back with the next turn. See `Message.replay`. */
  replay?: unknown[];
  /** What the model made that is not text, where the endpoint returned any. */
  attachments?: Attachment[];
  /**
   * What the endpoint could not be asked for, said out loud rather than dropped.
   *
   * A wire that cannot send something an author set has two options, and silence is the
   * worse one: the author changed a knob, watched nothing change, and has no way to learn
   * that the knob does not exist on this surface. This is the slot that reaches them.
   * Anything genuinely specific to one wire still belongs on that wire's own response type.
   */
  notes?: string[];
  /**
   * Proof of what the endpoint ran, where it offers one: a signed receipt, an
   * attestation. Opaque here; it travels with the answer and into the journal,
   * and a wire that requires it is the place to refuse a reply without it.
   */
  evidence?: unknown;
}

export type ChatAdapter = (request: ChatRequest) => Promise<ChatResponse>;

/** Thrown for a non-2xx provider response, so callers can hand off or report. */
export class ProviderError extends Error {
  readonly provider: string;
  readonly status: number;
  readonly body: string;
  /** How long the endpoint asked to be left alone, in milliseconds, where it said. */
  readonly retryAfter?: number;
  constructor(
    provider: string,
    status: number,
    body: string,
    retryAfter?: number,
  ) {
    super(`${provider} responded ${status}: ${body.slice(0, 300)}`);
    this.provider = provider;
    this.status = status;
    this.body = body;
    this.retryAfter = retryAfter;
    this.name = "ProviderError";
  }
}
