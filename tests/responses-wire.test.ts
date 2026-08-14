/**
 * The "responses" shape, and the four ways a client that assumes it is renamed
 * chat-completions gets it wrong — each of which fails SILENTLY rather than erroring,
 * which is why each has a test.
 */
import { describe, expect, test } from "vitest";
import { responsesWire, textOf, toolCallsOf } from "../src/harness/wire/responses.js";
import type { ChatRequest } from "../src/harness/types.js";

/** Capture the outbound body without a network. */
function capture(payload: unknown) {
  const sent: { url?: string; body?: Record<string, unknown> } = {};
  const fetchImpl = (async (url: string, init: RequestInit) => {
    sent.url = url;
    sent.body = JSON.parse(String(init.body)) as Record<string, unknown>;
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

const base = (over: Partial<ChatRequest> = {}): ChatRequest =>
  ({
    model: "m",
    baseUrl: "https://api.example.com",
    apiKey: "k",
    messages: [{ role: "user", content: "hello" }],
    effort: 0.5,
    fetch: fetch,
    ...over,
  }) as ChatRequest;

const answered = {
  output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] }],
  usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 4 } },
  status: "completed",
};

describe("the responses shape", () => {
  test("text is walked out of the items, never indexed — reasoning shares the array", () => {
    // The real trap: a reasoning item sits at output[0], so output[0].content[0].text
    // is undefined and an indexing client reports an empty answer from a good response.
    const withReasoning = {
      output: [
        { type: "reasoning", content: [] },
        { type: "message", content: [{ type: "output_text", text: "the answer" }] },
      ],
    };
    expect(textOf(withReasoning)).toBe("the answer");
  });

  test("the SDK-only convenience field is not mistaken for the wire", () => {
    // `output_text` exists in the vendors' SDKs and NOT in the JSON. A client reading it
    // gets undefined on every call and the failure looks like the model saying nothing.
    const sdkShaped = { output_text: "from the SDK", output: [] } as Record<string, unknown>;
    expect(textOf(sdkShaped)).toBe("");
  });

  test("a tool call echoes call_id, which is a different string from id", () => {
    const calls = toolCallsOf({
      output: [
        { type: "function_call", id: "fc_item", call_id: "call_echo", name: "refund", arguments: '{"amount":5}' },
      ],
    });
    expect(calls).toEqual([{ id: "call_echo", name: "refund", args: { amount: 5 } }]);
  });

  test("malformed tool arguments are an empty call, not a crash", () => {
    const calls = toolCallsOf({
      output: [{ type: "function_call", call_id: "c", name: "n", arguments: "{not json" }],
    });
    expect(calls[0]?.args).toEqual({});
  });

  test("strict sits BESIDE schema here, not inside a named wrapper", async () => {
    const { sent, fetchImpl } = capture(answered);
    await responsesWire()(base({ fetch: fetchImpl, schema: { type: "object" } }));
    expect(sent.body?.text).toEqual({
      format: { type: "json_schema", name: "reply", strict: true, schema: { type: "object" } },
    });
  });

  test("the system prompt goes where the endpoint says, and never to both", async () => {
    const asRole = capture(answered);
    await responsesWire({ systemAs: "role" })(base({ fetch: asRole.fetchImpl, system: "be brief" }));
    expect(asRole.sent.body?.instructions).toBeUndefined();
    expect((asRole.sent.body!.input as { role: string }[])[0]).toEqual({ role: "system", content: "be brief" });

    const asField = capture(answered);
    await responsesWire({ systemAs: "instructions" })(base({ fetch: asField.fetchImpl, system: "be brief" }));
    expect(asField.sent.body?.instructions).toBe("be brief");
    expect((asField.sent.body!.input as { role: string }[]).some((i) => i.role === "system")).toBe(false);
  });

  test("max output tokens uses this surface's own field name", async () => {
    const { sent, fetchImpl } = capture(answered);
    await responsesWire()(base({ fetch: fetchImpl, maxTokens: 128 }));
    expect(sent.body?.max_output_tokens).toBe(128);
    expect(sent.body?.max_tokens).toBeUndefined();
    expect(sent.body?.max_completion_tokens).toBeUndefined();
  });

  test("usage is read from this surface's nested details", async () => {
    const { fetchImpl } = capture(answered);
    const out = await responsesWire()(base({ fetch: fetchImpl }));
    expect(out.usage).toEqual({ inputTokens: 10, outputTokens: 2, cachedTokens: 4 });
    expect(out.text).toBe("hi");
  });

  test("an incomplete answer says why, rather than reporting completed", async () => {
    const { fetchImpl } = capture({
      output: [{ type: "message", content: [{ type: "output_text", text: "half a" }] }],
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    });
    const out = await responsesWire()(base({ fetch: fetchImpl }));
    expect(out.finishReason).toBe("max_output_tokens");
  });
});
