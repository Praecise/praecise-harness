/**
 * What every wire now does, checked wire by wire.
 *
 * Four things used to be true of one wire and absent from the rest: a clock on the
 * request, a normalised reason for stopping, the endpoint's own reasoning handed back
 * with tool results, and something other than text travelling with a question. Each is
 * a property of talking to a model at all, so each is asserted here against all five.
 */
import { describe, expect, test } from "vitest";

import { ProviderError, type ChatAdapter, type ChatRequest, type ChatResponse } from "../src/harness/types.js";
import { chatWire } from "../src/harness/wire/chat.js";
import { contentsWire } from "../src/harness/wire/contents.js";
import { levelOf } from "../src/harness/wire/effort.js";
import { retryAfterOf, stopOf } from "../src/harness/wire/http.js";
import { interactionsWire } from "../src/harness/wire/interactions.js";
import { messagesWire } from "../src/harness/wire/messages.js";
import { responsesWire } from "../src/harness/wire/responses.js";

type Body = Record<string, unknown>;

/** Answer every request with one payload, and remember what was sent. */
function answering(payload: unknown, init: ResponseInit = { status: 200 }) {
  const sent: { url: string; body: Body; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (url: string, request: RequestInit) => {
    sent.push({
      url,
      body: JSON.parse(String(request.body)) as Body,
      headers: request.headers as Record<string, string>,
    });
    return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), {
      headers: { "content-type": "application/json" },
      ...init,
    });
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

const base = (over: Partial<ChatRequest> = {}): ChatRequest =>
  ({
    model: "m",
    baseUrl: "https://api.example.com",
    apiKey: "k",
    system: "Be brief.",
    messages: [{ role: "user", content: "hello" }],
    effort: 1,
    depth: "effort",
    ...over,
  }) as ChatRequest;

const WIRES: [string, ChatAdapter][] = [
  ["messages", messagesWire],
  ["chat", chatWire],
  ["responses", responsesWire()],
  ["contents", contentsWire],
  ["interactions", interactionsWire],
];

describe("every wire runs under a clock", () => {
  test.each(WIRES)("%s gives up on an endpoint that accepts the request and never answers", async (_name, wire) => {
    process.env.PRAECISE_WIRE_TOTAL_MS = "30";
    try {
      const hung = ((_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        })) as unknown as typeof fetch;
      const failure = await wire(base({ fetch: hung })).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ProviderError);
      // Status 0 is what a dead endpoint already looks like, so the ladder crosses.
      expect((failure as ProviderError).status).toBe(0);
    } finally {
      delete process.env.PRAECISE_WIRE_TOTAL_MS;
    }
  });

  test.each(WIRES)("%s leaves the caller's own cancellation as a cancellation", async (_name, wire) => {
    const cancel = new AbortController();
    const hung = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as unknown as typeof fetch;
    const pending = wire(base({ fetch: hung, signal: cancel.signal })).catch((error: unknown) => error);
    cancel.abort();
    expect(await pending).not.toBeInstanceOf(ProviderError);
  });

  test.each(WIRES)("%s says how long a busy endpoint asked to be left alone", async (_name, wire) => {
    const { fetchImpl } = answering({ error: "slow down" }, { status: 429, headers: { "retry-after": "3" } });
    const failure = (await wire(base({ fetch: fetchImpl })).catch((error: unknown) => error)) as ProviderError;
    expect(failure.status).toBe(429);
    expect(failure.retryAfter).toBe(3000);
  });
});

describe("how long to wait", () => {
  test("reads seconds, milliseconds and a date", () => {
    expect(retryAfterOf(new Headers({ "retry-after": "2" }))).toBe(2000);
    expect(retryAfterOf(new Headers({ "retry-after-ms": "150", "retry-after": "2" }))).toBe(150);
    const soon = retryAfterOf(new Headers({ "retry-after": new Date(Date.now() + 5000).toUTCString() }));
    expect(soon).toBeGreaterThan(3000);
    expect(retryAfterOf(new Headers())).toBeUndefined();
  });
});

