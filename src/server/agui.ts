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
 * them would be describing work that did not happen. For the same reason an agent's
 * finished run says `outcome: success` and never `interrupt`: an agent's answer does not
 * pause for a person, so there is no interrupt to report.
 *
 * A workflow does pause — at an approval gate — and that is the one interrupt there is.
 * A workflow run that stops at a gate ends its stream with `outcome: interrupt` naming
 * the gate, and is carried on by a new request whose `resume` answers it. The answer
 * goes down the same path as any other approval, so a gate is exactly as hard to clear
 * from here as from anywhere else.
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
import type { Run, RunEvent } from "../workflow/store.js";

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

/** A place a run stopped for a person, as AG-UI describes one. */
export interface AguiInterrupt {
  id: string;
  reason: string;
  message?: string;
  /** JSON Schema for the `payload` that answers it. */
  responseSchema?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/** One answer to an interrupt, as the request that resumes a run carries it. */
export interface AguiResume {
  interruptId: string;
  status: "resolved" | "cancelled";
  payload?: unknown;
}

/** What answers an approval gate. The last three matter only where the app checks signatures. */
const APPROVAL_SCHEMA = {
  type: "object",
  properties: {
    approved: { type: "boolean", description: "true to let the run continue, false to end it here" },
    note: { type: "string", description: "why, for the run's record" },
    approver: { type: "string", description: "who is deciding, as they call themselves" },
    signature: { type: "string", description: "a signature over the approval claim, where the app verifies one" },
    at: { type: "number", description: "when the claim was signed, in milliseconds; required with a signature" },
  },
  required: ["approved"],
} as const;

/**
 * The gate a waiting run is stopped at, as an interrupt. Nothing for a run that is not waiting.
 *
 * The id is the run and the gate together, so an answer names both: a run has one open
 * gate at a time, and an answer meant for an earlier gate must not clear a later one.
 */
export function interruptOf(run: Pick<Run, "id" | "workflow" | "status" | "waitingFor">): AguiInterrupt | undefined {
  // A run waiting for an event is not asking this caller for anything, and offering
  // an approval for it would offer something the runner refuses.
  if (run.status !== "waiting" || !run.waitingFor || run.waitingFor.event) return undefined;
  const quorum = run.waitingFor.requires?.quorum;
  return {
    id: `${run.id}:${run.waitingFor.step}`,
    reason: "approval",
    message: run.waitingFor.prompt,
    responseSchema: APPROVAL_SCHEMA,
    metadata: {
      runId: run.id,
      workflow: run.workflow,
      step: run.waitingFor.step,
      ...(quorum && quorum > 1 ? { quorum } : {}),
    },
  };
}

/**
 * Read a request's `resume` and find the run it answers.
 *
 * Returns the run and the answer in the shape the approval endpoint's body has, so the
 * caller can hand it to the same code that reads that body — or a sentence saying why
 * not. A cancelled interrupt is a refusal: `approved: false`, whatever else it carried.
 * A resolved one says for itself, and is not read as approval unless it says so.
 *
 * AG-UI requires one resume to address every open interrupt. A run has exactly one, so
 * a resume is one answer; more than one is refused, not half-applied.
 */
export async function answerInterrupts(
  runs: { load(id: string): Promise<Run | undefined> },
  workflow: string,
  resume: unknown,
): Promise<{ run: Run; answer: Record<string, unknown> } | string> {
  const shape = "`resume` must be an array of { interruptId, status: \"resolved\" | \"cancelled\", payload }";
  if (!Array.isArray(resume) || !resume.length) return shape;
  if (resume.length > 1) {
    return `a run stops at one gate at a time, so a resume carries one answer; this one carries ${resume.length}. Send the answer to the interrupt the run last reported.`;
  }
  const entry = resume[0] as Partial<AguiResume> | null;
  if (typeof entry !== "object" || entry === null || typeof entry.interruptId !== "string" || !entry.interruptId) {
    return shape;
  }
  if (entry.status !== "resolved" && entry.status !== "cancelled") {
    return `${shape}; got status ${JSON.stringify(entry.status ?? null)}`;
  }

  // The id is `<run>:<step>` and either half may itself contain a colon, so each split
  // is tried against the record instead of trusting the first one.
  const id = entry.interruptId;
  let run: Run | undefined;
  for (let at = id.indexOf(":"); at > 0 && !run; at = id.indexOf(":", at + 1)) {
    const candidate = await runs.load(id.slice(0, at));
    if (candidate && interruptOf(candidate)?.id === id) run = candidate;
  }
  if (!run) {
    return `no open interrupt "${id}": the run is not waiting at that gate. It may already have been answered — read the run to see where it is.`;
  }
  if (run.workflow !== workflow) {
    return `interrupt "${id}" belongs to a run of "${run.workflow}", not "${workflow}". Resume it at /api/workflows/${run.workflow}.`;
  }

  const payload = entry.payload;
  const said = typeof payload === "object" && payload !== null && !Array.isArray(payload);
  if (entry.status === "cancelled") {
    return { run, answer: { ...(said ? (payload as Record<string, unknown>) : {}), approved: false } };
  }
  if (!said) return "a resolved interrupt carries a payload of { approved: true | false, note? }";
  return { run, answer: payload as Record<string, unknown> };
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
   * One entry of a workflow run's record, as zero or more AG-UI events.
   *
   * A step is reported once it is over, which is when the record learns of it, so its
   * start and finish arrive together. Everything else the record holds — a gate reached,
   * a plan made, an outcome judged — has no AG-UI event of its own and goes as CUSTOM
   * under the record's own word for it.
   */
  step(event: RunEvent): AguiEvent[] {
    if (this.ended || !this.modes.has("updates")) return [];
    const at = Date.now();
    if (event.kind === "done" || event.kind === "skipped") {
      return [
        { type: "STEP_STARTED", timestamp: at, stepName: event.step, rawEvent: event },
        { type: "STEP_FINISHED", timestamp: at, stepName: event.step },
      ];
    }
    return [{ type: "CUSTOM", timestamp: at, name: event.kind, value: event }];
  }

  /**
   * The last event of a workflow run's stream, from what the run came to.
   *
   * Done is success. Waiting at a gate is an interrupt, which is still `RUN_FINISHED`:
   * this stretch of the run is over, and what it is waiting for is in the outcome.
   * Failed is `RUN_ERROR`.
   */
  settle(run: Pick<Run, "id" | "workflow" | "status" | "waitingFor" | "result" | "error">): AguiEvent[] {
    if (run.status === "failed") return this.finish("error", run.error ?? `run ${run.id} failed`);
    if (run.status === "cancelled") return this.finish("error", `run ${run.id} was cancelled`);
    const interrupt = interruptOf(run);
    if (run.status === "waiting" && run.waitingFor?.event) {
      return this.finish(
        "error",
        `run ${run.id} is waiting for the event ${run.waitingFor.event.type} and this stream has stopped following it; ` +
          `it continues when that event is delivered, and the run says what it comes to`,
      );
    }
    if (run.status !== "done" && !interrupt) {
      return this.finish("error", `run ${run.id} is ${run.status} and this stream has stopped following it; read the run to see what it comes to`);
    }
    if (this.ended) return [];
    this.ended = true;
    if (!this.modes.has("values")) return [];
    return [
      {
        type: "RUN_FINISHED",
        timestamp: Date.now(),
        threadId: this.threadId,
        runId: this.runId,
        outcome: interrupt ? { type: "interrupt", interrupts: [interrupt] } : { type: "success" },
        ...(!interrupt && run.result !== undefined ? { result: run.result } : {}),
      },
    ];
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
