/**
 * The runtime contract, satisfied by the built-in runtime in
 * src/harness/builtin.ts. Everything above this line — server, CLI, workflow
 * runner — is written against `Harness` rather than against that file, so a
 * test can stand in its own runtime without touching anything else.
 */

import type { AgentPlan } from "../compile/plan.js";

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
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

export interface AskOptions {
  /** Prior turns, oldest first. */
  history?: Message[];
  /** Conversation key for memory recall and persistence. */
  thread?: string;
  signal?: AbortSignal;
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
  /** Ask for more reasoning depth where the provider supports it. */
  thinking: boolean;
  /** How this endpoint takes that request. Declared by the provider. */
  depth?: "effort" | "budget" | "none";
  tools?: ToolSchema[];
  /** Require a JSON object response. */
  json?: boolean;
  maxTokens?: number;
  signal?: AbortSignal;
  fetch: typeof fetch;
}

export interface ChatResponse {
  text: string;
  toolCalls: ToolCall[];
  /** `cachedTokens` is what the endpoint said it did not have to read again. */
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number };
  /** Provider-native stop reason; "refusal" means the answer should not stand. */
  finishReason?: string;
}

export type ChatAdapter = (request: ChatRequest) => Promise<ChatResponse>;

/** Thrown for a non-2xx provider response, so callers can hand off or report. */
export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${provider} responded ${status}: ${body.slice(0, 300)}`);
    this.name = "ProviderError";
  }
}
