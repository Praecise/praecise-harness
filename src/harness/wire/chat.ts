import type { ChatAdapter, ChatRequest, ChatResponse, Message, ToolCall } from "../types.js";
import { ProviderError } from "../types.js";

interface RequestToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface RequestMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: RequestToolCall[];
  tool_call_id?: string;
}

interface ResponseToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface ResponsePayload {
  choices?: {
    message?: { content?: string | null; tool_calls?: ResponseToolCall[] };
    finish_reason?: string;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

function toMessages(system: string, messages: Message[]): RequestMessage[] {
  const out: RequestMessage[] = [];
  if (system) out.push({ role: "system", content: system });

  for (const message of messages) {
    if (message.role === "tool") {
      out.push({
        role: "tool",
        content: message.content ?? "",
        tool_call_id: message.toolCallId ?? "",
      });
      continue;
    }

    const entry: RequestMessage = { role: message.role, content: message.content ?? "" };
    if (message.role === "assistant" && message.toolCalls?.length) {
      entry.tool_calls = message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
      }));
    }
    out.push(entry);
  }

  return out;
}

function parseArguments(raw: string | undefined): Record<string, unknown> {
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

export const chatWire: ChatAdapter = async (request: ChatRequest): Promise<ChatResponse> => {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: toMessages(request.system, request.messages),
  };

  if (request.thinking) body.reasoning_effort = "high";
  if (request.maxTokens) body.max_completion_tokens = request.maxTokens;
  if (request.json) body.response_format = { type: "json_object" };

  if (request.tools?.length) {
    body.tools = request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  const response = await request.fetch(`${request.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${request.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: request.signal,
  });

  if (!response.ok) {
    throw new ProviderError("chat", response.status, await response.text());
  }

  const payload = (await response.json()) as ResponsePayload;
  const choice = payload.choices?.[0];

  const toolCalls: ToolCall[] = (choice?.message?.tool_calls ?? []).map((call) => ({
    id: call.id ?? "",
    name: call.function?.name ?? "",
    args: parseArguments(call.function?.arguments),
  }));

  return {
    text: choice?.message?.content ?? "",
    toolCalls,
    usage: {
      inputTokens: payload.usage?.prompt_tokens ?? 0,
      outputTokens: payload.usage?.completion_tokens ?? 0,
      cachedTokens: payload.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    },
    finishReason: choice?.finish_reason,
  };
};
