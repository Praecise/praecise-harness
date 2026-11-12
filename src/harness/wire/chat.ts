import type { Attachment, ChatAdapter, ChatRequest, ChatResponse, Message, ToolCall } from "../types.js";
import { ProviderError } from "../types.js";
import { levelOf } from "./effort.js";
import { Fragments, events } from "./sse.js";
import { clockFor, dataUrl, isImage, retryAfterOf, stopOf, type Clock } from "./http.js";

/**
 * The completion ceiling for a request that names none.
 *
 * The messages wire has always defaulted this and this one did not, so a chat request
 * decoded without bound — one runaway answer can hold an endpoint that serves one
 * request at a time for as long as it cares to keep writing. A default is not a
 * judgement about how long an answer should be; it is the difference between a request
 * that ends and one that might not.
 */
const CEILING = 4_096;

/**
 * The least room a request that asks for thinking may be given.
 *
 * On a thinking endpoint the completion budget is one pool, spent on the reasoning
 * first and on the answer with whatever is left. Ask for depth and sixteen tokens and
 * the whole of it goes on thought, and what comes back is an empty string billed as
 * work. `starvedOfBudget` in interactions.ts names that after the fact; this stops it
 * happening, which is the cheaper of the two.
 */
const THINKING_FLOOR = 512;

interface RequestToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface RequestMessage {
  role: "system" | "user" | "assistant" | "tool";
  /** Text, or text and what was sent with it. */
  content: string | Record<string, unknown>[];
  tool_calls?: RequestToolCall[];
  tool_call_id?: string;
  /** Reasoning handed back under whichever name the endpoint used for it. */
  [reasoning: string]: unknown;
}

/**
 * The two names endpoints on this shape give a model's reasoning.
 *
 * The protocol has no field for it, so each runtime that reasons added its own, and one
 * of them refuses a tool turn that does not carry the reasoning back. It is returned
 * under the name it arrived in, because that is the only name known to be read.
 */
const REASONING_FIELDS = ["reasoning_content", "reasoning"] as const;

/** Whatever reasoning a message or a delta carried, and the name it was carried under. */
function reasoningIn(from: Record<string, unknown> | undefined): { field: string; text: string } | undefined {
  for (const field of REASONING_FIELDS) {
    const text = from?.[field];
    if (typeof text === "string" && text) return { field, text };
  }
  return undefined;
}

interface ResponseToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface ResponsePayload {
  choices?: {
    message?: Record<string, unknown> & {
      content?: string | null;
      tool_calls?: ResponseToolCall[];
      refusal?: string | null;
    };
    finish_reason?: string;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

function usageOf(usage: ResponsePayload["usage"]): ChatResponse["usage"] {
  const thought = usage?.completion_tokens_details?.reasoning_tokens;
  return {
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
    ...(thought ? { reasoningTokens: thought } : {}),
  };
}

function toMessages(system: string, messages: Message[]): RequestMessage[] {
  const out: RequestMessage[] = [];
  if (system) out.push({ role: "system", content: system });

  /** What tools returned besides text, waiting for the turn's results to finish. */
  const held: Record<string, unknown>[] = [];
  const flush = (): void => {
    if (!held.length) return;
    out.push({ role: "user", content: [{ type: "text", text: "[Returned by the tools above]" }, ...held.splice(0)] });
  };

  for (const message of messages) {
    if (message.role === "tool") {
      out.push({
        role: "tool",
        content: message.content ?? "",
        tool_call_id: message.toolCallId ?? "",
      });
      // A tool message is text on this shape and nothing else. What the tool returned
      // besides text is held until every result of the turn has been given — a user
      // message may not sit between two of them — and then shown in a turn of its own.
      for (const attachment of message.attachments ?? []) held.push(partFor(attachment));
      continue;
    }
    flush();

    const entry: RequestMessage = { role: message.role, content: message.content ?? "" };
    if (message.role === "user" && message.attachments?.length) {
      entry.content = [
        ...(message.content ? [{ type: "text", text: message.content }] : []),
        ...message.attachments.map(partFor),
      ];
    }
    for (const kept of message.role === "assistant" ? (message.replay ?? []) : []) {
      const { field, text } = kept as { field: string; text: string };
      entry[field] = text;
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      entry.tool_calls = message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
      }));
    }
    out.push(entry);
  }

  flush();
  return out;
}

/**
 * An attachment as the part this shape has for it.
 *
 * An image is a part the shape has always had. Audio, video and files are later
 * additions that only some endpoints read, which is why nothing but an image reaches
 * here unless the provider said the endpoint takes it.
 */
