/**
 * The "interactions" shape — the surface Google made its primary one for Gemini, and the
 * one new capability lands on first.
 *
 * `generateContent` (the `contents` wire next door) is NOT dead: it still works, and it
 * still serves the current model. This adapter exists because the vendor's own migration
 * material points here and because everything shipped since is documented against this
 * endpoint — following where features land, not restoring broken access. An app that has
 * a working `contents` rung has no reason to be alarmed; it has a reason to move when it
 * wants something only this surface offers. Verified against the vendor's documentation
 * on 2026-08-14; every difference below is one this file had to be written around.
 *
 * ── CONSTRAINT: the same vendor, a DIFFERENT request grammar ───────────────────
 *
 * A reader who knows `contents.ts` will assume this is a rename. It is not, and every
 * one of the differences fails quietly rather than loudly:
 *
 *   • The system prompt is a PLAIN STRING at the top level (`system_instruction`), not
 *     `{parts: [{text}]}`. The sibling wire's object is the shape most code already has
 *     lying around, so this is the single easiest mistake to make here, and a dropped
 *     system prompt does not error — it produces a model that has simply forgotten who
 *     it is, which reads as a bad model rather than as a malformed request.
 *   • Content is TYPED, not role/parts shaped: `{type:"text",text}`, and for binary
 *     `{type:"image"|"document", data, mime_type}`. There is no `parts` array anywhere.
 *   • `generation_config` is snake_case here and camelCase there. Same vendor, same
 *     concepts, different spelling — an unknown key is not an error on either.
 *
 * ── CONSTRAINT: temperature no longer exists, so it is never sent ──────────────
 *
 * The vendor's migration checklist says verbatim to strip `temperature`, `top_p` and
 * `top_k` from generation configs, and the changelog marks them deprecated for this model
 * generation. So this adapter sends NO sampling knob — not a value a caller supplied, and
 * not a "safe" zero either. A zero is the worst of the options available: it is a
 * DIFFERENT assumption from the one the caller made, silently substituted for it.
 *
 * `ChatRequest` has no `temperature` field, which is the framework agreeing with the
 * vendor. But an app can still hand one over — the interface does not exist at runtime —
 * and the previous behaviour for that would have been to drop it without a word. Instead
 * it is RECORDED: the returned response carries a note saying the knob was ignored and
 * why. Determinism on this generation comes from `seed` and from constraining the output
 * space with a schema, not from lowering temperature, and a caller who thinks they have
 * pinned a model down when they have not is worse off than one who is told they cannot.
 *
 * (Whether sending one returns a 400 or is silently ignored is UNCONFIRMED. It is not
 * worth confirming: this file never sends one, so both outcomes are unreachable.)
 *
 * ── CONSTRAINT: `minimal` thinking is real, and the flash model rejects it ─────
 *
 * The API enum is `minimal | low | medium | high`, and the current flash model ERRORS on
 * `minimal`. Stripping `minimal` globally would be the easy fix and the wrong one — it
 * would throw away the cheapest depth setting on every model that does accept it, which
 * is exactly what a router asking for the least depth it can get away with was trying to
 * buy. So it is gated PER MODEL and raised to `low` only where it is refused.
 *
 * The other half of that fact matters more than it looks: the flash model's own default
 * is `medium`. Omitting `thinking_level` does not mean "do not think" on this surface, it
 * means "think a medium amount, and bill me for it". `depth: "none"` therefore buys
 * silence about depth, not the absence of it, and nothing here pretends otherwise.
 *
 * ── CONSTRAINT: thought tokens are billed, and invisible unless counted ────────
 *
 * Usage arrives as `total_*` fields including `total_thought_tokens`, which on a hard
 * request is most of what the request cost. `ChatResponse.usage` has three slots, so
 * thoughts are folded into `outputTokens` — the same choice `contents.ts` makes, for the
 * same reason: they are output, they are charged as output, and a router that reads only
 * the visible answer's tokens understates the expensive requests by the largest margin
 * precisely where the spend matters. They are ALSO surfaced separately, because "how much
 * of this went on thinking" is a question a caller cannot otherwise ask.
 *
 * ── CONSTRAINT: the answer must be recoverable without the vendor's SDK ────────
 *
 * `output_text` here is a REAL wire field, unlike the identically-named field on the
 * `responses` shape, which is synthesised by that vendor's SDKs and absent from the JSON.
 * Two surfaces, one field name, opposite truths. This adapter reads `output_text` when it
 * is there and otherwise walks `steps[]` for `model_output` steps and their `text`
 * content — so it is correct under both, and does not depend on a convenience field
 * staying convenient.
 *
 * ── CONSTRAINT: a schema is a guarantee; a mime type is a hint ─────────────────
 *
 * `response_format` is an OBJECT here — `{type:"text", mime_type:"application/json",
 * schema}` — where the sibling wire has two flat `generationConfig` keys. The vendor says
 * plainly that `application/json` WITHOUT a schema is only "a strong hint", so the schema
 * goes whenever the request carries one and the hint is never relied on alone. The
 * vendor's language about schema conformance is softer than other vendors' ("always
 * validate values in your application"), so this is documented as strong constraint
 * rather than as a proof — the framework validates the reply anyway.
 * `mime_type: "text/x.enum"` is UNCONFIRMED on this surface and consequently never sent;
 * an enum is expressed inside the schema, which is confirmed.
 *
 * ── What is unverified, and what this file does about it ──────────────────────
 *
 *   • Mixing typed Content and Steps in one `input` array. The documented forms are a
 *     string, a Content, an array of Content, or an array of Step — a multi-turn
 *     transcript with tool traffic needs both kinds, and the alternatives are inventing
 *     an unverified step type for user turns or flattening the transcript into prose with
 *     role prefixes. Both are worse than a shape the endpoint is likely to accept, and a
 *     single-turn request (the common case) uses only the confirmed Content form.
 *   • Whether `arguments` on a `function_call` step is an object or a JSON string. The
 *     reader accepts BOTH; the writer sends an object, matching this vendor's other
 *     surface, where args have always been objects.
 *   • The terminal streaming frame's name. Usage and finish reason are therefore taken
 *     from whatever frame carries them rather than from a frame matched by name.
 *   • `is_error` on a tool result. The transcript handed to this adapter does not record
 *     whether a tool failed, and sending `is_error: false` would assert something unknown,
 *     so the field is omitted and the error text stands as the result.
 */

