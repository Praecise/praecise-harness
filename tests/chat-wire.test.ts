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

  test("an endpoint that takes a token budget is not sent reasoning_effort either", async () => {
    // The same unknown field, differing only in which of the two ways of asking for
    // depth the author had in mind. A provider that declared a budget has said this
    // field is not how its endpoint takes one.
    const { sent, fetchImpl } = capture();
    await chatWire(base({ depth: "budget", fetch: fetchImpl }));
    expect(sent.body).not.toHaveProperty("reasoning_effort");
  });

  test("depth left undeclared is not a declaration, so the field stays off", async () => {
    // This used to send it, on the reasoning that silence was permission. It is not:
    // an undeclared provider on this wire defaults to taking no depth at all, so the
    // one reading consistent with the rest of the framework is that nothing was said.
    const { sent, fetchImpl } = capture();
    await chatWire(base({ fetch: fetchImpl }));
    expect(sent.body).not.toHaveProperty("reasoning_effort");
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

describe("every request leaves with a ceiling on it", () => {
  test("a request that names no ceiling is given the default one", async () => {
    // Without this a reply decodes until the endpoint decides to stop, and nothing in
    // the framework sets `maxTokens` — so on an endpoint serving one request at a time,
    // one rambling answer holds the slot for as long as it cares to.
    const { sent, fetchImpl } = capture();
    await chatWire(base({ fetch: fetchImpl }));
    expect(sent.body?.max_completion_tokens).toBe(4_096);
  });

  test("a ceiling the caller named is the one that is sent", async () => {
    const { sent, fetchImpl } = capture();
    await chatWire(base({ maxTokens: 120, fetch: fetchImpl }));
    expect(sent.body?.max_completion_tokens).toBe(120);
  });

  test("a thinking request is floored, so the budget is not all spent on thought", async () => {
    // One pool covers the reasoning and the reply. Sixteen tokens of it go entirely on
    // the first, and what comes back is an empty string billed as work.
    const { sent, fetchImpl } = capture();
    await chatWire(base({ depth: "effort", maxTokens: 16, fetch: fetchImpl }));
    expect(sent.body?.max_completion_tokens).toBe(512);
  });

  test("a request asking for no depth is left at the ceiling it named", async () => {
    const { sent, fetchImpl } = capture();
    await chatWire(base({ depth: "none", maxTokens: 16, fetch: fetchImpl }));
    expect(sent.body?.max_completion_tokens).toBe(16);
  });
});
