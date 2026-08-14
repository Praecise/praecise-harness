/**
 * The "interactions" shape — Google's primary Gemini surface — and the traps that come
 * from it looking like `generateContent` with different spelling.
 *
 * Every case here is one that fails SILENTLY on the wire: a dropped system prompt, a
 * sampling knob that was never honoured, thought tokens nobody counted, an answer read
 * out of a field that happened to be absent. No test touches a network; the endpoint is a
 * fake `fetch` that captures the outbound body.
 */
import { describe, expect, test, vi } from "vitest";

import {
  acceptsMinimalThinking,
  interactionsWire,
  outputTokensOf,
  textOf,
  thinkingLevelFor,
  toInput,
  toolCallsOf,
  urlFor,
  type InteractionsResponse,
} from "../src/harness/wire/interactions.js";
import { adapterFor, knownWires } from "../src/harness/wire/index.js";
import type { ChatRequest } from "../src/harness/types.js";

/** Capture the outbound request without a network. */
function capture(payload: unknown, status = 200) {
  const sent: { url?: string; headers?: Record<string, string>; body?: Record<string, unknown> } = {};
  const fetchImpl = (async (url: string, init: RequestInit) => {
    sent.url = url;
    sent.headers = init.headers as Record<string, string>;
    sent.body = JSON.parse(String(init.body)) as Record<string, unknown>;
    return new Response(JSON.stringify(payload), { status });
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

/** An SSE body, chunked the way a network would not be kind enough to chunk it. */
function streamOf(frames: string[]) {
  const encode = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encode.encode(`data: ${frame}\n\n`));
      controller.close();
    },
  });
  const sent: { body?: Record<string, unknown> } = {};
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    sent.body = JSON.parse(String(init.body)) as Record<string, unknown>;
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

const base = (over: Partial<ChatRequest> = {}): ChatRequest =>
  ({
    model: "gemini-flash-latest",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKey: "k",
    messages: [{ role: "user", content: "hello" }],
    effort: 0.5,
    fetch,
    ...over,
  }) as ChatRequest;

const answered = {
  output_text: "hi",
  steps: [{ type: "model_output", content: [{ type: "text", text: "hi" }] }],
  usage: { total_input_tokens: 10, total_output_tokens: 2, total_tokens: 12 },
  status: "completed",
};

