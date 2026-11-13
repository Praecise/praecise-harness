/**
 * A live session as an app holds it.
 *
 * A protocol reports that the model wants a tool. What an app should hear is that the
 * tool was called — after the guard was asked, with the same tools the agent has in an
 * ordinary request, and with the result already on its way back to the model. This is
 * the layer between: it reads the protocol's events, settles each tool call the way the
 * request loop settles one, and passes everything else through as it arrives.
 *
 * A tool runs beside the conversation, not in front of it: the model may go on speaking
 * while one is under way, and its events are not held up for the result.
 */

import type { Presented } from "./modality.js";
import type { TraceContext } from "./trace.js";
import type { Attachment, ChatResponse, ToolCall, Usage } from "./types.js";
import { Events, type Session, type SessionAudio, type SessionEvent, type SessionInput, type WireSession } from "./wire/session.js";

/** What opening a session may be told. */
export interface OpenOptions {
  /** Closes the session when it fires. */
  signal?: AbortSignal;
  /** What the model answers in. Speech unless said. */
  output?: "audio" | "text";
  /** The voice it speaks in, where the endpoint has several. The endpoint's `realtime.voice` unless said. */
  voice?: string;
  /** Start the session already tainted: something untrusted was read before it began. */
  tainted?: boolean;
  /** The trace this session is part of, so its tool calls join it. */
  trace?: TraceContext;
  /** Who the session is for, as the app vouches for them. */
  caller?: import("./types.js").AskCaller;
  /** Whatever the app sends along with the session, handed to the guard, the authority and functions. See `AskOptions.context`. */
  context?: unknown;
  surface?: string;
}

/** What the runtime does for a session: the parts that are the same as in a request. */
export interface SessionFaculties {
  /** Add what a turn cost to the session's total. */
  count(usage: ChatResponse["usage"]): void;
  /**
   * Settle one call: ask the guard, run the tool, and return what the model is told.
   * Reports the call, and its result or refusal, through `emit` as they happen.
   */
  call(call: ToolCall, emit: (event: SessionEvent) => void): Promise<string>;
  /** Decide who reads what was sent with something said: the endpoint, a reader, or nobody. */
  show(attachments: readonly Attachment[]): Promise<Presented>;
}

export class LiveSession implements Session {
  readonly usage: Usage;
  private readonly inner: WireSession;
  private readonly faculties: SessionFaculties;
  private readonly out = new Events<SessionEvent>();
  /** Sends still being prepared, so that what is said second arrives second. */
  private sending: Promise<void> = Promise.resolve();
  private preparing = 0;

  constructor(inner: WireSession, usage: Usage, faculties: SessionFaculties, notes: readonly string[] = []) {
    this.inner = inner;
    this.usage = usage;
    this.faculties = faculties;
    for (const text of notes) this.out.push({ kind: "note", text });
    void this.pump();
  }

  get audio(): SessionAudio {
    return this.inner.audio;
  }

  private async pump(): Promise<void> {
    try {
      for await (const event of this.inner) {
        if (event.kind === "tool") {
          void this.settle(event.call);
          continue;
        }
        if (event.kind === "usage") this.faculties.count(event.usage);
        this.out.push(event);
      }
    } catch (error) {
      this.out.push({ kind: "error", error: (error as Error).message });
    } finally {
      this.out.end();
    }
  }

  private async settle(call: ToolCall): Promise<void> {
    let result: string;
    try {
      result = await this.faculties.call(call, (event) => this.out.push(event));
    } catch (error) {
      // Nothing here may end the session: the model is told the call failed and goes on.
      result = `Error calling ${call.name}: ${(error as Error).message}`;
      this.out.push({ kind: "tool result", name: call.name, failed: true });
    }
    this.inner.answer(call, result);
  }

  send(input: SessionInput): void {
    // Sound is the common case and must not wait on anything: it goes straight through
    // unless something said before it is still being prepared.
    if (!input.attachments?.length && this.preparing === 0) {
      this.inner.send(input);
      return;
    }
    this.preparing++;
    this.sending = this.sending
      .then(() => this.prepared(input))
      .catch((error: unknown) => this.out.push({ kind: "error", error: (error as Error).message }))
      .finally(() => {
        this.preparing--;
      });
  }

  /** Send something whose attachments have first to be read for the model. */
  private async prepared(input: SessionInput): Promise<void> {
    if (!input.attachments?.length) {
      this.inner.send(input);
      return;
    }
    const shown = await this.faculties.show(input.attachments);
    for (const text of shown.notes) this.out.push({ kind: "note", text });
    const text = [input.text, shown.text].filter(Boolean).join("\n\n");
    this.inner.send({
      ...input,
      ...(text ? { text } : {}),
      attachments: shown.attachments,
    });
  }

  interrupt(heard?: number): void {
    this.inner.interrupt(heard);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }

  [Symbol.asyncIterator](): AsyncIterator<SessionEvent> {
    return this.out[Symbol.asyncIterator]();
  }
}