function partFor(attachment: Attachment): Record<string, unknown> {
  const mime = attachment.mime.toLowerCase();
  // A file this endpoint already holds is named, not sent again.
  if (attachment.fileId) return { type: "file", file: { file_id: attachment.fileId } };
  if (isImage(attachment)) return { type: "image_url", image_url: { url: dataUrl(attachment) } };
  if (mime.startsWith("audio/")) {
    // Bytes go as `input_audio`, which names its format; an address has only the part
    // the open-weight servers added for one.
    return attachment.data !== undefined
      ? { type: "input_audio", input_audio: { data: attachment.data, format: mime.includes("mpeg") || mime.includes("mp3") ? "mp3" : (mime.split("/")[1] ?? "wav").replace(/^x-/, "") } }
      : { type: "audio_url", audio_url: { url: attachment.url } };
  }
  if (mime.startsWith("video/")) return { type: "video_url", video_url: { url: dataUrl(attachment) } };
  return { type: "file", file: { filename: attachment.name ?? "attachment", file_data: dataUrl(attachment) } };
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

  /**
   * Whether this request asks for depth the provider said this endpoint can give.
   *
   * `planModels` sets effort to 1 on the balanced and best rungs regardless of what the
   * provider declared, so the effort number alone was never evidence about the endpoint.
   */
  const thinking = request.effort > 0 && (request.depth === "effort" || request.depth === "budget");

  // `depth` is how the endpoint takes a request for more room, as the PROVIDER declared
  // it, and only one of the three ways is this field. This wire ignored the declaration
  // and sent `reasoning_effort` to every endpoint whose effort was above zero; a
  // self-hosted server rejects the field outright rather than ignoring it, so a rung that
  // declared it takes no reasoning parameter could not be reached at all. An endpoint
  // that takes depth as a token budget must not be sent it either — it is the same
  // unknown field there, differing only in which of the two the author had in mind.
  // Undeclared is not a declaration, and this wire's own default for an undeclared
  // provider is "none", so silence means the field stays off.
  if (thinking && request.depth === "effort") {
    body.reasoning_effort = levelOf(request.effort, request.levels);
  }

  // Every request leaves here with a ceiling on it, whether or not the caller set one.
  // Without it a reply decodes until the endpoint decides to stop, which on an endpoint
  // serving one request at a time is a slot held for as long as the answer rambles.
  // A thinking request gets a floor as well: the budget covers the reasoning and the
  // reply out of one pool, and one too small to hold both is spent entirely on the first.
  const ceiling = request.maxTokens ?? CEILING;
  body.max_completion_tokens = thinking ? Math.max(ceiling, THINKING_FLOOR) : ceiling;
  // With a schema this is constrained decoding, and on this shape `strict` lives INSIDE
  // a named json_schema wrapper — unlike the responses shape, where it sits beside the
  // schema. Same vendor, same feature, different nesting; getting it wrong does not error,
  // it just quietly stops constraining, which is the failure that makes a guarantee useless.
  if (request.schema) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "reply", strict: true, schema: request.schema },
    };
  } else if (request.json) {
    body.response_format = { type: "json_object" };
  }

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

  // Usage is left out of a stream unless it is asked for, and a request whose
  // cost cannot be accounted for is one the router cannot learn from.
  if (request.onText) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }

  // A streamed answer is watched between frames; one that arrives whole is watched as a
  // whole, because until it lands there is nothing to measure the gaps between.
  const clock = clockFor("chat", request);
  clock.arm();

  try {
    const response = await request.fetch(`${request.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: headersFor(request),
      // Whatever the provider declared this endpoint needs sits UNDER what the wire
      // built, so a field in a config can fill a gap the protocol does not name and
      // cannot quietly replace the model or the conversation.
      body: JSON.stringify(request.body ? { ...request.body, ...body } : body),
      signal: clock.signal,
    });

    if (!response.ok) {
      throw new ProviderError("chat", response.status, await response.text(), retryAfterOf(response.headers));
    }

    // A stream was asked for, but only follow the SSE path when the endpoint
    // actually opened one. Some gateways ignore `stream:true` and return a
    // single buffered `chat.completion` instead — to sign or meter the whole
    // reply, for instance. Reading that as SSE finds no frames and loses the
    // answer entirely, so a buffered reply is parsed as one and, when the caller
    // streams, handed to it in a single piece: a non-streaming endpoint still
    // delivers its whole answer rather than nothing.
    const streamed = (response.headers.get("content-type") ?? "").includes("text/event-stream");
    if (request.onText && streamed) return await readStream(response, request.onText, clock);

    const payload = (await response.json()) as ResponsePayload;
    const choice = payload.choices?.[0];

    const toolCalls: ToolCall[] = (choice?.message?.tool_calls ?? []).map((call) => ({
      id: call.id ?? "",
      name: call.function?.name ?? "",
      args: parseArguments(call.function?.arguments),
    }));

    const text = choice?.message?.content ?? "";
    if (request.onText && text) request.onText(text);

    const thought = reasoningIn(choice?.message);
    // Speech comes back beside the text on this shape, with what was said as a transcript.
    const spoken = choice?.message?.audio as { data?: string; format?: string; transcript?: string } | undefined;
    // A refusal has a field of its own on this shape and still finishes as "stop", so
    // the finish reason alone reads a declined request as an answered one.
    const declined = !text && !toolCalls.length && choice?.message?.refusal ? "refusal" : undefined;
    return {
      text,
      toolCalls,
      usage: usageOf(payload.usage),
      finishReason: declined ?? choice?.finish_reason,
      stop: stopOf(declined ?? choice?.finish_reason, toolCalls.length > 0),
      ...(thought ? { replay: [thought] } : {}),
      ...(spoken?.data ? { attachments: [{ mime: `audio/${spoken.format ?? "wav"}`, data: spoken.data }] } : {}),
    };
  } catch (error) {
    // An abort raised by the clock is this endpoint failing to answer and is reported as
    // that. One raised by the caller's own signal is not: it is the caller cancelling,
    // and dressing it up as a provider failure would send the router looking for another
    // model to run a request nobody wants any more.
    if (clock.expired && !(error instanceof ProviderError)) throw clock.expiry();
    throw error;
  } finally {
    clock.stop();
  }
};

/**
 * Where the credential goes, and anything else this endpoint insists on.
 *
 * An endpoint you host yourself may need no credential at all. An empty key here would
 * send `Bearer ` — a malformed header that some servers reject and others record as a
 * failed auth attempt, so the absence has to be expressed by leaving the header out
 * rather than by sending an empty one. Others take a credential but not a bearer, and
 * read one as an anonymous caller; those name the header they want, and the credential
 * still comes from the environment rather than through the app's hands.
 *
 * Declared headers are applied last, so an app can correct anything above them.
 */
function headersFor(request: ChatRequest): Record<string, string> {
  const credential = request.credentialHeader ?? "authorization";
  const value = request.credentialHeader ? request.apiKey : `Bearer ${request.apiKey}`;
  return {
    ...(request.apiKey ? { [credential]: value } : {}),
    "content-type": "application/json",
    ...request.headers,
  };
}

/** This wire streams the same envelope, with `delta` where `message` would be. */
interface StreamChunk {
  choices?: {
    delta?: Record<string, unknown> & {
      content?: string | null;
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: ResponsePayload["usage"];
}

/**
 * Read the stream, and keep whatever arrived if it stops arriving.
 *
 * The frames are drawn one at a time rather than with `for await` so that the answer
 * built so far survives the iterator throwing. A stream that dies halfway used to take
 * the text with it, which is the worst of the three outcomes available: the caller has
 * already been shown those words, they were paid for, and the reply they came from was
 * then discarded in favour of an error. What comes back instead is the partial answer,
 * marked as cut short in `finishReason` and explained in a note, so nothing downstream
 * mistakes it for a model that chose to stop there.
 */
async function readStream(
  response: Response,
  onText: (text: string) => void,
  clock: Clock,
): Promise<ChatResponse> {
  let usage: ChatResponse["usage"] = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  const fragments = new Fragments();
  const frames = events(response.body);
  let text = "";
  let finishReason: string | undefined;
  /** Reasoning as it arrives, under the name the endpoint gave it. */
  let thought: { field: string; text: string } | undefined;
  /** Set when the stream ended before the endpoint said it had finished. */
  let cut: string | undefined;

  try {
    for (;;) {
      const next = await frames.next();
      if (next.done) break;
      // A frame is evidence the endpoint is still working, so the idle clock starts
      // again from here. Measured from the last frame rather than from the request,
      // a long answer arriving steadily never runs out of time.
      clock.arm();
      const chunk = next.value as StreamChunk;

      if (chunk.usage) usage = usageOf(chunk.usage);

      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;

      const more = reasoningIn(choice.delta);
      if (more) thought = { field: more.field, text: (thought?.text ?? "") + more.text };

      const content = choice.delta?.content;
      if (content) {
        text += content;
        onText(content);
      }

      for (const call of choice.delta?.tool_calls ?? []) {
        const at = call.index ?? 0;
        if (call.id || call.function?.name) fragments.open(at, call.id ?? "", call.function?.name ?? "");
        if (call.function?.arguments) fragments.push(at, call.function.arguments);
      }
    }
  } catch (error) {
    // Nothing arrived, so there is nothing to salvage and this is simply a rung that did
    // not answer — the same failure, and the same shape, as an endpoint that never
    // opened the stream at all.
    if (!text) throw clock.expired ? clock.expiry() : error;
    cut = clock.expired
      ? `the endpoint stopped sending after ${text.length} character(s) and nothing further arrived within ${clock.ms}ms; this answer is what had already been said`
      : `the stream ended before the endpoint finished (${(error as Error).message}); this answer is what had already been said`;
  } finally {
    // Return the iterator whichever way the loop left, so the body is released rather
    // than held open by a generator nobody is drawing from.
    await frames.return(undefined);
  }

  const toolCalls: ToolCall[] = fragments.done().filter((call) => call.name);
  return {
    text,
    toolCalls,
    usage,
    // "timeout" rather than whatever the endpoint last said, because it did not say it
    // had finished, and a caller reading `finishReason` is asking exactly that.
    finishReason: cut ? "timeout" : finishReason,
    stop: stopOf(cut ? "timeout" : finishReason, toolCalls.length > 0),
    ...(thought ? { replay: [thought] } : {}),
    ...(cut ? { notes: [cut] } : {}),
  };
}
