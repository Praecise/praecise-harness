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

    expect(types(opened)).toEqual(["TextMessageStart", "TextMessageContent"]);
    // A second fragment does NOT reopen the message.
    expect(types(more)).toEqual(["TextMessageContent"]);
    expect(types(closed)).toContain("TextMessageEnd");
  });

  it("closes a message when a tool call interrupts it, and opens a new one after", () => {
    // An agent that reaches for a tool mid-answer produces text, then a call, then more
    // text. Without boundaries a renderer shows one bubble with a tool call inside it.
    const stream = new AguiStream("run-1");
    stream.take({ kind: "text", text: "Let me check" });
    const during = stream.take({ kind: "tool", name: "lookup", args: { id: 1 } });
    const after = stream.take({ kind: "text", text: "It is here" });

    expect(during[0]?.type).toBe("TextMessageEnd");
    expect(types(during)).toEqual(["TextMessageEnd", "ToolCallStart", "ToolCallArgs", "ToolCallEnd"]);
    expect(after[0]?.type).toBe("TextMessageStart");
    // A new message, not the old one continued.
    expect(after[0]?.messageId).not.toBe(during[0]?.messageId);
  });

  it("sends tool arguments as a string delta, which is the shape AG-UI defines", () => {
    const stream = new AguiStream("run-1");
    const events = stream.take({ kind: "tool", name: "lookup", args: { id: 7 } });
    const args = events.find((event) => event.type === "ToolCallArgs");
    expect(typeof args?.delta).toBe("string");
    expect(JSON.parse(String(args?.delta))).toEqual({ id: 7 });
  });

  it("closes an open message even when the run fails", () => {
    // A renderer left with an open bubble and no closing event shows a spinner that
    // never stops, which is the most common way a correct stream looks broken.
    const stream = new AguiStream("run-1");
    stream.take({ kind: "text", text: "half a th" });
    const ended = stream.finish("error", "upstream died");

    expect(types(ended)).toEqual(["TextMessageEnd", "RunError"]);
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
    expect(types(everything).some((type) => type.startsWith("Reasoning"))).toBe(false);
  });
});

describe("modes", () => {
  it("puts every praecise event in exactly one mode", () => {
    // A kind with no mode would silently never stream.
    const kinds: Progress["kind"][] = [
      "routing", "answering", "text", "checking", "checked",
      "climbing", "tool", "tool result", "refused", "note", "done", "failed",
    ];
    for (const kind of kinds) {
      expect(ALL_MODES).toContain(modeOf({ kind } as Progress));
    }
  });

  it("filters to what was asked for", () => {
    const stream = new AguiStream("run-1", ["messages"]);
    expect(types(stream.take({ kind: "text", text: "hi" }))).toEqual([
      "TextMessageStart",
      "TextMessageContent",
    ]);
    // A tool call is not a message, so it does not appear.
    expect(types(stream.take({ kind: "tool", name: "x", args: {} }))).toEqual(["TextMessageEnd"]);
  });

  it("still closes the message across an event it filtered out", () => {
    // The subtle one. If the boundary were computed only from events that survived the
    // filter, a bubble would stay open across the tool call the caller chose not to see.
    const stream = new AguiStream("run-1", ["messages"]);
    stream.take({ kind: "text", text: "before" });
    const hidden = stream.take({ kind: "tool", name: "x", args: {} });
    expect(types(hidden)).toEqual(["TextMessageEnd"]);
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
    const frame = sseFrame({ type: "TextMessageContent", timestamp: 1, delta: "x" });
    expect(frame.startsWith("event: TextMessageContent\n")).toBe(true);
    expect(frame.endsWith("\n\n")).toBe(true);
    expect(JSON.parse(frame.split("data: ")[1]!.trim()).delta).toBe("x");
  });
});
