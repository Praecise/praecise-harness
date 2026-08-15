/**
 * Streaming, in the protocol a front end already knows how to render.
 *
 * praecise has always streamed: `onText` hands over fragments as they arrive and the dev
 * server pushes them down an SSE channel. What it streamed was praecise's own `Progress`
 * union, which means every consumer writes a translator, and a front end that already
 * renders agents — CopilotKit, an AG-UI client, anything built against that vocabulary —
 * cannot render this one without work nobody has a reason to do.
 *
 * AG-UI is the protocol for that boundary, and it completes a set. MCP is how an agent
 * reaches tools. A2A is how an agent reaches another agent. AG-UI is how an agent reaches
 * the person watching. praecise already speaks the first two, and speaking its own dialect
 * for the third was the odd one out.
 *
 * ── The translation, and what it refuses to invent ────────────────────────────
 *
 * Every AG-UI event here is one praecise already knew. `text` becomes a message
 * content event, `tool` becomes a tool-call start, `note` becomes an activity, and so on.
 * Nothing is synthesised to fill a gap in the vocabulary: praecise does not stream
 * reasoning tokens, so no reasoning events are emitted, and an event stream that invented
 * them would be describing work that did not happen.
 *
 * ── Why messages are bracketed ────────────────────────────────────────────────
 *
 * AG-UI's text events come in start/content/end triples, and the brackets are not
 * ceremony: a renderer opens a bubble on start and closes it on end, and a stream of bare
 * content events leaves it guessing where one message stopped. praecise's own `text`
 * events carry no such boundary — an agent that calls a tool mid-answer produces text,
 * then a tool call, then more text — so the boundaries are derived here: a message opens
 * at the first fragment after anything that is not a fragment, and closes when something
 * that is not a fragment arrives.
 */

import type { Progress } from "../harness/types.js";

/** Event names, spelled as AG-UI spells them. */
export type AguiType =
  | "RunStarted"
  | "RunFinished"
  | "RunError"
  | "StepStarted"
  | "StepFinished"
  | "TextMessageStart"
  | "TextMessageContent"
  | "TextMessageEnd"
  | "ToolCallStart"
  | "ToolCallArgs"
  | "ToolCallEnd"
  | "ToolCallResult"
  | "StateSnapshot"
  | "StateDelta"
  | "ActivitySnapshot"
  | "Custom";

/** Every event carries these; the rest is per-type. */
export interface AguiEvent {
  type: AguiType;
  timestamp: number;
  /** What praecise sent, kept so a client can read anything not modelled here. */
  rawEvent?: unknown;
  [field: string]: unknown;
}

/**
 * The modes a caller can ask for.
 *
 * Borrowed from the vocabulary graph runtimes settled on, because it is the right split
 * and a caller who knows one knows this. They combine: a UI wants `messages` and `tools`,
 * a dashboard wants `updates`, a debugger wants everything.
 *
 *   `messages`  the agent's words, token by token
 *   `tools`     what it reached for and what came back
 *   `updates`   routing, escalation, checking — how the answer was arrived at
 *   `custom`    notes and anything an application emitted itself
 *   `values`    lifecycle only: started, finished, failed
 */
export type StreamMode = "messages" | "tools" | "updates" | "custom" | "values";

export const ALL_MODES: StreamMode[] = ["messages", "tools", "updates", "custom", "values"];

/** Which mode each praecise event belongs to. */
const MODE_OF: Record<Progress["kind"], StreamMode> = {
  routing: "updates",
  answering: "updates",
  checking: "updates",
  checked: "updates",
  climbing: "updates",
  text: "messages",
  tool: "tools",
  "tool result": "tools",
  refused: "values",
  note: "custom",
  done: "values",
  failed: "values",
};

export function modeOf(event: Progress): StreamMode {
  return MODE_OF[event.kind] ?? "custom";
}

/**
 * Turn praecise's stream into AG-UI's, keeping message boundaries.
 *
 * Stateful by necessity — the start and end of a message are not in any single event —
 * so this is a small machine rather than a pure function. `finish` exists because a
 * stream that ends mid-message must still close it: a renderer with an open bubble and no
 * closing event shows a spinner forever.
 */
export class AguiStream {
  private open = false;
  private messages = 0;
  private tools = 0;
  private readonly modes: Set<StreamMode>;

  private readonly runId: string;

  constructor(runId: string, modes: StreamMode[] = ALL_MODES) {
    this.runId = runId;
    this.modes = new Set(modes);
  }

  /** The event that opens any AG-UI stream. */
  started(): AguiEvent[] {
    return this.modes.has("values")
      ? [{ type: "RunStarted", timestamp: Date.now(), runId: this.runId }]
      : [];
  }

