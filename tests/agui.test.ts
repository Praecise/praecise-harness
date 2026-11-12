/**
 * Streaming, in a protocol something else already renders.
 *
 * praecise always streamed; what it streamed was its own vocabulary, which means every
 * consumer writes a translator. AG-UI is the protocol for this boundary and it completes
 * a set: MCP is how an agent reaches tools, A2A how it reaches another agent, AG-UI how
 * it reaches the person watching.
 *
 * The properties worth testing are the ones a renderer depends on and a naive translation
 * gets wrong: messages that open and close, a stream that closes what it opened even when
 * it fails, and mode filtering that does not leave a bubble open across the events it
 * filtered out.
 */
import { describe, expect, it } from "vitest";

import {
  ALL_MODES,
  AguiStream,
  answerInterrupts,
  interruptOf,
  modeOf,
  modesFrom,
  sseFrame,
  type AguiEvent,
} from "../src/server/agui.js";
import type { Progress } from "../src/harness/types.js";
import type { Run } from "../src/workflow/store.js";

const types = (events: AguiEvent[]): string[] => events.map((event) => event.type);

describe("translating praecise's stream into AG-UI's", () => {
  it("brackets a message, so a renderer knows where to open and close a bubble", () => {
    const stream = new AguiStream("run-1");
    const opened = stream.take({ kind: "text", text: "Hello " });
    const more = stream.take({ kind: "text", text: "world" });
    const closed = stream.finish();

    expect(types(opened)).toEqual(["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT"]);
    // A second fragment does NOT reopen the message.
    expect(types(more)).toEqual(["TEXT_MESSAGE_CONTENT"]);
    expect(types(closed)).toContain("TEXT_MESSAGE_END");
  });

  it("closes a message when a tool call interrupts it, and opens a new one after", () => {
    // An agent that reaches for a tool mid-answer produces text, then a call, then more
    // text. Without boundaries a renderer shows one bubble with a tool call inside it.
    const stream = new AguiStream("run-1");
    stream.take({ kind: "text", text: "Let me check" });
    const during = stream.take({ kind: "tool", name: "lookup", args: { id: 1 } });
    const after = stream.take({ kind: "text", text: "It is here" });

    expect(during[0]?.type).toBe("TEXT_MESSAGE_END");
    expect(types(during)).toEqual(["TEXT_MESSAGE_END", "TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END"]);
    expect(after[0]?.type).toBe("TEXT_MESSAGE_START");
    // A new message, not the old one continued.
    expect(after[0]?.messageId).not.toBe(during[0]?.messageId);
  });

  it("sends tool arguments as a string delta, which is the shape AG-UI defines", () => {
    const stream = new AguiStream("run-1");
    const events = stream.take({ kind: "tool", name: "lookup", args: { id: 7 } });
    const args = events.find((event) => event.type === "TOOL_CALL_ARGS");
    expect(typeof args?.delta).toBe("string");
    expect(JSON.parse(String(args?.delta))).toEqual({ id: 7 });
  });

  it("closes an open message even when the run fails", () => {
    // A renderer left with an open bubble and no closing event shows a spinner that
    // never stops, which is the most common way a correct stream looks broken.
    const stream = new AguiStream("run-1");
    stream.take({ kind: "text", text: "half a th" });
    const ended = stream.finish("error", "upstream died");

    expect(types(ended)).toEqual(["TEXT_MESSAGE_END", "RUN_ERROR"]);
    expect(ended.at(-1)?.message).toBe("upstream died");
  });

  it("invents no event for work that did not happen", () => {
    // praecise does not stream reasoning tokens. A stream emitting reasoning events
    // would be describing work nobody did.
    const stream = new AguiStream("run-1");
    const everything = [
      ...stream.started(),
      ...stream.take({ kind: "text", text: "x" }),
      ...stream.finish(),
    ];
    // Neither the current names nor the `THINKING_*` ones AG-UI 1.0.0 removed.
    expect(types(everything).some((type) => /REASONING|THINKING/i.test(type))).toBe(false);
  });
});

