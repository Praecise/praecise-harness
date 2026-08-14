import type { ChatAdapter, ChatRequest, ChatResponse, Message, ToolCall } from "../types.js";
import { ProviderError } from "../types.js";
import { levelOf } from "./effort.js";
import { Fragments, events } from "./sse.js";

type RequestBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

interface RequestMessage {
  role: "user" | "assistant";
  content: RequestBlock[];
}

interface ResponseBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface ResponsePayload {
  content?: ResponseBlock[];
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

const JSON_INSTRUCTION =
  "Reply with only a JSON object. No prose before or after it, and no code fences.";


function toMessages(messages: Message[]): RequestMessage[] {
  const out: RequestMessage[] = [];

  for (const message of messages) {
    if (message.role === "tool") {
      const block: RequestBlock = {
        type: "tool_result",
        tool_use_id: message.toolCallId ?? "",
        content: message.content ?? "",
      };
      const previous = out[out.length - 1];
      const isResultTurn =
        previous?.role === "user" && previous.content.every((b) => b.type === "tool_result");
      if (isResultTurn) previous.content.push(block);
      else out.push({ role: "user", content: [block] });
      continue;
    }

    const content: RequestBlock[] = [];
    if (message.content) content.push({ type: "text", text: message.content });
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        content.push({ type: "tool_use", id: call.id, name: call.name, input: call.args ?? {} });
      }
    }
    if (content.length) out.push({ role: message.role, content });
  }

  return out;
}

export const messagesWire: ChatAdapter = async (request: ChatRequest): Promise<ChatResponse> => {
  const system = request.json
    ? `${request.system ? `${request.system}\n\n` : ""}${JSON_INSTRUCTION}`
    : request.system;

  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.maxTokens ?? 4096,
    messages: toMessages(request.messages),
  };
  if (system) body.system = system;

  // Depth, in the shape this endpoint accepts TODAY.
  //
  // The token-budget form — `thinking: {type: "enabled", budget_tokens: N}` — is not
  // merely discouraged now, it is a 400 on every current flagship. Depth moved to
  // `output_config.effort`, and it is not a thinking budget: the vendor documents it as
  // a behavioural signal affecting ALL output tokens including tool calls and their
  // arguments, so a lower effort makes fewer tool calls, not just shorter thoughts.
  //
  // `adaptive` is the important one. The model evaluates each request and decides for
  // itself whether to think and how much, which means an assistant turn need not begin
  // with a thinking block — the parser below must not assume one.
  //
  // One caching hazard, documented by the vendor: effort is rendered into the prompt, so
  // changing it mid-conversation invalidates the cache. It is derived from the rung, and
  // a rung does not change under a conversation.
  if (request.depth !== "none") {
    body.thinking = { type: "adaptive", display: "summarized" };
    body.output_config = { effort: levelOf(request.effort) };
  }

  // No temperature, ever. On the current flagships a non-default `temperature`, `top_p`
  // or `top_k` is a 400 on every request, thinking or not. Determinism here comes from
  // constraining the output space, which is what `output_config.format` below does.
  if (request.json) {
    body.output_config = { ...(body.output_config as object), format: { type: "json_object" } };
  }

  if (request.tools?.length) {
    body.tools = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
  }

  if (request.onText) body.stream = true;

  const response = await request.fetch(`${request.baseUrl.replace(/\/$/, "")}/v1/messages`, {
    method: "POST",
    headers: {
      // Fixed by the wire format itself, the way `content-type` is. An endpoint
      // that speaks this shape rejects the request without them.
      "x-api-key": request.apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: request.signal,
  });

  if (!response.ok) {
    throw new ProviderError("messages", response.status, await response.text());
  }

  if (request.onText) return readStream(response, request.onText);

  const payload = (await response.json()) as ResponsePayload;
  const blocks = payload.content ?? [];

  const text = blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");

  const toolCalls: ToolCall[] = blocks
    .filter((block) => block.type === "tool_use")
    .map((block) => ({
      id: block.id ?? "",
      name: block.name ?? "",
      args: isRecord(block.input) ? block.input : {},
    }));

  return {
    text,
    toolCalls,
    usage: {
      inputTokens: payload.usage?.input_tokens ?? 0,
      outputTokens: payload.usage?.output_tokens ?? 0,
      cachedTokens: payload.usage?.cache_read_input_tokens ?? 0,
    },
    finishReason: payload.stop_reason,
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** This wire streams as named events carrying block starts, deltas and stops. */
interface StreamEvent {
  type?: string;
  index?: number;
  content_block?: { type?: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
  message?: { usage?: ResponsePayload["usage"] };
  usage?: ResponsePayload["usage"];
}

async function readStream(response: Response, onText: (text: string) => void): Promise<ChatResponse> {
  const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  const fragments = new Fragments();
  let text = "";
  let finishReason: string | undefined;

  const take = (from: ResponsePayload["usage"]): void => {
    if (!from) return;
    if (from.input_tokens) usage.inputTokens = from.input_tokens;
    if (from.output_tokens) usage.outputTokens = from.output_tokens;
    if (from.cache_read_input_tokens) usage.cachedTokens = from.cache_read_input_tokens;
  };

  for await (const frame of events(response.body)) {
    const event = frame as StreamEvent;
    const at = event.index ?? 0;

    if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
      fragments.open(at, event.content_block.id ?? "", event.content_block.name ?? "");
    } else if (event.delta?.type === "text_delta" && event.delta.text) {
      text += event.delta.text;
      onText(event.delta.text);
    } else if (event.delta?.type === "input_json_delta") {
      fragments.push(at, event.delta.partial_json ?? "");
    } else if (event.type === "message_delta") {
      if (event.delta?.stop_reason) finishReason = event.delta.stop_reason;
      take(event.usage);
    } else if (event.type === "message_start") {
      take(event.message?.usage);
    }
  }

  const toolCalls: ToolCall[] = fragments.done().filter((call) => call.name);
  return { text, toolCalls, usage, finishReason };
}
