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

export interface Answer {
  text: string;
  /** Parsed object when the agent declared `returns`, else undefined. */
  data?: unknown;
  /** 0..1 self-reported, used to decide hand-off. 1 when nothing to hand off to. */
  confidence: number;
  /** Models actually consulted, cheapest first. */
  path: string[];
  usage: { inputTokens: number; outputTokens: number };
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
  usage: { inputTokens: number; outputTokens: number };
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
