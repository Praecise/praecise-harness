/**
 * The session protocol the `contents` and `interactions` shapes' vendor publishes: one
 * JSON object per frame, each with a single key saying what it is, over a socket at
 * `/ws/google.ai.generativelanguage.{version}.GenerativeService.BidiGenerateContent`.
 *
 * Written from the vendor's documentation as it stood on 2026-11-13.
 *
 *   → setup                              the model, how it answers, instructions, tools
 *   ← setupComplete                      and it is ready
 *   → realtimeInput.text                 something typed
 *   → realtimeInput.audio                a stretch of sound: 16-bit PCM, 16 kHz
 *   → realtimeInput.video                a picture, as a frame
 *   → realtimeInput.audioStreamEnd       that was the end of the sound
 *   ← serverContent.modelTurn.parts      what the model writes (`text`) and says (`inlineData`)
 *   ← serverContent.outputTranscription  what it says, written down
 *   ← serverContent.inputTranscription   what it heard, written down
 *   ← serverContent.turnComplete         the turn is over
 *   ← serverContent.interrupted          the turn was cut off
 *   ← toolCall.functionCalls             it wants tools
 *   → toolResponse.functionResponses     their results
 *   ← toolCallCancellation.ids           it no longer wants those
 *   ← usageMetadata                      what it has cost
 *   ← goAway                             the connection is about to be closed
 *
 * Two things differ from the other protocol that ships and are worth knowing. There is
 * no message that only stops the model: what the documentation gives is that a
 * `clientContent` message interrupts whatever is being generated, so an empty one is
 * what `interrupt` sends. And the credential travels in the address, as it does on the
 * `contents` wire, unless the provider named a header for it.
 */

import type { ChatResponse, ToolCall } from "../types.js";
import { versioned } from "./contents.js";
import { Events, connect, socketBase, type SessionEvent, type SessionInput, type SessionOpener, type SessionRequest, type WireSession } from "./session.js";

interface Part {
  text?: string;
  /** Set on a part that is the model thinking rather than answering. */
  thought?: boolean;
  inlineData?: { mimeType?: string; data?: string };
}

interface UsageMetadata {
  promptTokenCount?: number;
  responseTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
}

interface Incoming {
  setupComplete?: unknown;
  serverContent?: {
    modelTurn?: { parts?: Part[] };
    turnComplete?: boolean;
    interrupted?: boolean;
    inputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
  };
  toolCall?: { functionCalls?: { id?: string; name?: string; args?: Record<string, unknown> }[] };
  toolCallCancellation?: { ids?: string[] };
  usageMetadata?: UsageMetadata;
  goAway?: { timeLeft?: string };
}

/** Where the socket is: the endpoint's host, at the path the protocol is published under for its version. */
export function liveUrl(request: Pick<SessionRequest, "baseUrl" | "url" | "apiKey" | "credentialHeader">): string {
  const url = request.url ? new URL(request.url) : socketBase(request.baseUrl);
  if (!request.url) {
    const version = /\/(v\d[^/]*)$/.exec(versioned(request.baseUrl))?.[1] ?? "v1beta";
    url.pathname = `/ws/google.ai.generativelanguage.${version}.GenerativeService.BidiGenerateContent`;
  }
  if (request.apiKey && !request.credentialHeader && !url.searchParams.has("key")) url.searchParams.set("key", request.apiKey);
  return url.toString();
}

function usageOf(meta: UsageMetadata): ChatResponse["usage"] {
  return {
    inputTokens: meta.promptTokenCount ?? 0,
    // Reasoning is reported beside the response on this vendor's surfaces, not inside it.
    outputTokens: (meta.responseTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0),
    cachedTokens: meta.cachedContentTokenCount ?? 0,
    ...(meta.thoughtsTokenCount ? { reasoningTokens: meta.thoughtsTokenCount } : {}),
  };
}

/** A function with no arguments is declared without a schema, as on the `contents` wire: an empty one is refused. */
function declarationsFor(tools: NonNullable<SessionRequest["tools"]>): Record<string, unknown>[] {
  return tools.map((tool) => {
    const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties;
    return { name: tool.name, description: tool.description, ...(properties && Object.keys(properties).length ? { parameters: tool.parameters } : {}) };
  });
}