describe("the events, in the shape the standard gives them", () => {
  const STANDARD = new Set([
    "RUN_STARTED", "RUN_FINISHED", "RUN_ERROR", "STEP_STARTED", "STEP_FINISHED",
    "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END",
    "TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "TOOL_CALL_RESULT",
    "STATE_SNAPSHOT", "STATE_DELTA", "MESSAGES_SNAPSHOT",
    "ACTIVITY_SNAPSHOT", "ACTIVITY_DELTA", "RAW", "CUSTOM",
  ]);

  const answer = { text: "x", path: [], usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, decidingTokens: 0 }, toolCalls: [], harness: "test" };
  const everyKind: Progress[] = [
    { kind: "routing", entry: "m", rungs: 2, verify: true, difficulty: 0.4 },
    { kind: "answering", model: "m", effort: 0 },
    { kind: "text", text: "x" },
    { kind: "checking", samples: 2 },
    { kind: "checked", agreement: 1, kept: true },
    { kind: "climbing", from: "a", to: "b", why: "disagreed" },
    { kind: "tool", name: "lookup", args: {} },
    { kind: "tool result", name: "lookup", failed: false },
    { kind: "refused", name: "wipe", why: "not allowed" },
    { kind: "note", text: "n" },
    { kind: "self", handle: "h", drewOn: [] },
    { kind: "done", answer },
  ];

  it("names every event it sends as the standard names it", () => {
    const stream = new AguiStream("run-1");
    const sent = [...stream.started(), ...everyKind.flatMap((event) => stream.take(event)), ...stream.finish()];
    for (const type of types(sent)) expect(STANDARD).toContain(type);
  });

  it("opens and closes a run with its thread as well as its id", () => {
    const stream = new AguiStream("run-1", ALL_MODES, "thread-9");
    expect(stream.started()[0]).toMatchObject({ type: "RUN_STARTED", threadId: "thread-9", runId: "run-1" });
    expect(stream.finish()[0]).toMatchObject({
      type: "RUN_FINISHED",
      threadId: "thread-9",
      runId: "run-1",
      outcome: { type: "success" },
    });
    // A run outside any conversation is its own thread, since the field is required.
    expect(new AguiStream("run-2").started()[0]?.threadId).toBe("run-2");
  });

  it("ends a run once: `done` is the ending, and closing the stream does not send another", () => {
    const stream = new AguiStream("run-1");
    const done = stream.take({ kind: "done", answer });
    expect(types(done)).toEqual(["RUN_FINISHED"]);
    expect(types(stream.finish())).toEqual([]);
  });

  it("ends a failed run in RUN_ERROR, and never follows it with RUN_FINISHED", () => {
    // A run that reported `failed` without throwing reaches `finish("ok")`. Sending
    // RUN_FINISHED there would tell a client the run succeeded after it failed.
    const stream = new AguiStream("run-1");
    const failed = stream.take({ kind: "failed", error: "upstream died" });
    expect(failed.at(-1)).toMatchObject({ type: "RUN_ERROR", message: "upstream died" });
    expect(types(stream.finish())).toEqual([]);
    expect(types(stream.finish("error", "again"))).toEqual([]);
    // Nothing follows the last event of a run.
    expect(stream.take({ kind: "text", text: "late" })).toEqual([]);
  });

  it("reports a tool's result against the call it answers", () => {
    const stream = new AguiStream("run-1");
    const first = stream.take({ kind: "tool", name: "lookup", args: {} })[0]?.toolCallId;
    const second = stream.take({ kind: "tool", name: "search", args: {} })[0]?.toolCallId;
    // The results come back in the other order, as parallel calls do.
    const searched = stream.take({ kind: "tool result", name: "search", failed: true })[0];
    const looked = stream.take({ kind: "tool result", name: "lookup", failed: false })[0];

    expect(searched).toMatchObject({ type: "TOOL_CALL_RESULT", toolCallId: second, role: "tool", content: "failed" });
    expect(looked).toMatchObject({ type: "TOOL_CALL_RESULT", toolCallId: first, content: "completed" });
    // `messageId` and `content` are required by the standard.
    expect(typeof searched?.messageId).toBe("string");
    expect(searched?.messageId).not.toBe(looked?.messageId);
  });

  it("sends a note as an activity with the four fields an activity has", () => {
    const stream = new AguiStream("run-1");
    const [note] = stream.take({ kind: "note", text: "the cache was cold" });
    expect(note).toMatchObject({
      type: "ACTIVITY_SNAPSHOT",
      activityType: "note",
      content: { text: "the cache was cold" },
      replace: true,
    });
    expect(typeof note?.messageId).toBe("string");
  });

  it("reports a refused call as an activity, because the run goes on after it", () => {
    // RUN_ERROR is the last event of a run. A refusal is not the end of one: the model
    // is told why and carries on.
    const stream = new AguiStream("run-1");
    const [refused] = stream.take({ kind: "refused", name: "wipe", why: "not allowed" });
    expect(refused).toMatchObject({
      type: "ACTIVITY_SNAPSHOT",
      activityType: "refused",
      content: { name: "wipe", why: "not allowed" },
    });
    expect(types(stream.take({ kind: "text", text: "I cannot do that" }))).toContain("TEXT_MESSAGE_CONTENT");
  });
});

