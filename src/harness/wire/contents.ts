import type { Attachment, ChatAdapter, ChatRequest, ChatResponse, Message, ToolCall } from "../types.js";
import { budgetOf, levelOf } from "./effort.js";
import { frames, post, stopOf, streamed, whole, type Clock } from "./http.js";

/**
 * This wire names a call rather than identifying one: a request carries a
 * function name and no id, and the reply is matched to it by name. The rest of
 * the runtime correlates by id because the other two wires issue them, so ids
 * are minted here and resolved back to names on the way out. Nothing above this
 * file needs to know which convention the endpoint used.
 */
interface RequestPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  fileData?: { mimeType: string; fileUri: string };
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
  inlineData?: { mimeType?: string; data?: string };
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

/** Anything with a media type is a part here: by address where there is one, inline where not. */
const partFor = (attachment: Attachment): RequestPart =>
  attachment.url
    ? { fileData: { mimeType: attachment.mime, fileUri: attachment.url } }
    : { inlineData: { mimeType: attachment.mime, data: attachment.data ?? "" } };

/** What a reply carries that is not text: generated images and speech arrive as inline parts. */
function madeIn(parts: readonly ResponsePart[]): Attachment[] {
  return parts.flatMap((part) =>
    part.inlineData?.data ? [{ mime: part.inlineData.mimeType ?? "application/octet-stream", data: part.inlineData.data }] : [],
  );
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
      // What a tool returned besides text sits beside its response, in the same turn.
      for (const attachment of message.attachments ?? []) push("user", partFor(attachment));
      continue;
    }

    const role = message.role === "assistant" ? "model" : "user";
    for (const attachment of message.role === "user" ? (message.attachments ?? []) : []) {
      push(role, partFor(attachment));
    }
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

/**
 * The API version this surface lives under, when the configured base does not name one.
 *
 * Omitting it was a real bug, found on the first live call and invisible to every stub
 * test: `https://generativelanguage.googleapis.com` — which is the host the vendor's own
 * documentation prints — produced `/models/gemini-2.5-flash:generateContent` with no
 * version segment at all, and answered 404 with an empty body. A stub `fetch` answers
 * whatever the test decided no matter what URL it is handed, so nothing here could have
 * caught it.
 *
 * A base that already names a version is left exactly as it is, because an app pointed at
 * `/v1` meant `/v1`.
 */
export function versioned(baseUrl: string): string {
  const root = baseUrl.replace(/\/+$/, "");
  return /\/v\d[^/]*$/.test(root) ? root : `${root}/v1beta`;
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
    generationConfig.thinkingConfig = { thinkingLevel: levelOf(request.effort, request.levels) };
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
    `${versioned(request.baseUrl)}/models/${request.model}:${method}` +
    `key=${encodeURIComponent(request.apiKey)}`;

  // This surface carries its credential in the URL, so `credentialHeader` has nothing
  // to move here; declared headers still travel, and so do declared body fields.
  const { response, clock } = await post("contents", request, url, { "content-type": "application/json" }, body);

  if (request.onText && streamed(response)) return readStream(response, request.onText, clock);

  const payload = await whole<ResponsePayload>(response, clock);
  const candidate = payload.candidates?.[0];

  const parts = candidate?.content?.parts ?? [];
  const text = parts.map((part) => part.text ?? "").join("");
  if (request.onText && text) request.onText(text);

  const toolCalls = callsFrom(parts);
  const made = madeIn(parts);
  return {
    text,
    toolCalls,
    ...(made.length ? { attachments: made } : {}),
    usage: usageOf(payload.usageMetadata),
    finishReason: candidate?.finishReason,
    stop: stopOf(candidate?.finishReason === "STOP" ? "end" : candidate?.finishReason, toolCalls.length > 0),
  };
};

function usageOf(meta: ResponsePayload["usageMetadata"]): ChatResponse["usage"] {
  return {
    inputTokens: meta?.promptTokenCount ?? 0,
    outputTokens: outputOf(meta),
    cachedTokens: meta?.cachedContentTokenCount ?? 0,
    ...(meta?.thoughtsTokenCount ? { reasoningTokens: meta.thoughtsTokenCount } : {}),
  };
}

/** Each frame is a whole response payload carrying the newest parts. */
async function readStream(
  response: Response,
  onText: (text: string) => void,
  clock: Clock,
): Promise<ChatResponse> {
  let usage: ChatResponse["usage"] = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  const called: ResponsePart[] = [];
  const made: Attachment[] = [];
  let text = "";
  let finishReason: string | undefined;

  for await (const frame of frames(response, clock)) {
    const payload = frame as ResponsePayload;
    const candidate = payload.candidates?.[0];
    if (candidate?.finishReason) finishReason = candidate.finishReason;

    if (payload.usageMetadata) usage = usageOf(payload.usageMetadata);

    // Unlike the other two wires, a call arrives here whole rather than as
    // arguments assembled across frames, so there is nothing to buffer.
    for (const part of candidate?.content?.parts ?? []) {
      made.push(...madeIn([part]));
      if (part.functionCall?.name) called.push(part);
      if (!part.text) continue;
      text += part.text;
      onText(part.text);
    }
  }

  const toolCalls = callsFrom(called);
  return {
    text,
    toolCalls,
    ...(made.length ? { attachments: made } : {}),
    usage,
    finishReason,
    stop: stopOf(finishReason === "STOP" ? "end" : finishReason, toolCalls.length > 0),
  };
}
