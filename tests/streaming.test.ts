/**
 * Reading an answer as it arrives.
 *
 * The three wires stream in three different shapes and have to come out the
 * same, because everything above them is written against one response type and
 * must not be able to tell which endpoint answered.
 */

import { describe, expect, it } from "vitest";

import { chatWire } from "../src/harness/wire/chat.js";
import { contentsWire } from "../src/harness/wire/contents.js";
import { messagesWire } from "../src/harness/wire/messages.js";
import { events } from "../src/harness/wire/sse.js";
import type { ChatRequest, ChatResponse } from "../src/harness/types.js";

/** A response body that hands over the given bytes in the given pieces. */
function body(chunks: string[]): ReadableStream<Uint8Array> {
  const encode = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encode.encode(chunk));
      controller.close();
    },
  });
}

const frames = (lines: string[]) => lines.map((line) => `data: ${line}\n\n`);

function streaming(chunks: string[]): {
  request: (wire: (r: ChatRequest) => Promise<ChatResponse>) => Promise<ChatResponse>;
  pieces: string[];
  sent: Record<string, unknown>;
  urls: string[];
} {
  const pieces: string[] = [];
  const sent: Record<string, unknown> = {};
  const urls: string[] = [];

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input));
    Object.assign(sent, JSON.parse(String(init?.body ?? "{}")));
    return new Response(body(chunks), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;

  const request = (wire: (r: ChatRequest) => Promise<ChatResponse>) =>
    wire({
      model: "m",
      baseUrl: "https://endpoint",
      apiKey: "k",
      system: "be brief",
      messages: [{ role: "user", content: "how long do refunds take?" }],
      effort: 0,
      fetch: fetchImpl,
      onText: (text) => pieces.push(text),
    });

  return { request, pieces, sent, urls };
}

describe("reading a stream of events", () => {
  it("keeps a line together when the network splits it in half", async () => {
    const seen: unknown[] = [];
    for await (const frame of events(body(['data: {"a"', ': 1}\n\ndata: {"a": 2}\n\n']))) {
      seen.push(frame);
    }
    expect(seen).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("keeps a character together when the split lands inside one", async () => {
    const whole = new TextEncoder().encode('data: {"a": "é"}\n\n');
    const split = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(whole.slice(0, 12));
        controller.enqueue(whole.slice(12));
        controller.close();
      },
    });
    const seen: unknown[] = [];
    for await (const frame of events(split)) seen.push(frame);
    expect(seen).toEqual([{ a: "é" }]);
  });

  it("passes over comments, terminators and anything that is not JSON", async () => {
    const seen: unknown[] = [];
    for await (const frame of events(body([": keep-alive\n", "data: not json\n\n", "data: [DONE]\n\n", 'data: {"a": 1}\n\n']))) {
      seen.push(frame);
    }
    expect(seen).toEqual([{ a: 1 }]);
  });

  it("yields nothing at all for a response with no body", async () => {
    const seen: unknown[] = [];
    for await (const frame of events(null)) seen.push(frame);
    expect(seen).toEqual([]);
  });
});

