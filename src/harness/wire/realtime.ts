/**
 * The session protocol the `responses` and `chat` shapes' vendor publishes: events with
 * a `type`, each a JSON text frame, over a socket at `{base}/realtime?model=…`.
 *
 * Written from the vendor's documentation as it stood on 2026-11-13, for the protocol
 * as it has been since it left beta. The beta spelled several of these differently —
 * `response.audio.delta` for `response.output_audio.delta`, a flat session object where
 * there is now `type: "realtime"` and an `audio` block — and an endpoint still speaking
 * the beta is not this protocol.
 *
 * The exchange, as far as this reads and writes it:
 *
 *   → session.update                         what the session is: instructions, tools, voice
 *   ← session.updated                        and it is ready
 *   → conversation.item.create               something typed, or a picture
 *   → input_audio_buffer.append              a stretch of sound
 *   → input_audio_buffer.commit              that was the end of it
 *   → response.create                        answer now
 *   ← response.created                       the model's turn starts
 *   ← response.output_text.delta             what it writes
 *   ← response.output_audio.delta            what it says
 *   ← response.output_audio_transcript.delta what it says, written down
 *   ← response.function_call_arguments.done  it wants a tool
 *   → conversation.item.create               (function_call_output) the tool's result
 *   ← response.done                          the turn is over, with what it cost
 *   → response.cancel                        stop
 *   → conversation.item.truncate             and forget what was not heard
 *
 * The endpoint listens for where speech stops by itself unless the session says not to,
 * so sound sent without `done` is answered when the speaker pauses.
 */

import type { ChatResponse, Stop, ToolCall } from "../types.js";
import { dataUrl } from "./http.js";
import { Events, connect, socketBase, type SessionEvent, type SessionInput, type SessionOpener, type SessionRequest, type WireSession } from "./session.js";

/** Sixteen-bit mono PCM at 24 kHz, both ways, which is what a session uses unless told otherwise. */
const PCM = "audio/pcm;rate=24000";

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  input_token_details?: { cached_tokens?: number };
}

interface Item {
  id?: string;
  type?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
}

interface Incoming {
  type?: string;
  delta?: string;
  transcript?: string;
  item_id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  response?: {
    status?: string;
    status_details?: { reason?: string; error?: { message?: string } };
    output?: Item[];
    usage?: Usage;
  };
  error?: { message?: string; code?: string };
}

/** Where the socket is: beside the endpoint's other surfaces, under its version. */
export function realtimeUrl(request: Pick<SessionRequest, "baseUrl" | "url" | "model">): string {
  if (request.url) return request.url;
  const url = socketBase(request.baseUrl);
  const root = url.pathname.replace(/\/+$/, "");
  url.pathname = `${/\/v\d[^/]*$/.test(root) ? root : `${root}/v1`}/realtime`;
  url.searchParams.set("model", request.model);
  return url.toString();
}

function argsOf(raw: string | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function usageOf(usage: Usage | undefined): ChatResponse["usage"] {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cachedTokens: usage?.input_token_details?.cached_tokens ?? 0,
  };
}

/** Why a turn ended, from the status a finished response carries and the reason beside it. */
function stopFor(status: string | undefined, reason: string | undefined, called: boolean): Stop {
  if (called) return "tools";
  if (status === "incomplete") return reason === "content_filter" ? "filter" : "length";
  if (status === "failed") return "error";
  return "end";
}