  /** One praecise event, as zero or more AG-UI events. */
  take(event: Progress): AguiEvent[] {
    const at = Date.now();
    const wanted = this.modes.has(modeOf(event));
    const out: AguiEvent[] = [];

    // A message closes when anything that is not a fragment arrives, whatever mode that
    // event belongs to — otherwise a tool call filtered out by the caller's mode
    // selection would leave the bubble open across it.
    if (event.kind !== "text" && this.open) {
      this.open = false;
      if (this.modes.has("messages")) {
        out.push({ type: "TextMessageEnd", timestamp: at, messageId: `msg-${this.messages}` });
      }
    }
    if (!wanted) return out;

    switch (event.kind) {
      case "text": {
        if (!this.open) {
          this.open = true;
          this.messages += 1;
          out.push({
            type: "TextMessageStart",
            timestamp: at,
            messageId: `msg-${this.messages}`,
            role: "assistant",
          });
        }
        out.push({
          type: "TextMessageContent",
          timestamp: at,
          messageId: `msg-${this.messages}`,
          delta: event.text,
        });
        return out;
      }

      case "tool": {
        this.tools += 1;
        out.push({
          type: "ToolCallStart",
          timestamp: at,
          toolCallId: `call-${this.tools}`,
          toolCallName: event.name,
        });
        // The arguments as AG-UI wants them: a string delta, not an object, because the
        // event is designed for a model streaming them a character at a time.
        out.push({
          type: "ToolCallArgs",
          timestamp: at,
          toolCallId: `call-${this.tools}`,
          delta: JSON.stringify(event.args ?? {}),
        });
        out.push({ type: "ToolCallEnd", timestamp: at, toolCallId: `call-${this.tools}` });
        return out;
      }

      case "tool result": {
        // praecise reports THAT a tool answered and whether it failed, not what it
        // said — the result goes to the model, not to the stream. Inventing a `content`
        // here would put an empty string where a renderer expects an answer.
        out.push({
          type: "ToolCallResult",
          timestamp: at,
          toolCallId: `call-${this.tools}`,
          toolCallName: event.name,
          ...(event.failed ? { error: true } : {}),
        });
        return out;
      }

      case "routing":
      case "answering":
      case "checking":
      case "checked":
      case "climbing": {
        // How the answer was arrived at. A step rather than a message: these bracket
        // work, and a renderer shows them as progress instead of as something said.
        out.push({
          type: "StepStarted",
          timestamp: at,
          stepName: event.kind,
          rawEvent: event,
        });
        out.push({ type: "StepFinished", timestamp: at, stepName: event.kind });
        return out;
      }

      case "note": {
        out.push({ type: "ActivitySnapshot", timestamp: at, description: event.text, rawEvent: event });
        return out;
      }

      case "refused": {
        out.push({ type: "RunError", timestamp: at, message: event.why, code: "refused" });
        return out;
      }

      case "done": {
        out.push({ type: "RunFinished", timestamp: at, runId: this.runId, rawEvent: event });
        return out;
      }

      case "failed": {
        out.push({ type: "RunError", timestamp: at, message: event.error, rawEvent: event });
        return out;
      }

      default:
        // Anything praecise gains later arrives as Custom rather than vanishing, so a
        // client sees the event even before this file has learned to name it.
        out.push({ type: "Custom", timestamp: at, name: (event as { kind: string }).kind, value: event });
        return out;
    }
  }

  /**
   * Close whatever is still open.
   *
   * A stream that ends mid-message leaves a renderer with an open bubble and a spinner
   * that never stops, which is the most common way an otherwise correct stream looks
   * broken.
   */
  finish(status: "ok" | "error" = "ok", message?: string): AguiEvent[] {
    const at = Date.now();
    const out: AguiEvent[] = [];
    if (this.open) {
      this.open = false;
      if (this.modes.has("messages")) {
        out.push({ type: "TextMessageEnd", timestamp: at, messageId: `msg-${this.messages}` });
      }
    }
    if (this.modes.has("values")) {
      out.push(
        status === "ok"
          ? { type: "RunFinished", timestamp: at, runId: this.runId }
          : { type: "RunError", timestamp: at, message: message ?? "failed" },
      );
    }
    return out;
  }
}

/**
 * One event as an SSE frame.
 *
 * The event NAME goes in the SSE `event:` field as well as in the JSON, because a browser
 * `EventSource` dispatches on that field and a client should not have to parse a body to
 * decide which listener to run.
 */
export function sseFrame(event: AguiEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Read a `?stream=` selector, falling back to everything. */
export function modesFrom(asked: string | null | undefined): StreamMode[] {
  if (!asked) return ALL_MODES;
  const wanted = asked
    .split(",")
    .map((mode) => mode.trim())
    .filter((mode): mode is StreamMode => (ALL_MODES as string[]).includes(mode));
  return wanted.length ? wanted : ALL_MODES;
}