describe("streaming the messages wire", () => {
  const stream = () =>
    streaming(
      frames([
        '{"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":4}}}',
        '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Refunds "}}',
        '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"take five days."}}',
        '{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":6}}',
      ]),
    );

  it("hands over each fragment and the whole answer too", async () => {
    const { request, pieces } = stream();
    const reply = await request(messagesWire);

    expect(pieces).toEqual(["Refunds ", "take five days."]);
    expect(reply.text).toBe("Refunds take five days.");
    expect(reply.finishReason).toBe("end_turn");
  });

  it("accounts for the request the same as an unstreamed one", async () => {
    const reply = await stream().request(messagesWire);
    expect(reply.usage).toEqual({ inputTokens: 10, outputTokens: 6, cachedTokens: 4 });
  });

  it("asks to stream only because somebody is listening", async () => {
    const { request, sent } = stream();
    await request(messagesWire);
    expect(sent.stream).toBe(true);
  });

  it("puts tool arguments back together from their fragments", async () => {
    const { request } = streaming(
      frames([
        '{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"refund"}}',
        '{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"order\\":"}}',
        '{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"a-1\\"}"}}',
        '{"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
      ]),
    );
    const reply = await request(messagesWire);
    expect(reply.toolCalls).toEqual([{ id: "t1", name: "refund", args: { order: "a-1" } }]);
  });

  it("hands a tool an empty object rather than half an argument", async () => {
    const { request } = streaming(
      frames([
        '{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"refund"}}',
        '{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"order\\":"}}',
      ]),
    );
    expect((await request(messagesWire)).toolCalls).toEqual([
      { id: "t1", name: "refund", args: {} },
    ]);
  });
});

describe("streaming the chat wire", () => {
  const stream = () =>
    streaming(
      frames([
        '{"choices":[{"delta":{"content":"Refunds "}}]}',
        '{"choices":[{"delta":{"content":"take five days."},"finish_reason":"stop"}]}',
        '{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":6,"prompt_tokens_details":{"cached_tokens":4}}}',
      ]),
    );

  it("hands over each fragment and the whole answer too", async () => {
    const { request, pieces } = stream();
    const reply = await request(chatWire);

    expect(pieces).toEqual(["Refunds ", "take five days."]);
    expect(reply.text).toBe("Refunds take five days.");
    expect(reply.finishReason).toBe("stop");
  });

  it("asks for the accounting, which a stream leaves out unless told", async () => {
    const { request, sent } = stream();
    const reply = await request(chatWire);

    expect(sent.stream_options).toEqual({ include_usage: true });
    expect(reply.usage).toEqual({ inputTokens: 10, outputTokens: 6, cachedTokens: 4 });
  });

  it("puts tool arguments back together from their fragments", async () => {
    const { request } = streaming(
      frames([
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"refund","arguments":"{\\"order\\":"}}]}}]}',
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a-1\\"}"}}]},"finish_reason":"tool_calls"}]}',
      ]),
    );
    const reply = await request(chatWire);
    expect(reply.toolCalls).toEqual([{ id: "t1", name: "refund", args: { order: "a-1" } }]);
  });
});

describe("streaming the contents wire", () => {
  const stream = () =>
    streaming(
      frames([
        '{"candidates":[{"content":{"parts":[{"text":"Refunds "}]}}]}',
        '{"candidates":[{"content":{"parts":[{"text":"take five days."}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":6,"cachedContentTokenCount":4}}',
      ]),
    );

  it("hands over each fragment and the whole answer too", async () => {
    const { request, pieces } = stream();
    const reply = await request(contentsWire);

    expect(pieces).toEqual(["Refunds ", "take five days."]);
    expect(reply.text).toBe("Refunds take five days.");
    expect(reply.finishReason).toBe("STOP");
    expect(reply.usage).toEqual({ inputTokens: 10, outputTokens: 6, cachedTokens: 4 });
  });

  it("streams from a different method rather than from a flag", async () => {
    const { request, urls } = stream();
    await request(contentsWire);
    expect(urls[0]).toContain(":streamGenerateContent?alt=sse&key=k");
  });
});

describe("not streaming", () => {
  it("asks for nothing of the sort when nobody is listening", async () => {
    const sent: Record<string, unknown> = {};
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input));
      Object.assign(sent, JSON.parse(String(init?.body ?? "{}")));
      return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const reply = await messagesWire({
      model: "m",
      baseUrl: "https://endpoint",
      apiKey: "k",
      system: "",
      messages: [{ role: "user", content: "hi" }],
      effort: 0,
      fetch: fetchImpl,
    });

    expect(sent.stream).toBeUndefined();
    expect(reply.text).toBe("ok");
  });
});