describe("modes", () => {
  it("puts every praecise event in exactly one mode", () => {
    // A kind with no mode would silently never stream.
    const kinds: Progress["kind"][] = [
      "routing", "answering", "text", "checking", "checked",
      "climbing", "tool", "tool result", "refused", "note", "self", "done", "failed",
    ];
    for (const kind of kinds) {
      expect(ALL_MODES).toContain(modeOf({ kind } as Progress));
    }
  });

  it("filters to what was asked for", () => {
    const stream = new AguiStream("run-1", ["messages"]);
    expect(types(stream.take({ kind: "text", text: "hi" }))).toEqual([
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
    ]);
    // A tool call is not a message, so it does not appear.
    expect(types(stream.take({ kind: "tool", name: "x", args: {} }))).toEqual(["TEXT_MESSAGE_END"]);
  });

  it("still closes the message across an event it filtered out", () => {
    // The subtle one. If the boundary were computed only from events that survived the
    // filter, a bubble would stay open across the tool call the caller chose not to see.
    const stream = new AguiStream("run-1", ["messages"]);
    stream.take({ kind: "text", text: "before" });
    const hidden = stream.take({ kind: "tool", name: "x", args: {} });
    expect(types(hidden)).toEqual(["TEXT_MESSAGE_END"]);
  });

  it("reads a selector, and falls back to everything", () => {
    expect(modesFrom("messages,tools")).toEqual(["messages", "tools"]);
    expect(modesFrom(null)).toEqual(ALL_MODES);
    // Nonsense is not silently an empty stream.
    expect(modesFrom("nonsense")).toEqual(ALL_MODES);
  });
});

/** A run as the store would hand it back, stopped at a gate unless told otherwise. */
const runAt = (over: Partial<Run> = {}): Run => ({
  id: "ship-abc",
  workflow: "ship",
  status: "waiting",
  input: {},
  outputs: {},
  plans: {},
  usage: { inputTokens: 0, outputTokens: 0 },
  waitingFor: { step: "gate", prompt: "Ship the release?" },
  events: [],
  startedAt: 1,
  updatedAt: 1,
  ...over,
});

describe("a workflow run that stops for a person", () => {
  it("describes the gate as an interrupt: which run and step, what is asked, and what answers it", () => {
    const interrupt = interruptOf(runAt())!;
    expect(interrupt.id).toBe("ship-abc:gate");
    expect(interrupt.reason).toBe("approval");
    expect(interrupt.message).toBe("Ship the release?");
    expect(interrupt.responseSchema).toMatchObject({
      type: "object",
      required: ["approved"],
      properties: { approved: { type: "boolean" }, note: { type: "string" } },
    });
    expect(interrupt.metadata).toEqual({ runId: "ship-abc", workflow: "ship", step: "gate" });
  });

  it("says how many must agree when the gate takes more than one", () => {
    const two = runAt({ waitingFor: { step: "gate", prompt: "Both?", requires: { quorum: 2 } } });
    expect(interruptOf(two)?.metadata).toMatchObject({ quorum: 2 });
  });

  it("reports no interrupt for a run that is not waiting", () => {
    expect(interruptOf(runAt({ status: "done", waitingFor: undefined }))).toBeUndefined();
    expect(interruptOf(runAt({ status: "running" }))).toBeUndefined();
  });

  it("ends the stream with RUN_FINISHED carrying the interrupt, and nothing after it", () => {
    const stream = new AguiStream("ship-abc", ALL_MODES, "thread-1");
    const ending = stream.settle(runAt());
    expect(types(ending)).toEqual(["RUN_FINISHED"]);
    expect(ending[0]).toMatchObject({
      threadId: "thread-1",
      runId: "ship-abc",
      outcome: { type: "interrupt", interrupts: [{ id: "ship-abc:gate", reason: "approval" }] },
    });
    // A paused run has no result, and a client must not be shown one.
    expect(ending[0]).not.toHaveProperty("result");
    expect(stream.finish()).toEqual([]);
    expect(stream.step({ step: "after", at: 1, kind: "done" })).toEqual([]);
  });

  it("ends a finished run with success and what it produced", () => {
    const stream = new AguiStream("ship-abc");
    const ending = stream.settle(runAt({ status: "done", waitingFor: undefined, result: "shipped" }));
    expect(ending[0]).toMatchObject({ type: "RUN_FINISHED", outcome: { type: "success" }, result: "shipped" });
  });

  it("ends a failed run with RUN_ERROR, never with a finish", () => {
    const stream = new AguiStream("ship-abc");
    const ending = stream.settle(runAt({ status: "failed", waitingFor: undefined, error: "the provider was down" }));
    expect(types(ending)).toEqual(["RUN_ERROR"]);
    expect(ending[0]?.message).toBe("the provider was down");
  });

  it("reports a finished step as a step, and the rest of the record under its own name", () => {
    const stream = new AguiStream("ship-abc");
    const done = stream.step({ step: "draft", at: 1, kind: "done" });
    expect(types(done)).toEqual(["STEP_STARTED", "STEP_FINISHED"]);
    expect(done[0]?.stepName).toBe("draft");

    const waiting = stream.step({ step: "gate", at: 2, kind: "waiting", detail: "Ship the release?" });
    expect(waiting[0]).toMatchObject({ type: "CUSTOM", name: "waiting", value: { step: "gate" } });
    // Steps are how the run got there, so a caller who asked only for the lifecycle is spared them.
    expect(new AguiStream("ship-abc", ["values"]).step({ step: "draft", at: 1, kind: "done" })).toEqual([]);
  });
});

