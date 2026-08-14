import type { ChatAdapter, ChatRequest, ChatResponse, Message, ToolCall } from "../types.js";
import { ProviderError } from "../types.js";
import { budgetOf, levelOf } from "./effort.js";
import { events } from "./sse.js";

/**
 * This wire names a call rather than identifying one: a request carries a
 * function name and no id, and the reply is matched to it by name. The rest of
 * the runtime correlates by id because the other two wires issue them, so ids
 * are minted here and resolved back to names on the way out. Nothing above this
 * file needs to know which convention the endpoint used.
 */
interface RequestPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
  thoughtSignature?: string;
}

interface RequestContent {
  role: "user" | "model";
  parts: RequestPart[];
}

interface ResponsePart {
  text?: string;
  functionCall?: { name?: string; args?: Record<string, unknown> };
  thoughtSignature?: string;
}

interface ResponsePayload {
  candidates?: {
    content?: { parts?: ResponsePart[] };
    finishReason?: string;
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
  };
}

/**
 * Reasoning is billed as output and reported separately on this wire, unlike
 * the other two, where the output count already contains it. Reading only the
 * candidate count therefore understates a hard request by most of what it cost
 * — and understates it worst at the effort where the spend actually matters,
 * which is the shape of an accounting error that never looks like one.
 */
function outputOf(meta: ResponsePayload["usageMetadata"]): number {
  return (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0);
}

function toContents(messages: Message[]): RequestContent[] {
  const out: RequestContent[] = [];
  const push = (role: "user" | "model", part: RequestPart): void => {
    const previous = out[out.length - 1];
    if (previous?.role === role) previous.parts.push(part);
    else out.push({ role, parts: [part] });
  };

  for (const message of messages) {
    // A tool result is a turn even though it carries no prose, and this
    // endpoint refuses a transcript whose function call is never answered.
    if (message.role === "tool") {
      push("user", {
        functionResponse: {
          name: message.name ?? "",
          response: { result: message.content ?? "" },
        },
      });
      continue;
    }

    const role = message.role === "assistant" ? "model" : "user";
    if (message.content) push(role, { text: message.content });

    // The assistant turn that requested tools usually says nothing at all, and
    // dropping it for having no text leaves a result answering a call the
    // transcript never made. The token that came back attached to the call is
    // replayed on the same part it arrived on; this endpoint refuses the turn
    // without it once a second call is made.
    for (const call of message.toolCalls ?? []) {
      push("model", {
        functionCall: { name: call.name, args: call.args ?? {} },
        ...(call.seal ? { thoughtSignature: call.seal } : {}),
      });
    }
  }

  return out;
}

/**
 * An empty parameter object is refused by this endpoint, so a function that
 * takes no arguments is declared without a schema rather than with an empty one.
 */
function declarationsFor(tools: ChatRequest["tools"]): Record<string, unknown>[] {
  return (tools ?? []).map((tool) => {
    const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties;
    return {
      name: tool.name,
      description: tool.description,
      ...(properties && Object.keys(properties).length ? { parameters: tool.parameters } : {}),
    };
  });
}

function callsFrom(parts: readonly ResponsePart[]): ToolCall[] {
  return parts
    .filter((part) => part.functionCall?.name)
    .map((part, index) => ({
      id: `${part.functionCall?.name ?? ""}-${index}`,
      name: part.functionCall?.name ?? "",
      args: part.functionCall?.args ?? {},
      ...(part.thoughtSignature ? { seal: part.thoughtSignature } : {}),
    }));
}

export const contentsWire: ChatAdapter = async (request: ChatRequest): Promise<ChatResponse> => {
  const generationConfig: Record<string, unknown> = {};
  if (request.maxTokens) generationConfig.maxOutputTokens = request.maxTokens;
  // A mime type alone is documented as only a strong hint; the schema is what actually
  // constrains, so it is sent whenever there is one and never left to the hint.
  if (request.schema) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = request.schema;
  } else if (request.json) {
    generationConfig.responseMimeType = "application/json";
  }

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
  if (request.tools?.length) body.tools = [{ functionDeclarations: declarationsFor(request.tools) }];

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

  const parts = candidate?.content?.parts ?? [];
  const text = parts.map((part) => part.text ?? "").join("");

  return {
    text,
    toolCalls: callsFrom(parts),
    usage: {
      inputTokens: payload.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: outputOf(payload.usageMetadata),
      cachedTokens: payload.usageMetadata?.cachedContentTokenCount ?? 0,
    },
    finishReason: candidate?.finishReason,
  };
};

/** Each frame is a whole response payload carrying the newest parts. */
async function readStream(response: Response, onText: (text: string) => void): Promise<ChatResponse> {
  const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  const called: ResponsePart[] = [];
  let text = "";
  let finishReason: string | undefined;

  for await (const frame of events(response.body)) {
    const payload = frame as ResponsePayload;
    const candidate = payload.candidates?.[0];
    if (candidate?.finishReason) finishReason = candidate.finishReason;

    const meta = payload.usageMetadata;
    if (meta) {
      usage.inputTokens = meta.promptTokenCount ?? usage.inputTokens;
      usage.outputTokens = outputOf(meta);
      usage.cachedTokens = meta.cachedContentTokenCount ?? usage.cachedTokens;
    }

    // Unlike the other two wires, a call arrives here whole rather than as
    // arguments assembled across frames, so there is nothing to buffer.
    for (const part of candidate?.content?.parts ?? []) {
      if (part.functionCall?.name) called.push(part);
      if (!part.text) continue;
      text += part.text;
      onText(part.text);
    }
  }

  return { text, toolCalls: callsFrom(called), usage, finishReason };
}
