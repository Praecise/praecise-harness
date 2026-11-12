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
 * them would be describing work that did not happen. For the same reason a finished run
 * says `outcome: success` and never `interrupt`: an agent's answer does not pause for a
 * person, so there is no interrupt to report.
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

/**
 * Event names, spelled as AG-UI spells them on the wire: upper snake case, which is the
 * value of the protocol's `EventType` and what a client's reducer switches on.
 *
 * This is the set the stream can emit, not the whole standard. The reasoning events are
 * absent on purpose (see above), and so are `MESSAGES_SNAPSHOT`, `ACTIVITY_DELTA` and
 * `RAW`, which nothing here has cause to send.
 */
export type AguiType =
  | "RUN_STARTED"
  | "RUN_FINISHED"
  | "RUN_ERROR"
  | "STEP_STARTED"
  | "STEP_FINISHED"
  | "TEXT_MESSAGE_START"
  | "TEXT_MESSAGE_CONTENT"
  | "TEXT_MESSAGE_END"
  | "TOOL_CALL_START"
  | "TOOL_CALL_ARGS"
  | "TOOL_CALL_END"
  | "TOOL_CALL_RESULT"
  | "STATE_SNAPSHOT"
  | "STATE_DELTA"
  | "ACTIVITY_SNAPSHOT"
  | "CUSTOM";

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
  // With the tools, not the lifecycle: a refused call is something that happened to a
  // tool call, and the run goes on after it.
  refused: "tools",
  note: "custom",
  self: "custom",
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
  private activities = 0;
  /**
   * Calls that have started and not yet answered, by tool name, oldest first. praecise's
   * `tool result` names the tool and not the call, so two calls in flight are told apart
   * by order: a result belongs to the oldest unanswered call of that name.
   */
  private readonly calling = new Map<string, string[]>();
  /** Set once the run's last event is out. Nothing may follow it, and it is sent once. */
  private ended = false;
  private readonly modes: Set<StreamMode>;

  private readonly runId: string;
  private readonly threadId: string;

  /**
   * `threadId` is the conversation the run belongs to, which AG-UI requires on the
   * events that open and close a run. A run outside any conversation is its own thread.
   */
  constructor(runId: string, modes: StreamMode[] = ALL_MODES, threadId: string = runId) {
    this.runId = runId;
    this.threadId = threadId;
    this.modes = new Set(modes);
  }

  /** The event that opens any AG-UI stream. */
  started(): AguiEvent[] {
    return this.modes.has("values")
      ? [{ type: "RUN_STARTED", timestamp: Date.now(), threadId: this.threadId, runId: this.runId }]
      : [];
  }

  /** One praecise event, as zero or more AG-UI events. */
  take(event: Progress): AguiEvent[] {
    // `RUN_FINISHED` and `RUN_ERROR` are the last event of a run by definition. Anything
    // arriving after one has nowhere to go.
    if (this.ended) return [];

    const at = Date.now();
    const wanted = this.modes.has(modeOf(event));
    const out: AguiEvent[] = [];

    // A message closes when anything that is not a fragment arrives, whatever mode that
    // event belongs to — otherwise a tool call filtered out by the caller's mode
    // selection would leave the bubble open across it.
    if (event.kind !== "text" && this.open) {
      this.open = false;
      if (this.modes.has("messages")) {
        out.push({ type: "TEXT_MESSAGE_END", timestamp: at, messageId: `msg-${this.messages}` });
      }
    }
    if (!wanted) return out;

    switch (event.kind) {
      case "text": {
        if (!this.open) {
          this.open = true;
          this.messages += 1;
          out.push({
            type: "TEXT_MESSAGE_START",
            timestamp: at,
            messageId: `msg-${this.messages}`,
            role: "assistant",
          });
        }
        out.push({
          type: "TEXT_MESSAGE_CONTENT",
          timestamp: at,
          messageId: `msg-${this.messages}`,
          delta: event.text,
        });
        return out;
      }

      case "tool": {
        this.tools += 1;
        const toolCallId = `call-${this.tools}`;
        this.calling.set(event.name, [...(this.calling.get(event.name) ?? []), toolCallId]);
        out.push({
          type: "TOOL_CALL_START",
          timestamp: at,
          toolCallId,
          toolCallName: event.name,
        });
        // The arguments as AG-UI wants them: a string delta, not an object, because the
        // event is designed for a model streaming them a character at a time.
        out.push({
          type: "TOOL_CALL_ARGS",
          timestamp: at,
          toolCallId,
          delta: JSON.stringify(event.args ?? {}),
        });
        out.push({ type: "TOOL_CALL_END", timestamp: at, toolCallId });
        return out;
      }

      case "tool result": {
        // The call this answers. A result with no call on record is one whose start
        // this stream never saw, and gets an id of its own instead of another call's.
        const toolCallId = this.calling.get(event.name)?.shift() ?? `call-${(this.tools += 1)}`;
        // praecise reports THAT a tool answered and whether it failed, not what it
        // said — the result goes to the model, not to the stream. AG-UI requires
        // `content`, so it carries exactly that much: the outcome, as a word. It is not
        // the tool's output and does not pretend to be.
        out.push({
          type: "TOOL_CALL_RESULT",
          timestamp: at,
          messageId: `result-${toolCallId}`,
          toolCallId,
          content: event.failed ? "failed" : "completed",
          role: "tool",
          rawEvent: event,
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
          type: "STEP_STARTED",
          timestamp: at,
          stepName: event.kind,
          rawEvent: event,
        });
        out.push({ type: "STEP_FINISHED", timestamp: at, stepName: event.kind });
        return out;
      }

      case "note": {
        out.push(this.activity(at, "note", { text: event.text }, event));
        return out;
      }

      case "refused": {
        // An activity and not `RUN_ERROR`. The app declined one call and the model was
        // told why; the run carries on, and `RUN_ERROR` is the event that says it did not.
        out.push(this.activity(at, "refused", { name: event.name, why: event.why }, event));
        return out;
      }

      case "done": {
        this.ended = true;
        out.push({
          type: "RUN_FINISHED",
          timestamp: at,
          threadId: this.threadId,
          runId: this.runId,
          outcome: { type: "success" },
          rawEvent: event,
        });
        return out;
      }

      case "failed": {
        this.ended = true;
        out.push({ type: "RUN_ERROR", timestamp: at, message: event.error, rawEvent: event });
        return out;
      }

      default:
        // Anything praecise gains later arrives as CUSTOM rather than vanishing, so a
        // client sees the event even before this file has learned to name it.
        out.push({ type: "CUSTOM", timestamp: at, name: (event as { kind: string }).kind, value: event });
        return out;
    }
  }

  /**
   * Something that happened which is neither said by the agent nor a step of the run.
   *
   * Each is a message of its own, complete when it is sent: `replace` is true because
   * there is no earlier snapshot of the same activity for it to be merged into.
   */
  private activity(at: number, activityType: string, content: Record<string, unknown>, rawEvent: Progress): AguiEvent {
    this.activities += 1;
    return {
      type: "ACTIVITY_SNAPSHOT",
      timestamp: at,
      messageId: `activity-${this.activities}`,
      activityType,
      content,
      replace: true,
      rawEvent,
    };
  }

  /**
   * Close whatever is still open.
   *
   * A stream that ends mid-message leaves a renderer with an open bubble and a spinner
   * that never stops, which is the most common way an otherwise correct stream looks
   * broken.
   *
   * The run's last event is sent here only if `take` has not sent it already. A run that
   * reported `done` or `failed` has had its ending, and a second `RUN_FINISHED` — or a
   * `RUN_FINISHED` after a `RUN_ERROR` — would tell a client the run ended twice, or
   * succeeded after it failed.
   */
  finish(status: "ok" | "error" = "ok", message?: string): AguiEvent[] {
    const at = Date.now();
    const out: AguiEvent[] = [];
    if (this.open) {
      this.open = false;
      if (this.modes.has("messages")) {
        out.push({ type: "TEXT_MESSAGE_END", timestamp: at, messageId: `msg-${this.messages}` });
      }
    }
    if (this.modes.has("values") && !this.ended) {
      out.push(
        status === "ok"
          ? {
              type: "RUN_FINISHED",
              timestamp: at,
              threadId: this.threadId,
              runId: this.runId,
              outcome: { type: "success" },
            }
          : { type: "RUN_ERROR", timestamp: at, message: message ?? "failed" },
      );
    }
    this.ended = true;
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