export const liveSession: SessionOpener = async (request: SessionRequest): Promise<WireSession> => {
  const events = new Events<SessionEvent>();
  /** Calls the model is waiting on, by id, with the name each result must carry. */
  const owed = new Map<string, string>();
  let speaking = false;
  /** What the turn under way has cost, as last reported. Counted once, when the turn is over. */
  let cost: UsageMetadata | undefined;

  const over = (state: "ended" | "interrupted"): void => {
    if (cost) events.push({ kind: "usage", usage: usageOf(cost) });
    cost = undefined;
    speaking = false;
    events.push(state === "ended" ? { kind: "turn", state, stop: "end" } : { kind: "turn", state });
  };

  const hear = (message: Record<string, unknown>): void => {
    const event = message as Incoming;
    if (event.setupComplete !== undefined) connection.ready();
    if (event.usageMetadata) cost = event.usageMetadata;

    const content = event.serverContent;
    if (content) {
      const parts = content.modelTurn?.parts ?? [];
      if (parts.length && !speaking) {
        speaking = true;
        events.push({ kind: "turn", state: "started" });
      }
      for (const part of parts) {
        if (part.inlineData?.data) events.push({ kind: "audio", data: part.inlineData.data, mime: part.inlineData.mimeType ?? "audio/pcm;rate=24000" });
        else if (part.text && !part.thought) events.push({ kind: "text", text: part.text });
      }
      if (content.inputTranscription?.text) events.push({ kind: "transcript", of: "input", text: content.inputTranscription.text });
      if (content.outputTranscription?.text) events.push({ kind: "transcript", of: "output", text: content.outputTranscription.text });
      if (content.interrupted) over("interrupted");
      else if (content.turnComplete) over("ended");
    }

    for (const call of event.toolCall?.functionCalls ?? []) {
      if (!call.name) continue;
      // An id is what a result is matched by; an endpoint that sent none is answered by name.
      const id = call.id ?? `${call.name}-${owed.size}`;
      owed.set(id, call.name);
      events.push({ kind: "tool", call: { id, name: call.name, args: call.args ?? {} } });
    }
    if (event.toolCallCancellation?.ids?.length) {
      const dropped = event.toolCallCancellation.ids.filter((id) => owed.delete(id));
      if (dropped.length) events.push({ kind: "note", text: `the model withdrew ${dropped.length} tool call(s) before they were answered; their results will not be sent` });
    }
    if (event.goAway) events.push({ kind: "note", text: `the endpoint is about to close this session${event.goAway.timeLeft ? ` (in ${event.goAway.timeLeft})` : ""}` });
  };

  const connection = connect(
    request,
    liveUrl(request),
    request.apiKey && request.credentialHeader ? { [request.credentialHeader]: request.apiKey } : {},
    hear,
    (why) => {
      events.push({ kind: "closed", ...(why ? { why } : {}) });
      events.end();
    },
  );
  const { line } = connection;
  const orClose = async (step: Promise<void>): Promise<void> => {
    try {
      await step;
    } catch (error) {
      line.close();
      throw error;
    }
  };
  await orClose(connection.opened);

  const output = request.output ?? "audio";
  const declared = (request.body?.generationConfig as Record<string, unknown> | undefined) ?? {};
  line.say({
    setup: {
      ...request.body,
      model: request.model.startsWith("models/") ? request.model : `models/${request.model}`,
      generationConfig: {
        ...declared,
        responseModalities: [output === "audio" ? "AUDIO" : "TEXT"],
        ...(request.voice && output === "audio" ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: request.voice } } } } : {}),
      },
      ...(request.system ? { systemInstruction: { parts: [{ text: request.system }] } } : {}),
      ...(request.tools?.length ? { tools: [{ functionDeclarations: declarationsFor(request.tools) }] } : {}),
      // Asked for whenever speech is: what was said is then on the record as text too.
      ...(output === "audio" ? { inputAudioTranscription: {}, outputAudioTranscription: {} } : {}),
    },
  });
  await orClose(connection.settled);

  return {
    audio: { input: "audio/pcm;rate=16000", output: "audio/pcm;rate=24000" },
    send(input: SessionInput): void {
      for (const attachment of input.attachments ?? []) {
        if (attachment.mime.startsWith("image/") && attachment.data !== undefined) {
          line.say({ realtimeInput: { video: { data: attachment.data, mimeType: attachment.mime } } });
        } else {
          events.push({ kind: "note", text: `${attachment.name ?? attachment.mime} was not sent: this session takes a picture as its bytes, and nothing else.` });
        }
      }
      if (input.audio) line.say({ realtimeInput: { audio: { data: input.audio, mimeType: "audio/pcm;rate=16000" } } });
      if (input.text) line.say({ realtimeInput: { text: input.text } });
      // The endpoint hears where speech stops; this is for sound that simply ends.
      if (input.done && !input.text) line.say({ realtimeInput: { audioStreamEnd: true } });
    },
    answer(made: ToolCall, result: string): void {
      const name = owed.get(made.id);
      if (name === undefined) return;
      owed.delete(made.id);
      line.say({ toolResponse: { functionResponses: [{ id: made.id, name, response: { result } }] } });
    },
    interrupt(): void {
      if (speaking) line.say({ clientContent: { turns: [], turnComplete: false } });
    },
    async close(): Promise<void> {
      line.close();
    },
    [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
  };
};
