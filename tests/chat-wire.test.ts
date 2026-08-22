/**
 * The "chat" shape, and two ways it spoke over what the caller declared.
 *
 * Both failures are about an endpoint you host yourself. The framework carries
 * `depth` and a credential all the way down and then, in this wire, ignored both —
 * so a rung that said "I take no reasoning parameter" was sent one anyway, and a
 * rung that needed no key was sent an empty `Bearer `. Neither is a shape a hosted
 * llama.cpp server tolerates, and neither failure names itself: one returns 400 for
 * an unknown field, the other looks like a rejected credential.
 */
import { describe, expect, test } from "vitest";
import { chatWire } from "../src/harness/wire/chat.js";
import type { ChatRequest } from "../src/harness/types.js";

/** Capture the outbound request — body AND headers — without a network. */
function capture() {
  const sent: { url?: string; body?: Record<string, unknown>; headers?: Record<string, string> } = {};
  const fetchImpl = (async (url: string, init: RequestInit) => {
    sent.url = url;
    sent.body = JSON.parse(String(init.body)) as Record<string, unknown>;
    sent.headers = init.headers as Record<string, string>;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

const base = (over: Partial<ChatRequest> = {}): ChatRequest =>
  ({
    model: "m",
    baseUrl: "https://api.example.com",
    apiKey: "k",
    system: "",
    messages: [{ role: "user", content: "hello" }],
    effort: 1,
    ...over,
  }) as ChatRequest;

describe("the chat shape honours what the provider declared", () => {
  test("an endpoint that takes no depth is not sent reasoning_effort", async () => {
    // planModels sets effort 1 on the balanced and best rungs regardless of what the
    // provider said about thinking, so `effort > 0` alone was never evidence that the
    // endpoint would accept the field. A self-hosted llama.cpp server 400s on it.
    const { sent, fetchImpl } = capture();
    await chatWire(base({ depth: "none", fetch: fetchImpl }));
    expect(sent.body).not.toHaveProperty("reasoning_effort");
  });

  test("an endpoint that takes effort still gets it", async () => {
    const { sent, fetchImpl } = capture();
    await chatWire(base({ depth: "effort", fetch: fetchImpl }));
    expect(sent.body).toHaveProperty("reasoning_effort");
  });

  test("depth left undeclared keeps the previous behaviour", async () => {
    const { sent, fetchImpl } = capture();
    await chatWire(base({ fetch: fetchImpl }));
    expect(sent.body).toHaveProperty("reasoning_effort");
  });

  test("no credential means no authorization header, not an empty one", async () => {
    // `Bearer ` with nothing after it is not "no credential" — it is a malformed one,
    // which a server may reject or record as a failed auth attempt.
    const { sent, fetchImpl } = capture();
    await chatWire(base({ apiKey: "", fetch: fetchImpl }));
    expect(sent.headers).not.toHaveProperty("authorization");
    expect(sent.headers).toHaveProperty("content-type");
  });

  test("a credential is still sent when there is one", async () => {
    const { sent, fetchImpl } = capture();
    await chatWire(base({ apiKey: "secret", fetch: fetchImpl }));
    expect(sent.headers?.authorization).toBe("Bearer secret");
  });
});
