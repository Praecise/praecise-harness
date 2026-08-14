/**
 * The "responses" shape — an items-in, items-out surface that two major vendors have
 * now made their primary one, with the older chat-completions endpoint explicitly
 * demoted to legacy on at least one of them.
 *
 * It is close enough to chat-completions to look like a rename and different enough to
 * break a client that assumes it is one. Verified against vendor documentation on
 * 2026-08-14; every difference below is one this adapter had to be written around.
 *
 * ── The trap that would bite a zero-dependency client hardest ──────────────────
 *
 * There IS a convenience field called `output_text`, and it is **not on the wire**. It is
 * synthesised by the vendors' own SDKs. A hand-written client that reads it gets
 * `undefined` on every call, and the failure looks like the model returning nothing.
 * The text lives in `output[].content[].text`, and one vendor's docs say plainly that it
 * is "not safe to assume" it sits at `output[0].content[0].text` — reasoning items and
 * tool calls occupy that array too, so it has to be walked and filtered, never indexed.
 *
 * ── Where the two vendors that speak this shape disagree ───────────────────────
 *
 * System instructions. One takes them as a top-level `instructions` field; the other
 * documents the system prompt as an ordinary role INSIDE `input`. Sending the wrong one
 * does not error — it silently drops the instructions, which is the worst failure mode
 * available. So the shape is chosen by `systemAs`, declared per endpoint, and defaults
 * to the role form because a system role inside the conversation is understood by both.
 *
 * ── Structured output nests differently here than on chat-completions ──────────
 *
 * On this surface `strict` is a SIBLING of `schema` inside `text.format`. On
 * chat-completions it lives inside a named `json_schema` wrapper. Same vendor, same
 * feature, different nesting — get it wrong and the constraint is silently not applied,
 * which is exactly the class of bug that makes a guarantee worthless.
 *
 * ── Tool calls ────────────────────────────────────────────────────────────────
 *
 * Tools are flat (no `function` wrapper). A call arrives as an item whose `arguments` is
 * a JSON-ENCODED STRING, and the key to echo back is `call_id`, not `id` — the item has
 * both, and they are different values. A result goes back as a `function_call_output`
 * item, not a message with a tool role.
 */

import type { ChatAdapter, ChatRequest, ChatResponse, Message, ToolCall } from "../types.js";
import { ProviderError } from "../types.js";
import { levelOf } from "./effort.js";
import { events } from "./sse.js";

/** How an endpoint on this shape wants its system prompt. */
export type SystemAs = "instructions" | "role";

interface OutputContent {
  type?: string;
  text?: string;
}

interface OutputItem {
  type?: string;
  role?: string;
  content?: OutputContent[];
  /** Present on a function_call item. */
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
}

interface ResponsePayload {
  output?: OutputItem[];
  status?: string;
  incomplete_details?: { reason?: string };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  };
}

/** Conversation → input items. A tool result is its own item kind here. */
function toInput(messages: Message[]): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      items.push({
        type: "function_call_output",
        call_id: message.toolCallId ?? "",
        output: message.content ?? "",
      });
      continue;
    }
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        items.push({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.args ?? {}),
        });
      }
    }
    if (message.content) items.push({ role: message.role, content: message.content });
  }
  return items;
}

/** Walk the output items for text. Never index — reasoning and tool items share the array. */
export function textOf(payload: ResponsePayload): string {
  return (payload.output ?? [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "output_text")
    .map((part) => part.text ?? "")
    .join("");
}

export function toolCallsOf(payload: ResponsePayload): ToolCall[] {
  return (payload.output ?? [])
    .filter((item) => item.type === "function_call")
    .map((item) => ({
      // `call_id` is the one to echo back; `id` is the item's own identity and is
      // a different string. Sending `id` produces an unmatched result the model ignores.
      id: item.call_id ?? item.id ?? "",
      name: item.name ?? "",
      args: parseArgs(item.arguments),
    }));
}

/** Arguments arrive as a JSON string. A malformed one is empty rather than a throw:
 *  a tool call the model got wrong should surface as a refused call, not a crash. */
function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function responsesWire(options: { systemAs?: SystemAs; reasoning?: boolean } = {}): ChatAdapter {
  const systemAs = options.systemAs ?? "role";
  const sendsReasoning = options.reasoning ?? true;

  return async (request: ChatRequest): Promise<ChatResponse> => {
    const input = toInput(request.messages);
    const body: Record<string, unknown> = { model: request.model };

    if (request.system) {
      if (systemAs === "instructions") body.instructions = request.system;
      else input.unshift({ role: "system", content: request.system });
    }
    body.input = input;

    if (request.maxTokens) body.max_output_tokens = request.maxTokens;

    // Depth is an effort word on this surface, not a token budget.
    if (sendsReasoning && request.depth !== "none") {
      body.reasoning = { effort: levelOf(request.effort) };
    }

    // `strict` sits BESIDE `schema` here — see the header. With a schema this is
    // constrained decoding; without one, asking for a JSON object is only a request.
    if (request.schema) {
      body.text = { format: { type: "json_schema", name: "reply", strict: true, schema: request.schema } };
    } else if (request.json) {
      body.text = { format: { type: "json_object" } };
    }

    if (request.tools?.length) {
      body.tools = request.tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));
    }

    if (request.onText) body.stream = true;

    const response = await request.fetch(`${request.baseUrl.replace(/\/$/, "")}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${request.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: request.signal,
    });

    if (!response.ok) throw new ProviderError("responses", response.status, await response.text());
    if (request.onText) return readStream(response, request.onText);

    const payload = (await response.json()) as ResponsePayload;
    return {
      text: textOf(payload),
      toolCalls: toolCallsOf(payload),
      usage: {
        inputTokens: payload.usage?.input_tokens ?? 0,
        outputTokens: payload.usage?.output_tokens ?? 0,
        cachedTokens: payload.usage?.input_tokens_details?.cached_tokens ?? 0,
      },
      // An incomplete response says why in its own field; a truncated answer that
      // reports "completed" would be indistinguishable from a short one.
      finishReason: payload.incomplete_details?.reason ?? payload.status,
    };
  };
}

interface StreamEvent {
  type?: string;
  delta?: string;
  response?: ResponsePayload;
}

async function readStream(response: Response, onText: (text: string) => void): Promise<ChatResponse> {
  let text = "";
  let final: ResponsePayload | undefined;

  for await (const frame of events(response.body)) {
    const event = frame as StreamEvent;
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      text += event.delta;
      onText(event.delta);
    } else if (event.type === "response.completed" || event.type === "response.incomplete") {
      final = event.response;
    }
  }

  // Tool calls and usage come from the terminal event's whole response object rather
  // than being accumulated from deltas — the deltas carry text only.
  return {
    text: final ? textOf(final) || text : text,
    toolCalls: final ? toolCallsOf(final) : [],
    usage: {
      inputTokens: final?.usage?.input_tokens ?? 0,
      outputTokens: final?.usage?.output_tokens ?? 0,
      cachedTokens: final?.usage?.input_tokens_details?.cached_tokens ?? 0,
    },
    finishReason: final?.incomplete_details?.reason ?? final?.status,
  };
}