describe("why a reply ended, in one vocabulary", () => {
  test("four spellings of running out of room are one fact", () => {
    for (const said of ["max_tokens", "length", "MAX_TOKENS", "max_output_tokens"]) {
      expect(stopOf(said, false)).toBe("length");
    }
  });

  test("a reply that asked for tools stopped for tools, whatever word came with it", () => {
    expect(stopOf("stop", true)).toBe("tools");
    expect(stopOf(undefined, true)).toBe("tools");
  });

  test("refusals and withheld replies are told apart from answers", () => {
    expect(stopOf("refusal", false)).toBe("refusal");
    expect(stopOf("content_filter", false)).toBe("filter");
    expect(stopOf("SAFETY", false)).toBe("filter");
    expect(stopOf("end_turn", false)).toBe("end");
    expect(stopOf("pause_turn", false)).toBe("paused");
    expect(stopOf("MALFORMED_FUNCTION_CALL", false)).toBe("error");
  });

  test("a chat refusal that finishes as 'stop' is still a refusal", async () => {
    const { fetchImpl } = answering({
      choices: [{ message: { content: null, refusal: "I can't help with that." }, finish_reason: "stop" }],
    });
    expect((await chatWire(base({ fetch: fetchImpl }))).stop).toBe("refusal");
  });

  test("a responses refusal inside a completed reply is still a refusal", async () => {
    const { fetchImpl } = answering({
      status: "completed",
      output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }],
    });
    expect((await responsesWire()(base({ fetch: fetchImpl }))).stop).toBe("refusal");
  });

  test("a truncated answer is told apart from a short one on each wire", async () => {
    const cut: [ChatAdapter, unknown][] = [
      [messagesWire, { content: [{ type: "text", text: "half" }], stop_reason: "max_tokens" }],
      [chatWire, { choices: [{ message: { content: "half" }, finish_reason: "length" }] }],
      [responsesWire(), { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] }],
      [contentsWire, { candidates: [{ content: { parts: [{ text: "half" }] }, finishReason: "MAX_TOKENS" }] }],
      [interactionsWire, { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, steps: [] }],
    ];
    for (const [wire, payload] of cut) {
      expect((await wire(base({ fetch: answering(payload).fetchImpl }))).stop).toBe("length");
    }
  });
});

describe("depth, in the words the endpoint takes", () => {
  test("three words keep the thirds they always had", () => {
    expect([0, 0.2, 0.33, 0.5, 0.66, 1].map((effort) => levelOf(effort))).toEqual([
      "low", "low", "medium", "medium", "high", "high",
    ]);
  });

  test("a provider that declared five words reaches the fifth at full effort", () => {
    const words = ["low", "medium", "high", "xhigh", "max"];
    expect(levelOf(1, words)).toBe("max");
    expect(levelOf(0, words)).toBe("low");
    expect(levelOf(0.5, words)).toBe("high");
  });

  test("the declared words reach the request", async () => {
    const { sent, fetchImpl } = answering({ content: [], stop_reason: "end_turn" });
    await messagesWire(base({ fetch: fetchImpl, levels: ["low", "medium", "high", "xhigh"] }));
    expect(sent[0]!.body.output_config).toMatchObject({ effort: "xhigh" });
  });
});

describe("the messages wire keeps what is worth keeping", () => {
  const reply = { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" };

  test("the stable part of the instructions is marked, and what follows it is not", async () => {
    const { sent, fetchImpl } = answering(reply);
    const system = "Stable instructions.\n\nRecalled this morning.";
    await messagesWire(base({ fetch: fetchImpl, system, stable: "Stable instructions.".length }));
    expect(sent[0]!.body.system).toEqual([
      { type: "text", text: "Stable instructions.", cache_control: { type: "ephemeral" } },
      { type: "text", text: "Recalled this morning." },
    ]);
  });

  test("a tool loop marks the end of the conversation so far", async () => {
    const { sent, fetchImpl } = answering(reply);
    await messagesWire(
      base({
        fetch: fetchImpl,
        messages: [
          { role: "user", content: "look it up" },
          { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "find", args: {} }] },
          { role: "tool", toolCallId: "t1", name: "find", content: "found" },
        ],
      }),
    );
    const messages = sent[0]!.body.messages as { content: Body[] }[];
    expect(messages.at(-1)!.content.at(-1)).toMatchObject({ cache_control: { type: "ephemeral" } });
    // A single opening turn has nothing behind it to keep.
    const single = answering(reply);
    await messagesWire(base({ fetch: single.fetchImpl }));
    expect(JSON.stringify(single.sent[0]!.body.messages)).not.toContain("cache_control");
  });

  test("a provider that said not to gets a plain string and no markers", async () => {
    const { sent, fetchImpl } = answering(reply);
    await messagesWire(base({ fetch: fetchImpl, cache: false }));
    expect(sent[0]!.body.system).toBe("Be brief.");
  });

  test("what was read from and written to the kept prefix counts as input", async () => {
    const { fetchImpl } = answering({
      ...reply,
      usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
    });
    const answer = await messagesWire(base({ fetch: fetchImpl }));
    expect(answer.usage).toEqual({ inputTokens: 125, outputTokens: 2, cachedTokens: 100, cacheWriteTokens: 20 });
  });

  test("a thinking request is given room for the thought and the answer", async () => {
    const { sent, fetchImpl } = answering(reply);
    await messagesWire(base({ fetch: fetchImpl }));
    expect(sent[0]!.body.max_tokens).toBeGreaterThan(4096);
    const plain = answering(reply);
    await messagesWire(base({ fetch: plain.fetchImpl, depth: "none" }));
    expect(plain.sent[0]!.body.max_tokens).toBe(4096);
  });
});