describe("answering an interrupt", () => {
  const holding = (...runs: Run[]) => ({
    load: async (id: string) => runs.find((run) => run.id === id),
  });
  const resume = (over: Record<string, unknown> = {}) => [
    { interruptId: "ship-abc:gate", status: "resolved", payload: { approved: true, note: "go" }, ...over },
  ];

  it("hands a resolved interrupt's payload on as the answer, unchanged", async () => {
    const run = runAt();
    expect(await answerInterrupts(holding(run), "ship", resume())).toEqual({
      run,
      answer: { approved: true, note: "go" },
    });
  });

  it("does not read a resolved interrupt as approval unless it says so", async () => {
    const answered = await answerInterrupts(holding(runAt()), "ship", resume({ payload: { note: "looks fine" } }));
    // No `approved` is invented; the approval path refuses an answer without one.
    expect(answered).toMatchObject({ answer: { note: "looks fine" } });
    expect((answered as { answer: Record<string, unknown> }).answer).not.toHaveProperty("approved");

    expect(await answerInterrupts(holding(runAt()), "ship", resume({ payload: "yes" }))).toContain(
      "a resolved interrupt carries a payload",
    );
    expect(await answerInterrupts(holding(runAt()), "ship", resume({ payload: undefined }))).toContain(
      "a resolved interrupt carries a payload",
    );
  });

  it("turns a cancelled interrupt into a refusal, whatever its payload claims", async () => {
    const bare = await answerInterrupts(holding(runAt()), "ship", resume({ status: "cancelled", payload: undefined }));
    expect(bare).toMatchObject({ answer: { approved: false } });

    const lying = await answerInterrupts(
      holding(runAt()),
      "ship",
      resume({ status: "cancelled", payload: { approved: true, note: "changed my mind", approver: "ada" } }),
    );
    expect(lying).toMatchObject({ answer: { approved: false, note: "changed my mind", approver: "ada" } });
  });

  it("refuses an answer to a gate the run is not waiting at", async () => {
    const stale = "no open interrupt";
    expect(await answerInterrupts(holding(), "ship", resume())).toContain(stale);
    expect(await answerInterrupts(holding(runAt({ status: "done", waitingFor: undefined })), "ship", resume())).toContain(
      stale,
    );
    // The run moved on to a later gate; an answer to the earlier one must not clear it.
    const later = runAt({ waitingFor: { step: "finance", prompt: "Finance?" } });
    expect(await answerInterrupts(holding(later), "ship", resume())).toContain(stale);
    expect(await answerInterrupts(holding(runAt()), "ship", resume({ interruptId: "ship-abc" }))).toContain(stale);
  });

  it("refuses an answer sent to a different workflow than the run's", async () => {
    expect(await answerInterrupts(holding(runAt()), "greet", resume())).toContain('belongs to a run of "ship"');
  });

  it("refuses more than one answer, and anything that is not an answer", async () => {
    const two = [...resume(), ...resume({ interruptId: "other:gate" })];
    expect(await answerInterrupts(holding(runAt()), "ship", two)).toContain("a resume carries one answer");
    for (const odd of [undefined, {}, [], "yes", [null], [{ status: "resolved" }], resume({ status: "approved" })]) {
      expect(await answerInterrupts(holding(runAt()), "ship", odd)).toContain("`resume` must be an array");
    }
  });

  it("finds the run when its id or its step has a colon in it", async () => {
    const odd = runAt({ id: "ship:2026", waitingFor: { step: "each:gate", prompt: "?" } });
    expect(interruptOf(odd)?.id).toBe("ship:2026:each:gate");
    const answered = await answerInterrupts(holding(odd), "ship", resume({ interruptId: "ship:2026:each:gate" }));
    expect(answered).toMatchObject({ run: { id: "ship:2026" } });
  });
});

describe("the wire format", () => {
  it("names the event in the SSE field as well as the body", () => {
    // A browser `EventSource` dispatches on the `event:` field; a client should not have
    // to parse a body to decide which listener to run.
    const frame = sseFrame({ type: "TEXT_MESSAGE_CONTENT", timestamp: 1, delta: "x" });
    expect(frame.startsWith("event: TEXT_MESSAGE_CONTENT\n")).toBe(true);
    expect(frame.endsWith("\n\n")).toBe(true);
    expect(JSON.parse(frame.split("data: ")[1]!.trim()).delta).toBe("x");
  });
});
