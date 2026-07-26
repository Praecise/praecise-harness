import type { ChatAdapter, ChatRequest, ChatResponse, Message } from "../types.js";
import { ProviderError } from "../types.js";
import { budgetOf, levelOf } from "./effort.js";
import { events } from "./sse.js";

interface RequestContent {
  role: "user" | "model";
  parts: { text: string }[];
}

interface ResponsePayload {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
  };
}

function toContents(messages: Message[]): RequestContent[] {
  const out: RequestContent[] = [];

  for (const message of messages) {
    const role = message.role === "assistant" ? "model" : "user";
    const text = message.content ?? "";
    if (!text) continue;

    const previous = out[out.length - 1];
    if (previous?.role === role) previous.parts.push({ text });
    else out.push({ role, parts: [{ text }] });
  }

  return out;
}

export const contentsWire: ChatAdapter = async (request: ChatRequest): Promise<ChatResponse> => {
  const generationConfig: Record<string, unknown> = {};
  if (request.maxTokens) generationConfig.maxOutputTokens = request.maxTokens;
  if (request.json) generationConfig.responseMimeType = "application/json";

  // Newer endpoints on this wire take a named level, older ones a token budget.
  if (request.depth === "effort") {
    generationConfig.thinkingConfig = { thinkingLevel: levelOf(request.effort) };
  } else if (request.depth === "budget") {
    generationConfig.thinkingConfig = {
      thinkingBudget: request.effort > 0 ? budgetOf(request.effort) : 0,
    };
  }

  const body: Record<string, unknown> = {
    contents: toContents(request.messages),
    generationConfig,
  };
  if (request.system) body.systemInstruction = { parts: [{ text: request.system }] };

  // This wire streams from a different method rather than from a flag, and
  // wants asking for server-sent events by name.
  const method = request.onText ? "streamGenerateContent?alt=sse&" : "generateContent?";
  const url =
    `${request.baseUrl.replace(/\/$/, "")}/models/${request.model}:${method}` +
    `key=${encodeURIComponent(request.apiKey)}`;

  const response = await request.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: request.signal,
  });

  if (!response.ok) {
    throw new ProviderError("contents", response.status, await response.text());
  }

  if (request.onText) return readStream(response, request.onText);

  const payload = (await response.json()) as ResponsePayload;
  const candidate = payload.candidates?.[0];

  const text = (candidate?.content?.parts ?? []).map((part) => part.text ?? "").join("");

  return {
    text,
    // This wire carries no tool calling; any advertised tools were dropped.
    toolCalls: [],
    usage: {
      inputTokens: payload.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: payload.usageMetadata?.candidatesTokenCount ?? 0,
      cachedTokens: payload.usageMetadata?.cachedContentTokenCount ?? 0,
    },
    finishReason: candidate?.finishReason,
  };
};

/** Each frame is a whole response payload carrying the newest parts. */
async function readStream(response: Response, onText: (text: string) => void): Promise<ChatResponse> {
  const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  let text = "";
  let finishReason: string | undefined;

  for await (const frame of events(response.body)) {
    const payload = frame as ResponsePayload;
    const candidate = payload.candidates?.[0];
    if (candidate?.finishReason) finishReason = candidate.finishReason;

    const meta = payload.usageMetadata;
    if (meta) {
      usage.inputTokens = meta.promptTokenCount ?? usage.inputTokens;
      usage.outputTokens = meta.candidatesTokenCount ?? usage.outputTokens;
      usage.cachedTokens = meta.cachedContentTokenCount ?? usage.cachedTokens;
    }

    for (const part of candidate?.content?.parts ?? []) {
      if (!part.text) continue;
      text += part.text;
      onText(part.text);
    }
  }

  // This wire carries no tool calling; any advertised tools were dropped.
  return { text, toolCalls: [], usage, finishReason };
}
