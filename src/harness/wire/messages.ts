import type { Attachment, ChatAdapter, ChatRequest, ChatResponse, Message, ToolCall, ToolSchema } from "../types.js";
import { levelOf } from "./effort.js";
import { Fragments } from "./sse.js";
import { frames, isImage, post, stopOf, streamed, whole, type Clock } from "./http.js";

/** A marker telling the endpoint that everything up to here is worth keeping for next time. */
const KEEP = { type: "ephemeral" } as const;

/** A content block. Its shape is the endpoint's; only the few fields read here are named. */
type Block = Record<string, unknown> & { type?: string };

interface RequestMessage {
  role: "user" | "assistant";
  content: Block[];
}

interface UsagePayload {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens_details?: { thinking_tokens?: number };
}

interface ResponsePayload {
  content?: Block[];
  stop_reason?: string;
  usage?: UsagePayload;
}

const JSON_INSTRUCTION =
  "Reply with only a JSON object. No prose before or after it, and no code fences.";

/**
 * The room a reply is given when the request names none.
 *
 * Thinking and the answer come out of one pool on this wire. Four thousand tokens is a
 * fair ceiling for an answer and a poor one for an answer plus the reasoning behind it:
 * the reasoning is spent first, and what is left is a reply cut off mid-sentence and
 * billed in full.
 */
const ROOM = 4_096;
const THINKING_ROOM = 16_384;

/** Reasoning blocks: the two kinds this wire mints and wants back unchanged. */
const isReasoning = (block: Block): boolean =>
  block.type === "thinking" || block.type === "redacted_thinking";

/** An attachment as the block this wire reads it in. Images are looked at; the rest is read. */
function blockFor(attachment: Attachment): Block {
  const source = attachment.url
    ? { type: "url", url: attachment.url }
    : { type: "base64", media_type: attachment.mime, data: attachment.data ?? "" };
  if (isImage(attachment)) return { type: "image", source };
  return { type: "document", source, ...(attachment.name ? { title: attachment.name } : {}) };
}

/**
 * This endpoint's own computer tool, in the two forms it has been declared in.
 *
 * The earlier form is one tool with an `action` among its arguments, declared with the
 * size of the screen. The later form is a toolset: each action is a tool of its own
 * under a shared `toolset_name`, the entry carries no name and no screen size, and every
 * result has to say which toolset it answers. Which of them an endpoint takes, and under
 * what version string, is what the app declared; the only thing decided here is which
 * family a string belongs to, and that is in the string.
 *
 * Above this file there is one tool either way, called with `{ action, ... }`. A call
 * that arrived as a toolset member is marked on its `seal` so that it, and the result
 * that answers it, go back in the form they came in.
 */
const isToolset = (type: string): boolean => /_toolset_/.test(type);
const SEALED = "toolset:";
const toolsetOf = (call: ToolCall): string | undefined =>
  call.seal?.startsWith(SEALED) ? call.seal.slice(SEALED.length) : undefined;

function toolFor(tool: ToolSchema, computer: string | undefined): Block {
  if (tool.native?.kind !== "computer" || !computer) {
    return { name: tool.name, description: tool.description, input_schema: tool.parameters };
  }
  if (!isToolset(computer)) {
    return {
      type: computer,
      name: tool.name,
      display_width_px: tool.native.width,
      display_height_px: tool.native.height,
    };
  }
  // Every member is on unless it is turned off, so what the screen cannot do is turned off.
  const off = tool.native.without ?? [];
  return {
    type: computer,
    ...(off.length ? { configs: Object.fromEntries(off.map((member) => [member, { enabled: false }])) } : {}),
  };
}

/** A `tool_use` block as a call, read the same whether it arrived whole or in fragments. */
function callFrom(block: Record<string, unknown>, request: ChatRequest): ToolCall {
  const input = isRecord(block.input) ? block.input : {};
  const name = typeof block.name === "string" ? block.name : "";
  if (typeof block.toolset_name !== "string" || !block.toolset_name) {
    return { id: typeof block.id === "string" ? block.id : "", name, args: input };
  }
  // A member of a toolset is the one tool the runtime holds, with the member as its action.
  const held = request.tools?.find((tool) => tool.native?.kind === "computer");
  return {
    id: typeof block.id === "string" ? block.id : "",
    name: held?.name ?? block.toolset_name,
    args: { ...input, action: name },
    seal: `${SEALED}${block.toolset_name}`,
  };
}

