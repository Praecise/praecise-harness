import type { ChatAdapter, ChatRequest, ChatResponse, Message } from "../types.js";
import { ProviderError } from "../types.js";

interface RequestContent {
  role: "user" | "model";
  parts: { text: string }[];
}

interface ResponsePayload {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
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
    generationConfig.thinkingConfig = { thinkingLevel: request.thinking ? "high" : "low" };
  } else if (request.depth === "budget") {
    generationConfig.thinkingConfig = { thinkingBudget: request.thinking ? 2048 : 0 };
  }

  const body: Record<string, unknown> = {
    contents: toContents(request.messages),
    generationConfig,
  };
  if (request.system) body.systemInstruction = { parts: [{ text: request.system }] };

  const url =
    `${request.baseUrl.replace(/\/$/, "")}/models/${request.model}:generateContent` +
    `?key=${encodeURIComponent(request.apiKey)}`;

  const response = await request.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: request.signal,
  });

  if (!response.ok) {
    throw new ProviderError("contents", response.status, await response.text());
  }

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
    },
    finishReason: candidate?.finishReason,
  };
};