export const realtimeSession: SessionOpener = async (request: SessionRequest): Promise<WireSession> => {
  const events = new Events<SessionEvent>();
  /** Calls the model made in the turn that is ending, not yet answered. */
  const owed = new Set<string>();
  const asked = new Set<string>();
  /** Whether a turn of the model's is under way, and whether tool results are waiting on its end to be answered. */
  let speaking = false;
  let resume = false;
  /** The item the model is speaking in, which is what a truncation names. */
  let voiced: string | undefined;

  const call = (id: string | undefined, name: string | undefined, raw: string | undefined): void => {
    if (!id || !name || asked.has(id)) return;
    asked.add(id);
    owed.add(id);
    events.push({ kind: "tool", call: { id, name, args: argsOf(raw) } });
  };

  const hear = (message: Record<string, unknown>): void => {
    const event = message as Incoming;
    switch (event.type) {
      case "session.updated":
        connection.ready();
        break;
      case "response.created":
        speaking = true;
        events.push({ kind: "turn", state: "started" });
        break;
      case "response.output_text.delta":
        if (event.delta) events.push({ kind: "text", text: event.delta });
        break;
      case "response.output_audio.delta":
        voiced = event.item_id ?? voiced;
        if (event.delta) events.push({ kind: "audio", data: event.delta, mime: PCM });
        break;
      case "response.output_audio_transcript.delta":
        if (event.delta) events.push({ kind: "transcript", of: "output", text: event.delta });
        break;
      case "conversation.item.input_audio_transcription.completed":
        if (event.transcript) events.push({ kind: "transcript", of: "input", text: event.transcript });
        break;
      case "input_audio_buffer.speech_started":
        events.push({ kind: "speech", state: "started" });
        break;
      case "input_audio_buffer.speech_stopped":
        events.push({ kind: "speech", state: "stopped" });
        break;
      case "response.function_call_arguments.done":
        call(event.call_id, event.name, event.arguments);
        break;
      case "response.done": {
        speaking = false;
        voiced = undefined;
        // A call is also an item of the finished response, for an endpoint that sent no event of its own for it.
        for (const item of event.response?.output ?? []) if (item.type === "function_call") call(item.call_id, item.name, item.arguments);
        const status = event.response?.status;
        const called = (event.response?.output ?? []).some((item) => item.type === "function_call");
        if (event.response?.usage) events.push({ kind: "usage", usage: usageOf(event.response.usage) });
        if (status === "failed") events.push({ kind: "error", error: event.response?.status_details?.error?.message ?? "the endpoint failed to answer" });
        events.push(
          status === "cancelled"
            ? { kind: "turn", state: "interrupted" }
            : { kind: "turn", state: "ended", stop: stopFor(status, event.response?.status_details?.reason, called) },
        );
        // Results that came back before the turn was over are answered now that it is.
        if (resume && !owed.size) {
          resume = false;
          connection.line.say({ type: "response.create" });
        }
        break;
      }
      case "error":
        events.push({ kind: "error", error: event.error?.message ?? "the endpoint reported an error" });
        // An error before the session is ready is the session not opening.
        connection.failed(new Error(event.error?.message ?? "the endpoint refused the session"));
        break;
      default:
        break;
    }
  };

  const connection = connect(
    request,
    realtimeUrl(request),
    request.apiKey ? (request.credentialHeader ? { [request.credentialHeader]: request.apiKey } : { authorization: `Bearer ${request.apiKey}` }) : {},
    hear,
    (why) => {
      events.push({ kind: "closed", ...(why ? { why } : {}) });
      events.end();
    },
  );
  const { line } = connection;
  const output = request.output ?? "audio";
  /** A session that does not come up leaves no socket behind. */
  const orClose = async (step: Promise<void>): Promise<void> => {
    try {
      await step;
    } catch (error) {
      line.close();
      throw error;
    }
  };
  await orClose(connection.opened);

  line.say({
    type: "session.update",
    session: {
      ...request.body,
      type: "realtime",
      ...(request.system ? { instructions: request.system } : {}),
      output_modalities: [output],
      ...(request.voice && output === "audio"
        ? { audio: { ...(request.body?.audio as object | undefined), output: { ...((request.body?.audio as { output?: object } | undefined)?.output), voice: request.voice } } }
        : {}),
      ...(request.tools?.length
        ? {
            tools: request.tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.parameters })),
            tool_choice: "auto",
          }
        : {}),
    },
  });
  await orClose(connection.settled);

  return {
    audio: { input: PCM, output: PCM },
    send(input: SessionInput): void {
      for (const attachment of input.attachments ?? []) {
        if (!attachment.mime.startsWith("image/")) events.push({ kind: "note", text: `${attachment.name ?? attachment.mime} was not sent: this session takes pictures, and nothing else, beside what is said.` });
      }
      const content: Record<string, unknown>[] = [
        ...(input.attachments ?? []).filter((attachment) => attachment.mime.startsWith("image/")).map((attachment) => ({ type: "input_image", image_url: dataUrl(attachment) })),
        ...(input.text ? [{ type: "input_text", text: input.text }] : []),
      ];
      if (content.length) line.say({ type: "conversation.item.create", item: { type: "message", role: "user", content } });
      if (input.audio) line.say({ type: "input_audio_buffer.append", audio: input.audio });
      // Typing ends a turn unless it is said not to; sound ends one only when it is said to.
      const done = input.done ?? (input.audio === undefined && content.length > 0);
      if (!done) return;
      if (input.audio !== undefined || !content.length) line.say({ type: "input_audio_buffer.commit" });
      line.say({ type: "response.create" });
    },
    answer(made: ToolCall, result: string): void {
      if (!owed.delete(made.id)) return;
      line.say({ type: "conversation.item.create", item: { type: "function_call_output", call_id: made.id, output: result } });
      // The model goes on once every call of the turn has its result, and the turn is over.
      if (owed.size) return;
      if (speaking) resume = true;
      else line.say({ type: "response.create" });
    },
    interrupt(heard?: number): void {
      if (speaking) line.say({ type: "response.cancel" });
      if (voiced && heard !== undefined) {
        line.say({ type: "conversation.item.truncate", item_id: voiced, content_index: 0, audio_end_ms: Math.max(0, Math.floor(heard)) });
      }
    },
    async close(): Promise<void> {
      line.close();
    },
    [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
  };
};