function toMessages(messages: Message[]): RequestMessage[] {
  const out: RequestMessage[] = [];
  /** Calls that arrived as toolset members, by id, so their results can say which toolset they answer. */
  const toolsets = new Map<string, string>();

  for (const message of messages) {
    if (message.role === "tool") {
      const toolset = toolsets.get(message.toolCallId ?? "");
      const block: Block = {
        type: "tool_result",
        tool_use_id: message.toolCallId ?? "",
        ...(toolset ? { toolset_name: toolset } : {}),
        // A result that came with something to look at is a list of blocks; one that is
        // only text stays the string it always was.
        content: message.attachments?.length
          ? [...(message.content ? [{ type: "text", text: message.content }] : []), ...message.attachments.map(blockFor)]
          : (message.content ?? ""),
      };
      const previous = out[out.length - 1];
      const isResultTurn =
        previous?.role === "user" && previous.content.every((b) => b.type === "tool_result");
      if (isResultTurn) previous.content.push(block);
      else out.push({ role: "user", content: [block] });
      continue;
    }

    const content: Block[] = [];
    if (message.role === "assistant") {
      // Reasoning goes back first and untouched, in the place it came from. The endpoint
      // checks what it signed, so a block that was reordered or re-serialised is refused.
      for (const kept of message.replay ?? []) content.push(kept as Block);
    } else {
      // What is shown comes before what is asked about it, as the vendor recommends.
      for (const attachment of message.attachments ?? []) content.push(blockFor(attachment));
    }
    if (message.content) content.push({ type: "text", text: message.content });
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        const toolset = toolsetOf(call);
        if (!toolset) {
          content.push({ type: "tool_use", id: call.id, name: call.name, input: call.args ?? {} });
          continue;
        }
        toolsets.set(call.id, toolset);
        const { action, ...input } = call.args ?? {};
        content.push({ type: "tool_use", id: call.id, name: String(action ?? ""), toolset_name: toolset, input });
      }
    }
    if (content.length) out.push({ role: message.role, content });
  }

  return out;
}

/**
 * The system prompt, split where it stops being the same on every request.
 *
 * This endpoint keeps a prefix only where it is told to, and reads a request as tools,
 * then system, then messages. One marker at the end of the stable part therefore keeps
 * the tool list and the instructions together, and what was written for this request —
 * what was recalled, what a self has been reading — sits after it, where changing it
 * costs nothing that was kept.
 */
function systemFor(request: ChatRequest, system: string): string | Block[] {
  if (request.cache === false || !system) return system;
  const at = request.stable === undefined ? system.length : Math.min(request.stable, system.length);
  const stable = system.slice(0, at).trimEnd();
  const fresh = system.slice(at).trim();
  if (!stable) return system;
  return [
    { type: "text", text: stable, cache_control: KEEP },
    ...(fresh ? [{ type: "text", text: fresh }] : []),
  ];
}

/**
 * Mark the end of the conversation so far as worth keeping.
 *
 * A tool loop sends the same transcript again with one more turn on the end, six or
 * sixty times. Marking the last block means each of those requests reads everything
 * before it from what the previous one left behind. A conversation of a single turn has
 * nothing behind it to keep, so it is left alone.
 */
function keepConversation(messages: RequestMessage[]): void {
  if (messages.length < 2) return;
  const blocks = messages[messages.length - 1]!.content;
  const last = blocks[blocks.length - 1];
  if (last && !isReasoning(last)) last.cache_control = KEEP;
}

function usageOf(from: UsagePayload | undefined): ChatResponse["usage"] {
  const read = from?.cache_read_input_tokens ?? 0;
  const written = from?.cache_creation_input_tokens ?? 0;
  const thought = from?.output_tokens_details?.thinking_tokens;
  return {
    // This endpoint counts what it read from a kept prefix, and what it kept, OUTSIDE
    // `input_tokens`. Every other wire counts them inside, and so does everything above
    // this file, so they are added back here rather than explained to each reader.
    inputTokens: (from?.input_tokens ?? 0) + read + written,
    outputTokens: from?.output_tokens ?? 0,
    cachedTokens: read,
    ...(written ? { cacheWriteTokens: written } : {}),
    ...(thought ? { reasoningTokens: thought } : {}),
  };
}

