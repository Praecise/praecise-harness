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

import { ALL_MODES, AguiStream, modeOf, modesFrom, sseFrame, type AguiEvent } from "../src/server/agui.js";
import type { Progress } from "../src/harness/types.js";

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