import type { ChatAdapter, ChatRequest, ChatResponse, Message, ToolCall } from "../types.js";
import { ProviderError } from "../types.js";
import { levelOf } from "./effort.js";
import { events } from "./sse.js";

/** Depth, as this surface names it. `minimal` is not reachable on every model. */
export type ThinkingLevel = "minimal" | "low" | "medium" | "high";

/**
 * What this wire knows that `ChatResponse` has no slot for.
 *
 * It is a widening, never a replacement: everything above this file reads a plain
 * `ChatResponse` and is unaffected. A caller holding this adapter directly can read the
 * extra fields; one holding it through the registry sees the three-field usage and the
 * thought tokens already folded into `outputTokens`, which is the number it would have
 * been billed for either way.
 */
export interface InteractionsResponse extends ChatResponse {
  /** Things the endpoint could not be asked for, said out loud rather than dropped. */
  notes?: string[];
  /** Of the output, how much went on thinking. Billed, and otherwise invisible. */
  thoughtTokens?: number;
  /** Tokens spent on tool use, which this surface reports and others do not. */
  toolUseTokens?: number;
}

interface StepContent {
  type?: string;
  text?: string;
}

interface Step {
  type?: string;
  content?: StepContent[];
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: unknown;
}

interface UsagePayload {
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_thought_tokens?: number;
  total_cached_tokens?: number;
  total_tool_use_tokens?: number;
  total_tokens?: number;
}