export const messagesWire: ChatAdapter = async (request: ChatRequest): Promise<ChatResponse> => {
  const system = request.json
    ? `${request.system ? `${request.system}\n\n` : ""}${JSON_INSTRUCTION}`
    : request.system;

  const thinking = request.depth !== "none";
  const messages = toMessages(request.messages);
  if (request.cache !== false) keepConversation(messages);

  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.maxTokens ?? (thinking ? THINKING_ROOM : ROOM),
    messages,
  };
  if (system) body.system = systemFor(request, system);

  // Depth, in the shape this endpoint accepts TODAY.
  //
  // The token-budget form — `thinking: {type: "enabled", budget_tokens: N}` — is a 400 on
  // every current flagship. Depth moved to `output_config.effort`, and it is not a
  // thinking budget: the vendor documents it as a behavioural signal affecting ALL output
  // tokens including tool calls, so a lower effort makes fewer tool calls, not just
  // shorter thoughts.
  //
  // `adaptive` lets the model decide per request whether to think at all, which means an
  // assistant turn need not begin with a thinking block — nothing below assumes one.
  //
  // Effort is rendered into the prompt, so changing it mid-conversation loses what was
  // kept. It is derived from the rung, and a rung does not change under a conversation.
  if (thinking) {
    body.thinking = { type: "adaptive", display: "summarized" };
    body.output_config = { effort: levelOf(request.effort, request.levels) };
  }

  // No temperature, ever: a non-default `temperature`, `top_p` or `top_k` is a 400 on the
  // current flagships. Determinism comes from constraining the output space instead.
  //
  // With a schema that is real constrained decoding, so the prose instruction is not sent
  // alongside it: asking twice, once structurally and once in English, only tells the
  // model that the structure it cannot violate is negotiable.
  if (request.schema) {
    body.output_config = {
      ...(body.output_config as object),
      format: { type: "json_schema", schema: request.schema },
    };
  } else if (request.json) {
    body.output_config = { ...(body.output_config as object), format: { type: "json_object" } };
  }

  if (request.tools?.length) {
    body.tools = request.tools.map((tool) => toolFor(tool, request.computer));
  }

  if (request.onText) body.stream = true;

  const { response, clock } = await post(
    "messages",
    request,
    `${request.baseUrl.replace(/\/$/, "")}/v1/messages`,
    {
      // Fixed by the wire format itself, the way `content-type` is — unless the provider
      // named a header of its own, which is a gateway speaking this shape while
      // authenticating its own way, and then the credential goes where it was told.
      [request.credentialHeader ?? "x-api-key"]: request.apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body,
  );

  if (request.onText && streamed(response)) return readStream(response, request, request.onText, clock);

  const payload = await whole<ResponsePayload>(response, clock);
  const blocks = payload.content ?? [];

  const text = blocks
    .filter((block) => block.type === "text")
    .map((block) => (block.text as string | undefined) ?? "")
    .join("");
  // A stream was asked for and the endpoint answered in one piece: the caller still
  // gets its words, all at once.
  if (request.onText && text) request.onText(text);

  const toolCalls: ToolCall[] = blocks
    .filter((block) => block.type === "tool_use")
    .map((block) => callFrom(block, request));

  const reasoning = blocks.filter(isReasoning);
  return {
    text,
    toolCalls,
    usage: usageOf(payload.usage),
    finishReason: payload.stop_reason,
    stop: stopOf(payload.stop_reason, toolCalls.length > 0),
    ...(reasoning.length ? { replay: reasoning } : {}),
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** This wire streams as named events carrying block starts, deltas and stops. */
interface StreamEvent {
  type?: string;
  index?: number;
  content_block?: Block & { id?: string; name?: string; toolset_name?: string };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    thinking?: string;
    signature?: string;
    stop_reason?: string;
  };
  message?: { usage?: UsagePayload };
  usage?: UsagePayload;
}

/** The counts a frame actually carried. A later frame's silence must not zero an earlier one's number. */
function carried(usage: UsagePayload | undefined): UsagePayload {
  return Object.fromEntries(
    Object.entries(usage ?? {}).filter(([, value]) => value !== undefined && value !== null),
  );
}

async function readStream(
  response: Response,
  request: ChatRequest,
  onText: (text: string) => void,
  clock: Clock,
): Promise<ChatResponse> {
  const seen: UsagePayload = {};
  const fragments = new Fragments();
  /** Which toolset a call belongs to, by the call's id, where its opening block said. */
  const toolsets = new Map<string, string>();
  /** Reasoning blocks, rebuilt from their start and their deltas, by position. */
  const reasoning = new Map<number, Block>();
  let text = "";
  let finishReason: string | undefined;

  const append = (at: number, field: "thinking" | "signature", more: string | undefined): void => {
    const block = reasoning.get(at);
    if (block) block[field] = `${(block[field] as string | undefined) ?? ""}${more ?? ""}`;
  };

  for await (const frame of frames(response, clock)) {
    const event = frame as StreamEvent;
    const at = event.index ?? 0;

    if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
      fragments.open(at, event.content_block.id ?? "", event.content_block.name ?? "");
      if (event.content_block.toolset_name) toolsets.set(event.content_block.id ?? "", event.content_block.toolset_name);
    } else if (event.type === "content_block_start" && event.content_block && isReasoning(event.content_block)) {
      // A redacted block arrives whole here; a thinking block arrives empty and is filled.
      reasoning.set(at, { ...event.content_block });
    } else if (event.delta?.type === "text_delta" && event.delta.text) {
      text += event.delta.text;
      onText(event.delta.text);
    } else if (event.delta?.type === "input_json_delta") {
      fragments.push(at, event.delta.partial_json ?? "");
    } else if (event.delta?.type === "thinking_delta") {
      append(at, "thinking", event.delta.thinking);
    } else if (event.delta?.type === "signature_delta") {
      append(at, "signature", event.delta.signature);
    } else if (event.type === "message_delta") {
      if (event.delta?.stop_reason) finishReason = event.delta.stop_reason;
      Object.assign(seen, carried(event.usage));
    } else if (event.type === "message_start") {
      Object.assign(seen, carried(event.message?.usage));
    }
  }

  const toolCalls: ToolCall[] = fragments
    .done()
    .filter((call) => call.name)
    .map((call) => callFrom({ id: call.id, name: call.name, toolset_name: toolsets.get(call.id), input: call.args }, request));
  const kept = [...reasoning.entries()].sort(([a], [b]) => a - b).map(([, block]) => block);
  return {
    text,
    toolCalls,
    usage: usageOf(seen),
    finishReason,
    stop: stopOf(finishReason, toolCalls.length > 0),
    ...(kept.length ? { replay: kept } : {}),
  };
}