describe("the interactions shape", () => {
  test("registers under its own name without displacing generateContent", () => {
    // The older surface still works and still serves the current model. This one is where
    // new capability lands — both are reachable, and `speaks` says which is meant.
    expect(knownWires()).toContain("interactions");
    expect(knownWires()).toContain("contents");
    expect(adapterFor("interactions")).toBe(interactionsWire);
  });

  test("no sampling knob is ever sent — and the caller is told it was dropped", async () => {
    const { sent, fetchImpl } = capture(answered);
    // `ChatRequest` has no temperature field, which is why this has to be forced: an app
    // can still hand one over, and the old behaviour would have been silence.
    const carried = base({ fetch: fetchImpl }) as ChatRequest & Record<string, unknown>;
    carried.temperature = 0;
    carried.top_p = 0.9;

    const out = (await interactionsWire(carried)) as InteractionsResponse;

    const whole = JSON.stringify(sent.body);
    expect(whole).not.toContain("temperature");
    expect(whole).not.toContain("top_p");
    expect(whole).not.toContain("top_k");
    // Not "sent as zero" either — a substituted assumption is worse than a refused one.
    expect((sent.body?.generation_config as Record<string, unknown> | undefined)?.temperature).toBeUndefined();

    expect(out.notes?.length).toBe(2);
    expect(out.notes?.[0]).toContain("temperature");
    expect(out.notes?.[1]).toContain("top_p");
  });

  test("a request carrying no knobs carries no notes either", async () => {
    const { fetchImpl } = capture(answered);
    const out = (await interactionsWire(base({ fetch: fetchImpl }))) as InteractionsResponse;
    expect(out.notes).toBeUndefined();
  });

  test("the system instruction is a plain string at the top level, not a Content object", async () => {
    const { sent, fetchImpl } = capture(answered);
    await interactionsWire(base({ fetch: fetchImpl, system: "be brief" }));

    expect(sent.body?.system_instruction).toBe("be brief");
    // The sibling wire's shape. Sending it here loses the instruction silently.
    expect(sent.body?.systemInstruction).toBeUndefined();
    expect(JSON.stringify(sent.body?.system_instruction)).not.toContain("parts");
    // And it is not smuggled into the conversation as a turn.
    expect(JSON.stringify(sent.body?.input)).not.toContain("be brief");
  });

  test("text is recovered from steps[] when the convenience field is absent", () => {
    // `output_text` is a real field HERE and an SDK-only invention on the `responses`
    // shape. A reader that depends on it reports an empty answer from a good response.
    const walked = textOf({
      steps: [
        { type: "thought", content: [{ type: "text", text: "not the answer" }] },
        { type: "model_output", content: [{ type: "text", text: "the " }, { type: "text", text: "answer" }] },
      ],
    });
    expect(walked).toBe("the answer");
  });

  test("the convenience field is used when the endpoint does send one", () => {
    expect(textOf({ output_text: "hi", steps: [] })).toBe("hi");
  });

  test("a whole reply arrives even with no output_text on the wire", async () => {
    const { fetchImpl } = capture({
      steps: [{ type: "model_output", content: [{ type: "text", text: "walked out" }] }],
      usage: { total_input_tokens: 3, total_output_tokens: 4, total_tokens: 7 },
    });
    const out = await interactionsWire(base({ fetch: fetchImpl }));
    expect(out.text).toBe("walked out");
  });

  test("thought tokens are counted as output and surfaced on their own", async () => {
    const { fetchImpl } = capture({
      output_text: "42",
      usage: {
        total_input_tokens: 100,
        total_output_tokens: 8,
        total_thought_tokens: 900,
        total_cached_tokens: 60,
        total_tool_use_tokens: 12,
        total_tokens: 1020,
      },
    });
    const out = (await interactionsWire(base({ fetch: fetchImpl }))) as InteractionsResponse;

    // Reading only the visible answer would report 8 for a request that cost 908.
    expect(out.usage).toEqual({ inputTokens: 100, outputTokens: 908, cachedTokens: 60 });
    expect(out.thoughtTokens).toBe(900);
    expect(out.toolUseTokens).toBe(12);
  });

  test("thoughts already inside the output total are not billed twice", () => {
    // Undocumented either way, so the reported total arbitrates.
    expect(outputTokensOf({ total_input_tokens: 10, total_output_tokens: 100, total_thought_tokens: 90, total_tokens: 110 })).toBe(100);
    expect(outputTokensOf({ total_input_tokens: 10, total_output_tokens: 10, total_thought_tokens: 90, total_tokens: 110 })).toBe(100);
    expect(outputTokensOf(undefined)).toBe(0);
  });

  test("a schema goes as the response_format OBJECT, never as a bare mime type", async () => {
    const { sent, fetchImpl } = capture(answered);
    const schema = { type: "object", properties: { grade: { type: "string", enum: ["a", "b"] } } };
    await interactionsWire(base({ fetch: fetchImpl, schema, json: true }));

    expect(sent.body?.response_format).toEqual({
      type: "text",
      mime_type: "application/json",
      schema,
    });
    // Two flat keys are the sibling wire's spelling; here they would do nothing.
    expect(sent.body?.responseSchema).toBeUndefined();
    expect((sent.body?.generation_config as Record<string, unknown> | undefined)?.responseSchema).toBeUndefined();
    // `text/x.enum` is unconfirmed on this surface, so an enum lives in the schema.
    expect(JSON.stringify(sent.body)).not.toContain("text/x.enum");
  });

  test("json without a schema sends the hint the vendor says it is, and nothing more", async () => {
    const { sent, fetchImpl } = capture(answered);
    await interactionsWire(base({ fetch: fetchImpl, json: true }));
    expect(sent.body?.response_format).toEqual({ type: "text", mime_type: "application/json" });
  });

  test("minimal thinking is gated per model rather than stripped for everyone", () => {
    // The current flash model errors on `minimal`; its own default is `medium`, so
    // omitting the field does not mean "do not think".
    expect(acceptsMinimalThinking("gemini-flash-latest")).toBe(false);
    expect(thinkingLevelFor(0, "gemini-flash-latest")).toBe("low");
    expect(thinkingLevelFor(0, "gemini-pro-latest")).toBe("minimal");
    expect(thinkingLevelFor(0.5, "gemini-flash-latest")).toBe("medium");
    expect(thinkingLevelFor(1, "gemini-flash-latest")).toBe("high");
  });

  test("depth is a level here, in snake_case, and summaries are not paid for", async () => {
    const { sent, fetchImpl } = capture(answered);
    // A rung declaring the older token-budget form still gets the level form: the budget
    // field is gone from this surface.
    await interactionsWire(base({ fetch: fetchImpl, depth: "budget", effort: 0.9 }));
    expect(sent.body?.generation_config).toEqual({ thinking_level: "high", thinking_summaries: "none" });
    expect(JSON.stringify(sent.body)).not.toContain("thinkingBudget");
  });

  test("depth: none asks for nothing rather than asking for zero", async () => {
    const { sent, fetchImpl } = capture(answered);
    await interactionsWire(base({ fetch: fetchImpl, depth: "none", maxTokens: 64 }));
    expect(sent.body?.generation_config).toEqual({ max_output_tokens: 64 });
  });

  test("the versioned root an app already configured is not versioned twice", () => {
    // `/v1beta/v1beta/interactions` is a 404 that reads like the surface not existing.
    expect(urlFor("https://generativelanguage.googleapis.com/v1beta")).toBe(
      "https://generativelanguage.googleapis.com/v1beta/interactions",
    );
    expect(urlFor("https://generativelanguage.googleapis.com/v1beta/")).toBe(
      "https://generativelanguage.googleapis.com/v1beta/interactions",
    );
    expect(urlFor("https://proxy.example.com")).toBe("https://proxy.example.com/v1beta/interactions");
  });

  test("the key travels in a header, not in the query string", async () => {
    const { sent, fetchImpl } = capture(answered);
    await interactionsWire(base({ fetch: fetchImpl }));
    expect(sent.headers?.["x-goog-api-key"]).toBe("k");
    expect(sent.url).not.toContain("key=");
    expect(sent.body?.store).toBe(false);
    expect(sent.body?.background).toBeUndefined();
  });

  test("a conversation becomes typed content and steps, never role/parts", async () => {
    const { sent, fetchImpl } = capture(answered);
    await interactionsWire(
      base({
        fetch: fetchImpl,
        messages: [
          { role: "user", content: "refund me" },
          { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "refund", args: { amount: 5 } }] },
          { role: "tool", toolCallId: "c1", name: "refund", content: "done" },
          { role: "assistant", content: "refunded" },
          { role: "user", content: "thanks" },
        ],
      }),
    );

    expect(sent.body?.input).toEqual([
      { type: "text", text: "refund me" },
      { type: "function_call", id: "c1", name: "refund", arguments: { amount: 5 } },
      { type: "function_result", call_id: "c1", result: "done" },
      { type: "model_output", content: [{ type: "text", text: "refunded" }] },
      { type: "text", text: "thanks" },
    ]);
    // No `contents`, no `role`, no `parts` — this surface has none of them.
    expect(sent.body?.contents).toBeUndefined();
    expect(JSON.stringify(sent.body?.input)).not.toContain("parts");
    // A tool result is not lied about: nothing here knows whether the tool failed.
    expect(JSON.stringify(sent.body?.input)).not.toContain("is_error");
  });

  test("a single user turn uses only the confirmed content form", () => {
    expect(toInput([{ role: "user", content: "hello" }])).toEqual([{ type: "text", text: "hello" }]);
  });

  test("tools are flat, and a call comes back parsed from either arguments form", async () => {
    const { sent, fetchImpl } = capture({
      steps: [
        { type: "model_output", content: [{ type: "text", text: "" }] },
        { type: "function_call", id: "call_1", name: "refund", arguments: { amount: 5 } },
      ],
    });
    const out = await interactionsWire(
      base({
        fetch: fetchImpl,
        tools: [{ name: "refund", description: "Give it back.", parameters: { type: "object" } }],
      }),
    );

    expect(sent.body?.tools).toEqual([
      { type: "function", name: "refund", description: "Give it back.", parameters: { type: "object" } },
    ]);
    expect(out.toolCalls).toEqual([{ id: "call_1", name: "refund", args: { amount: 5 } }]);

    // The same call, with arguments as a JSON string — unconfirmed which form ships.
    expect(toolCallsOf({ steps: [{ type: "function_call", id: "c", name: "n", arguments: '{"a":1}' }] })).toEqual([
      { id: "c", name: "n", args: { a: 1 } },
    ]);
    // And broken arguments are a refused call rather than a thrown request.
    expect(toolCallsOf({ steps: [{ type: "function_call", id: "c", name: "n", arguments: "{not json" }] })[0]?.args).toEqual({});
  });

  test("a streamed answer accumulates delta.text and asks for the stream in the body", async () => {
    const { sent, fetchImpl } = streamOf([
      '{"index":0,"delta":{"text":"1, 2, ","type":"text"},"event_type":"step.delta"}',
      '{"index":0,"delta":{"text":"thinking out loud","type":"thought"},"event_type":"step.delta"}',
      '{"index":1,"delta":{"text":"3.","type":"text"},"event_type":"step.delta"}',
      '{"event_type":"interaction.completed","interaction":{"status":"completed",' +
        '"usage":{"total_input_tokens":5,"total_output_tokens":4,"total_thought_tokens":40,"total_tokens":49}}}',
    ]);
    const onText = vi.fn();
    const out = (await interactionsWire(base({ fetch: fetchImpl, onText }))) as InteractionsResponse;

    // Streaming is a body flag here, not a different method or a URL suffix.
    expect(sent.body?.stream).toBe(true);
    expect(out.text).toBe("1, 2, 3.");
    // A thought delta is never handed over as answer text: what is shown is not taken back.
    expect(onText.mock.calls.map(([fragment]) => fragment)).toEqual(["1, 2, ", "3."]);
    expect(out.usage).toEqual({ inputTokens: 5, outputTokens: 44, cachedTokens: 0 });
    expect(out.thoughtTokens).toBe(40);
    expect(out.finishReason).toBe("completed");
  });

  test("a stream that calls a tool reports it even without a terminal payload", async () => {
    const { fetchImpl } = streamOf([
      '{"event_type":"step.completed","step":{"type":"function_call","id":"c9","name":"lookup","arguments":{"q":"x"}}}',
      '{"event_type":"interaction.completed","usage":{"total_input_tokens":2,"total_output_tokens":1,"total_tokens":3}}',
    ]);
    const out = await interactionsWire(base({ fetch: fetchImpl, onText: () => {} }));
    expect(out.toolCalls).toEqual([{ id: "c9", name: "lookup", args: { q: "x" } }]);
    expect(out.usage.inputTokens).toBe(2);
  });

  test("a truncated answer says so rather than reporting completed", async () => {
    const { fetchImpl } = capture({
      output_text: "half an",
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    });
    const out = await interactionsWire(base({ fetch: fetchImpl }));
    expect(out.finishReason).toBe("max_output_tokens");
  });

  test("a refused request is a ProviderError naming this wire", async () => {
    const { fetchImpl } = capture({ error: { message: "nope" } }, 400);
    await expect(interactionsWire(base({ fetch: fetchImpl }))).rejects.toThrow(/interactions responded 400/);
  });
});