interface InteractionPayload {
  /** A real wire field on THIS surface. See the header. */
  output_text?: string;
  steps?: Step[];
  usage?: UsagePayload;
  status?: string;
  finish_reason?: string;
  incomplete_details?: { reason?: string };
}

/** Sampling knobs this model generation removed. Named so a note can name them. */
const REMOVED_KNOBS = ["temperature", "top_p", "topP", "top_k", "topK"] as const;

/**
 * Which removed knobs a caller handed over anyway.
 *
 * Read off the request object rather than off the type, because the type is not there at
 * runtime and this is precisely the case where an app is carrying an assumption the
 * endpoint will not honour.
 */
export function removedKnobsIn(request: ChatRequest): string[] {
  const carried = request as unknown as Record<string, unknown>;
  return REMOVED_KNOBS.filter((knob) => carried[knob] !== undefined);
}

/**
 * Whether a model accepts the cheapest thinking level.
 *
 * The current flash model errors on `minimal`. Matching by family rather than by exact id
 * is deliberate: model ids gain date suffixes and `-preview` tails on someone else's
 * schedule, and a list of exact ids goes stale silently — as a request that starts
 * failing, which is the failure this gate exists to prevent.
 */
export function acceptsMinimalThinking(model: string): boolean {
  return !/flash/i.test(model);
}

/** Effort 0..1 as a level this model will actually accept. */
export function thinkingLevelFor(effort: number, model: string): ThinkingLevel {
  const wanted: ThinkingLevel = effort < 0.15 ? "minimal" : levelOf(effort);
  return wanted === "minimal" && !acceptsMinimalThinking(model) ? "low" : wanted;
}

/**
 * Conversation → `input`.
 *
 * A user turn is a typed Content. An assistant turn is a `model_output` step shaped
 * exactly like the one the endpoint sent back, because the safest transcript to replay is
 * the one the endpoint wrote. Tool traffic is its own step kind in each direction, and a
 * result names the call it answers rather than sitting in a role, which means an
 * out-of-order transcript is a correlation error rather than a silent mismatch.
 */
export function toInput(messages: Message[]): Record<string, unknown>[] {
  const input: Record<string, unknown>[] = [];

  for (const message of messages) {
    if (message.role === "tool") {
      input.push({
        type: "function_result",
        call_id: message.toolCallId ?? "",
        result: message.content ?? "",
      });
      continue;
    }

    if (message.role === "assistant") {
      if (message.content) {
        input.push({ type: "model_output", content: [{ type: "text", text: message.content }] });
      }
      // The turn that asked for tools usually says nothing at all. Dropping it for having
      // no prose leaves a result answering a call the transcript never made.
      for (const call of message.toolCalls ?? []) {
        input.push({ type: "function_call", id: call.id, name: call.name, arguments: call.args ?? {} });
      }
      continue;
    }

    if (message.content) input.push({ type: "text", text: message.content });
  }

  return input;
}

