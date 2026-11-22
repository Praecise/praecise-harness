/**
 * The "contents" shape (`generateContent`), and three things about it that go wrong without
 * anything failing: a key written into an address that logs keep, reasoning handed over as
 * if it were the answer, and tokens that were billed and never counted.
 *
 * No test touches a network; the endpoint is a fake `fetch` that captures the request.
 */
import { describe, expect, test } from "vitest";

import { contentsWire } from "../src/harness/wire/contents.js";
import type { ChatRequest } from "../src/harness/types.js";

function endpoint(reply: unknown, streamed = false) {
  const sent: { url?: string; headers?: Record<string, string> } = {};
  const fetchImpl = (async (url: string, init: RequestInit) => {
    sent.url = String(url);
    sent.headers = init.headers as Record<string, string>;
    if (!streamed) return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
    const frames = (reply as unknown[]).map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
    return new Response(frames, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

const request = (fetchImpl: typeof fetch, more: Partial<ChatRequest> = {}): ChatRequest => ({
  model: "m",
  baseUrl: "https://endpoint",
  apiKey: "secret-key",
  system: "be brief",
  messages: [{ role: "user", content: "hi" }],
  effort: 0,
  fetch: fetchImpl,
  ...more,
});

const answer = { candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] };

describe("where the key travels", () => {
  test("in a header, and nowhere in the address", async () => {
    const { sent, fetchImpl } = endpoint(answer);
    await contentsWire(request(fetchImpl));
    expect(sent.url).toBe("https://endpoint/v1beta/models/m:generateContent");
    expect(sent.url).not.toContain("secret-key");
    expect(sent.headers?.["x-goog-api-key"]).toBe("secret-key");
  });

  test("in the header a provider named, where it named one", async () => {
    const { sent, fetchImpl } = endpoint(answer);
    await contentsWire(request(fetchImpl, { credentialHeader: "x-gateway-key" }));
    expect(sent.headers?.["x-gateway-key"]).toBe("secret-key");
    expect(sent.headers?.["x-goog-api-key"]).toBeUndefined();
  });

  test("the same when the answer is streamed", async () => {
    const { sent, fetchImpl } = endpoint([answer], true);
    await contentsWire(request(fetchImpl, { onText: () => {} }));
    expect(sent.url).toBe("https://endpoint/v1beta/models/m:streamGenerateContent?alt=sse");
    expect(sent.headers?.["x-goog-api-key"]).toBe("secret-key");
  });
});

describe("the model's reasoning is not its answer", () => {
  const working = { text: "First I should think about refunds.", thought: true };

  test("a part marked as thought is left out of a whole reply", async () => {
    const { fetchImpl } = endpoint({ candidates: [{ content: { parts: [working, { text: "Five days." }] }, finishReason: "STOP" }] });
    expect((await contentsWire(request(fetchImpl))).text).toBe("Five days.");
  });

  test("and out of a streamed one, fragment by fragment", async () => {
    const pieces: string[] = [];
    const { fetchImpl } = endpoint([
      { candidates: [{ content: { parts: [working] } }] },
      { candidates: [{ content: { parts: [{ text: "Five " }] } }] },
      { candidates: [{ content: { parts: [{ text: "days." }] }, finishReason: "STOP" }] },
    ], true);
    const reply = await contentsWire(request(fetchImpl, { onText: (text) => pieces.push(text) }));
    expect(reply.text).toBe("Five days.");
    expect(pieces).toEqual(["Five ", "days."]);
  });

  test("a reply that is only reasoning has no text", async () => {
    const { fetchImpl } = endpoint({ candidates: [{ content: { parts: [working] }, finishReason: "STOP" }] });
    expect((await contentsWire(request(fetchImpl))).text).toBe("");
  });
});

describe("what is counted as output", () => {
  test("the candidates and the thoughts", async () => {
    const { fetchImpl } = endpoint({ ...answer, usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 30, totalTokenCount: 150 } });
    const { usage } = await contentsWire(request(fetchImpl));
    expect(usage).toMatchObject({ inputTokens: 100, outputTokens: 50, reasoningTokens: 30 });
  });

  test("and whatever the total holds beyond the counts it names", async () => {
    const { fetchImpl } = endpoint({ ...answer, usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 40 } });
    const { usage } = await contentsWire(request(fetchImpl));
    expect(usage).toMatchObject({ inputTokens: 10, outputTokens: 30 });
  });

  test("a total that is absent or smaller adds nothing", async () => {
    const { fetchImpl } = endpoint({ ...answer, usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } });
    expect((await contentsWire(request(fetchImpl))).usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
  });
});