/**
 * The warning has to reach a person.
 *
 * The wire says out loud that it dropped a sampling knob, which is the right instinct and
 * was, until this test, unobservable: `notes` lived only on the wire's own widened
 * response type, so an author holding the adapter through the registry — which is every
 * author — got the silence the note exists to prevent. `ChatResponse` carries the slot now.
 * This asserts the whole path, not the computation: registry lookup to caller.
 */
describe("a dropped parameter is observable through the registry", () => {
  test("the note survives the plain ChatResponse an author actually holds", async () => {
    const { fetchImpl } = capture({
      candidates: [{ content: { parts: [{ text: "fine" }] } }],
      usage_metadata: { prompt_token_count: 4, candidates_token_count: 2 },
    });

    const request: ChatRequest = {
      model: "gemini-3-pro",
      baseUrl: "https://example.invalid",
      apiKey: "k",
      messages: [{ role: "user", content: "hello" }],
      system: "",
      effort: 0,
      fetch: fetchImpl,
    };
    // Off the type on purpose, because that is where it is in the failure being tested:
    // an app carrying a knob this surface removed, which no compiler was there to catch.
    (request as unknown as Record<string, unknown>).temperature = 0.7;

    // Through the registry, exactly as the harness reaches it — not the direct import.
    const reply = await adapterFor("interactions")(request);

    expect(reply.notes?.length).toBeGreaterThan(0);
    expect(reply.notes?.join(" ")).toContain("temperature");
    // And it says what to do instead, because a warning with no remedy is just noise.
    expect(reply.notes?.join(" ")).toContain("seed");
  });

  test("nothing is said when nothing was dropped", async () => {
    const { fetchImpl } = capture({
      candidates: [{ content: { parts: [{ text: "fine" }] } }],
      usage_metadata: { prompt_token_count: 4, candidates_token_count: 2 },
    });
    const reply = await adapterFor("interactions")({
      model: "gemini-3-pro",
      baseUrl: "https://example.invalid",
      apiKey: "k",
      messages: [{ role: "user", content: "hello" }],
      system: "",
      effort: 0,
      fetch: fetchImpl,
    });
    expect(reply.notes).toBeUndefined();
  });
});