describe("an endpoint's reasoning goes back with the tool results", () => {
  const turn = (answer: ChatResponse): ChatRequest["messages"] => [
    { role: "user", content: "look it up" },
    { role: "assistant", content: answer.text, toolCalls: answer.toolCalls, replay: answer.replay },
    { role: "tool", toolCallId: answer.toolCalls[0]!.id, name: "find", content: "found" },
  ];

  test("messages: signed thinking blocks are returned first and untouched", async () => {
    const thinking = { type: "thinking", thinking: "I should look.", signature: "sig-1" };
    const first = answering({
      content: [thinking, { type: "tool_use", id: "t1", name: "find", input: {} }],
      stop_reason: "tool_use",
    });
    const answer = await messagesWire(base({ fetch: first.fetchImpl }));
    expect(answer.replay).toEqual([thinking]);

    const second = answering({ content: [{ type: "text", text: "done" }], stop_reason: "end_turn" });
    await messagesWire(base({ fetch: second.fetchImpl, messages: turn(answer) }));
    const assistant = (second.sent[0]!.body.messages as { role: string; content: Body[] }[])[1]!;
    expect(assistant.content[0]).toEqual(thinking);
    expect(assistant.content[1]).toMatchObject({ type: "tool_use", id: "t1" });
  });

  test("messages: a streamed thinking block is rebuilt with its signature", async () => {
    const frames = [
      '{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
      '{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Look "}}',
      '{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"first."}}',
      '{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-2"}}',
      '{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"find"}}',
      '{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{}"}}',
      '{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}',
    ];
    const { fetchImpl } = answering(frames.map((frame) => `data: ${frame}\n\n`).join(""), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const answer = await messagesWire(base({ fetch: fetchImpl, onText: () => {} }));
    expect(answer.replay).toEqual([{ type: "thinking", thinking: "Look first.", signature: "sig-2" }]);
    expect(answer.toolCalls[0]).toMatchObject({ id: "t1", name: "find" });
  });

  test("responses: a turn whose reasoning carries its content is replayed as the endpoint wrote it", async () => {
    const output = [
      { type: "reasoning", id: "rs_1", encrypted_content: "opaque" },
      { type: "function_call", id: "fc_1", call_id: "call_1", name: "find", arguments: "{}" },
    ];
    const first = answering({ status: "completed", output });
    const answer = await responsesWire()(base({ fetch: first.fetchImpl }));
    expect(answer.replay).toEqual(output);

    const second = answering({ status: "completed", output: [] });
    await responsesWire()(base({ fetch: second.fetchImpl, messages: turn(answer) }));
    const input = second.sent[0]!.body.input as Body[];
    expect(input.slice(2, 4)).toEqual(output);
    expect(input.at(-1)).toMatchObject({ type: "function_call_output", call_id: "call_1" });
  });

  test("responses: reasoning that is only an id is not replayed, because nothing may be holding it", async () => {
    const { fetchImpl } = answering({
      status: "completed",
      output: [
        { type: "reasoning", id: "rs_1" },
        { type: "function_call", id: "fc_1", call_id: "call_1", name: "find", arguments: "{}" },
      ],
    });
    expect((await responsesWire()(base({ fetch: fetchImpl }))).replay).toBeUndefined();
  });

  test("chat: reasoning goes back under the name it arrived in", async () => {
    for (const field of ["reasoning_content", "reasoning"]) {
      const first = answering({
        choices: [
          {
            message: {
              content: "",
              [field]: "thinking it over",
              tool_calls: [{ id: "c1", function: { name: "find", arguments: "{}" } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      });
      const answer = await chatWire(base({ fetch: first.fetchImpl }));
      const second = answering({ choices: [{ message: { content: "done" }, finish_reason: "stop" }] });
      await chatWire(base({ fetch: second.fetchImpl, messages: turn(answer) }));
      const assistant = (second.sent[0]!.body.messages as Body[]).find((message) => message.role === "assistant")!;
      expect(assistant[field]).toBe("thinking it over");
    }
  });

  test("interactions: thought steps are resent before the call they led to", async () => {
    const thought = { type: "thought", signature: "sig-3", summary: [] };
    const first = answering({
      status: "requires_action",
      steps: [thought, { type: "function_call", id: "f1", name: "find", arguments: {} }],
    });
    const answer = await interactionsWire(base({ fetch: first.fetchImpl }));
    expect(answer.replay).toEqual([thought]);

    const second = answering({ status: "completed", steps: [] });
    await interactionsWire(base({ fetch: second.fetchImpl, messages: turn(answer) }));
    const input = second.sent[0]!.body.input as Body[];
    expect(input[1]).toEqual(thought);
    expect(input[2]).toMatchObject({ type: "function_call", name: "find" });
  });
});

describe("a question can carry more than text", () => {
  const image = { mime: "image/png", data: "aGVsbG8=" };
  const pdf = { mime: "application/pdf", url: "https://example.com/a.pdf", name: "a.pdf" };
  const asking = (wire: ChatAdapter, payload: unknown) => {
    const { sent, fetchImpl } = answering(payload);
    return wire(
      base({ fetch: fetchImpl, messages: [{ role: "user", content: "what is this?", attachments: [image, pdf] }] }),
    ).then(() => sent[0]!.body);
  };

  test("messages: an image block and a document block, before the question", async () => {
    const body = await asking(messagesWire, { content: [], stop_reason: "end_turn" });
    const content = (body.messages as { content: Body[] }[])[0]!.content;
    expect(content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } });
    expect(content[1]).toMatchObject({ type: "document", source: { type: "url", url: pdf.url }, title: "a.pdf" });
    expect(content[2]).toEqual({ type: "text", text: "what is this?" });
  });

  test("chat: an image_url part and a file part", async () => {
    const body = await asking(chatWire, { choices: [{ message: { content: "x" }, finish_reason: "stop" }] });
    const content = (body.messages as { role: string; content: Body[] }[]).find((m) => m.role === "user")!.content;
    expect(content).toContainEqual({ type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } });
    expect(content.some((part) => part.type === "file")).toBe(true);
  });

  test("responses: input_image and input_file parts", async () => {
    const body = await asking(responsesWire(), { status: "completed", output: [] });
    const user = (body.input as { role?: string; content?: Body[] }[]).find((item) => item.role === "user")!;
    expect(user.content).toContainEqual({ type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" });
    expect(user.content).toContainEqual({ type: "input_file", file_url: pdf.url });
  });

  test("contents: inlineData and fileData parts", async () => {
    const body = await asking(contentsWire, { candidates: [{ content: { parts: [{ text: "x" }] } }] });
    const parts = (body.contents as { parts: Body[] }[])[0]!.parts;
    expect(parts).toContainEqual({ inlineData: { mimeType: "image/png", data: "aGVsbG8=" } });
    expect(parts).toContainEqual({ fileData: { mimeType: "application/pdf", fileUri: pdf.url } });
  });

  test("interactions: typed content by kind", async () => {
    const body = await asking(interactionsWire, { status: "completed", steps: [] });
    const input = body.input as Body[];
    expect(input).toContainEqual({ type: "image", data: "aGVsbG8=", mime_type: "image/png" });
    expect(input).toContainEqual({ type: "document", uri: pdf.url, mime_type: "application/pdf" });
  });
});