/** Text, from the convenience field if the endpoint sent one and from the steps if not. */
export function textOf(payload: InteractionPayload): string {
  if (typeof payload.output_text === "string" && payload.output_text) return payload.output_text;
  return (payload.steps ?? [])
    .filter((step) => step.type === "model_output")
    .flatMap((step) => step.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

/** Arguments may arrive as an object or as a JSON string; a broken one is an empty call. */
function argsOf(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    // A tool call the model got wrong should surface as a refused call, not a crash.
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toolCallsOf(payload: InteractionPayload): ToolCall[] {
  return (payload.steps ?? [])
    .filter((step) => step.type === "function_call")
    .map((step) => ({
      // Documented here as `id`, echoed back under the name `call_id`. `call_id` is
      // preferred where the endpoint sends both — on the neighbouring `responses` shape
      // the two are different strings and echoing the wrong one produces a result the
      // model quietly ignores, so the key named after the echo wins.
      id: step.call_id ?? step.id ?? "",
      name: step.name ?? "",
      args: argsOf(step.arguments),
    }));
}

/**
 * Output tokens, thoughts included — with a guard against counting them twice.
 *
 * Whether `total_output_tokens` already contains the thoughts is not documented. Adding
 * blind would double-bill a thinking request in the router's ledger; ignoring them would
 * understate it by most of its cost. So the reported total arbitrates where there is one:
 * if input + output + thoughts does not fit inside `total_tokens`, the thoughts were
 * already inside `output` and are not added again.
 */
export function outputTokensOf(usage: UsagePayload | undefined): number {
  const output = usage?.total_output_tokens ?? 0;
  const thoughts = usage?.total_thought_tokens ?? 0;
  if (!thoughts) return output;
  const total = usage?.total_tokens ?? 0;
  const input = usage?.total_input_tokens ?? 0;
  const counted = input + output + thoughts <= total;
  return total > 0 && !counted ? output : output + thoughts;
}

function usageOf(usage: UsagePayload | undefined): InteractionsResponse["usage"] {
  return {
    inputTokens: usage?.total_input_tokens ?? 0,
    outputTokens: outputTokensOf(usage),
    cachedTokens: usage?.total_cached_tokens ?? 0,
  };
}

/**
 * The endpoint, from whatever root the app configured.
 *
 * An app already talking to this vendor points at the versioned root — the `contents` wire
 * builds `{baseUrl}/models/…` on top of it — so appending the version again would produce
 * `/v1beta/v1beta/interactions`: a 404 that reads exactly like the surface not existing,
 * which is the wrong conclusion to hand someone on their first attempt at it.
 */
export function urlFor(baseUrl: string): string {
  const root = baseUrl.replace(/\/+$/, "");
  return /\/v\d[^/]*$/.test(root) ? `${root}/interactions` : `${root}/v1beta/interactions`;
}

export const interactionsWire: ChatAdapter = async (request: ChatRequest): Promise<ChatResponse> => {
  const notes = removedKnobsIn(request).map(
    (knob) =>
      `\`${knob}\` was not sent: this model generation removed temperature, top_p and top_k, ` +
      `and the vendor's migration checklist says to strip them. Use \`seed\` for repeatability ` +
      `and a schema to constrain the output space.`,
  );

  const body: Record<string, unknown> = { model: request.model, input: toInput(request.messages) };

  // A plain string, at the top level. The sibling wire's `{parts:[{text}]}` object is the
  // shape most Gemini code already has, and sending it here loses the instruction.
  if (request.system) body.system_instruction = request.system;

  const generationConfig: Record<string, unknown> = {};
  if (request.maxTokens) generationConfig.max_output_tokens = request.maxTokens;

  // There is no token-budget form of depth on this surface — a rung declaring `budget`
  // gets the level form anyway, because the alternative is sending a field this endpoint
  // has dropped and getting a default it never mentioned.
  if (request.depth && request.depth !== "none") {
    generationConfig.thinking_level = thinkingLevelFor(request.effort, request.model);
    // Summaries are prose about the answer rather than the answer. The framework's rule is
    // that nothing shown is taken back, so a summary could not be streamed to a caller as
    // answer text — and paying for output that is then discarded is a cost with no reader.
    generationConfig.thinking_summaries = "none";
  }
  if (Object.keys(generationConfig).length) body.generation_config = generationConfig;

  // NO temperature, top_p or top_k is set anywhere above or below this line. See header.

  if (request.schema) {
    body.response_format = { type: "text", mime_type: "application/json", schema: request.schema };
  } else if (request.json) {
    // Documented as "a strong hint" without a schema, and it is sent as such — the caller
    // asked for JSON and did not declare a shape, so a hint is all there is to send.
    body.response_format = { type: "text", mime_type: "application/json" };
  }

  if (request.tools?.length) {
    body.tools = request.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  // Explicit, because the default is not documented and the choice is not this file's to
  // make silently: the framework already keeps the transcript it replays, so a server-side
  // copy would be data retention the app never asked for. `background` is likewise never
  // sent — it turns the reply into a job handle, and this adapter's contract is an answer.
  body.store = false;

  // Streaming is a flag in the BODY here, not a different method or a URL suffix as it is
  // on the sibling wire.
  if (request.onText) body.stream = true;

  const response = await request.fetch(urlFor(request.baseUrl), {
    method: "POST",
    headers: {
      // The key goes in a header rather than in `?key=`, so it stays out of proxy logs,
      // browser history and error reports that quote the URL.
      "x-goog-api-key": request.apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: request.signal,
  });

  if (!response.ok) {
    throw new ProviderError("interactions", response.status, await response.text());
  }

  if (request.onText) return readStream(response, request.onText, notes);

  const payload = (await response.json()) as InteractionPayload;
  const answer: InteractionsResponse = {
    text: textOf(payload),
    toolCalls: toolCallsOf(payload),
    usage: usageOf(payload.usage),
    thoughtTokens: payload.usage?.total_thought_tokens ?? 0,
    toolUseTokens: payload.usage?.total_tool_use_tokens ?? 0,
    // A truncated answer reporting "completed" is indistinguishable from a short one, so
    // the most specific of the three fields the surface may use wins.
    finishReason: payload.incomplete_details?.reason ?? payload.finish_reason ?? payload.status,
    ...(notes.length ? { notes } : {}),
  };
  return answer;
};

/** One SSE frame. Named events carry their own name in the payload as `event_type`. */
interface StreamFrame {
  event_type?: string;
  index?: number;
  delta?: { type?: string; text?: string };
  step?: Step;
  interaction?: InteractionPayload;
  usage?: UsagePayload;
  status?: string;
  finish_reason?: string;
}

/**
 * Accumulate a streamed answer.
 *
 * Only deltas that say they are text are shown. A delta of some other kind — a thought
 * summary, most likely — must not reach a caller as answer text, because a fragment
 * handed over is never taken back. An untyped delta carrying a string is accepted, since
 * the frames documented for this surface carry `type: "text"` and a stricter reader would
 * drop the whole answer if that ever became implicit.
 */
async function readStream(
  response: Response,
  onText: (text: string) => void,
  notes: string[],
): Promise<ChatResponse> {
  const called: Step[] = [];
  let text = "";
  let final: InteractionPayload | undefined;
  let usage: UsagePayload | undefined;
  let finishReason: string | undefined;

  for await (const frame of events(response.body)) {
    const event = frame as StreamFrame;

    const delta = event.delta;
    if (delta && typeof delta.text === "string" && (delta.type === undefined || delta.type === "text")) {
      text += delta.text;
      onText(delta.text);
    }

    if (event.step?.type === "function_call") called.push(event.step);
    if (event.interaction) final = event.interaction;

    // Taken from whatever frame carries them: the terminal frame's name is unverified,
    // and a reader keyed on a guessed name reports zero usage on every streamed request.
    if (event.interaction?.usage) usage = event.interaction.usage;
    else if (event.usage) usage = event.usage;
    if (event.finish_reason) finishReason = event.finish_reason;
  }

  const closing = final?.incomplete_details?.reason ?? final?.finish_reason ?? final?.status;
  const answer: InteractionsResponse = {
    // The deltas are what the caller was actually shown, so they are the answer. A final
    // payload is only consulted where nothing streamed.
    text: text || (final ? textOf(final) : ""),
    toolCalls: final?.steps?.length ? toolCallsOf(final) : toolCallsOf({ steps: called }),
    usage: usageOf(usage ?? final?.usage),
    thoughtTokens: (usage ?? final?.usage)?.total_thought_tokens ?? 0,
    toolUseTokens: (usage ?? final?.usage)?.total_tool_use_tokens ?? 0,
    finishReason: closing ?? finishReason,
    ...(notes.length ? { notes } : {}),
  };
  return answer;
}
