/**
 * The three things a deployment is allowed to say about its own endpoint.
 *
 * Every one of these began as a patched copy of the framework, which is the signal that
 * a seam was missing rather than that a feature was: a header a gated endpoint wants, a
 * body field its runtime names and the protocol does not, and how patient to be with a
 * server that takes one request at a time. They are deliberately narrow — declared
 * values threaded to the request, not a place to run code — because the alternative to
 * a fork should not be a plugin system.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { planAgent } from "../src/compile/plan.js";
import { loadProject } from "../src/project/load.js";
import { BuiltinHarness } from "../src/harness/builtin.js";
import { resolveHarness } from "../src/harness/index.js";
import { chatWire } from "../src/harness/wire/chat.js";
import { messagesWire } from "../src/harness/wire/messages.js";
import type { ChatRequest } from "../src/harness/types.js";
import { cleanup, FRAMEWORK, makeProject } from "./helpers.js";

let state: string;
const roots: string[] = [];

beforeEach(async () => {
  state = await mkdtemp(join(tmpdir(), "praecise-state-"));
});

afterEach(async () => {
  await rm(state, { recursive: true, force: true });
  await Promise.all(roots.splice(0).map(cleanup));
});

/** Capture the outbound request — body AND headers — without a network. */
function capture(payload: unknown) {
  const sent: { body?: Record<string, unknown>; headers?: Record<string, string> } = {};
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    sent.body = JSON.parse(String(init.body)) as Record<string, unknown>;
    sent.headers = init.headers as Record<string, string>;
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

const chatReply = {
  choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
};

const messagesReply = {
  content: [{ type: "text", text: "hi" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
};

const base = (over: Partial<ChatRequest> = {}): ChatRequest =>
  ({
    model: "m",
    baseUrl: "https://api.example.com",
    apiKey: "k",
    system: "",
    messages: [{ role: "user", content: "hello" }],
    effort: 0,
    depth: "none",
    ...over,
  }) as ChatRequest;

describe("headers an endpoint needs", () => {
  it("sends what the provider declared, on both shapes", async () => {
    const chat = capture(chatReply);
    await chatWire(base({ headers: { "x-tenant": "seven" }, fetch: chat.fetchImpl }));
    expect(chat.sent.headers?.["x-tenant"]).toBe("seven");

    const messages = capture(messagesReply);
    await messagesWire(base({ headers: { "x-tenant": "seven" }, fetch: messages.fetchImpl }));
    expect(messages.sent.headers?.["x-tenant"]).toBe("seven");
  });

  it("puts the credential in the header the endpoint asked for, and sends no bearer", async () => {
    // Some gated endpoints read `Authorization: Bearer` as an anonymous caller and
    // refuse it outright. The credential still comes from the environment: naming the
    // header is the whole of what the app has to say about it.
    const chat = capture(chatReply);
    await chatWire(base({ apiKey: "secret", credentialHeader: "x-house-key", fetch: chat.fetchImpl }));
    expect(chat.sent.headers?.["x-house-key"]).toBe("secret");
    expect(chat.sent.headers).not.toHaveProperty("authorization");

    const messages = capture(messagesReply);
    await messagesWire(
      base({ apiKey: "secret", credentialHeader: "x-house-key", fetch: messages.fetchImpl }),
    );
    expect(messages.sent.headers?.["x-house-key"]).toBe("secret");
    expect(messages.sent.headers).not.toHaveProperty("x-api-key");
  });

  it("leaves an endpoint that named no header exactly as it was", async () => {
    const chat = capture(chatReply);
    await chatWire(base({ apiKey: "secret", fetch: chat.fetchImpl }));
    expect(chat.sent.headers?.authorization).toBe("Bearer secret");

    const messages = capture(messagesReply);
    await messagesWire(base({ apiKey: "secret", fetch: messages.fetchImpl }));
    expect(messages.sent.headers?.["x-api-key"]).toBe("secret");
  });

  it("lets a declared header override the credential one", async () => {
    // Applied last on purpose: an app that spells a header out has said something more
    // specific than any default, and there is nowhere else left for it to say it.
    const { sent, fetchImpl } = capture(chatReply);
    await chatWire(
      base({
        apiKey: "secret",
        credentialHeader: "x-house-key",
        headers: { "x-house-key": "a different one" },
        fetch: fetchImpl,
      }),
    );
    expect(sent.headers?.["x-house-key"]).toBe("a different one");
  });
});

describe("body fields the protocol does not name", () => {
  it("merges what the provider declared into the request", async () => {
    // A self-hosted runtime's own template switch is the ordinary case: nothing in the
    // protocol names it, and turning it on used to mean patching the wire.
    const { sent, fetchImpl } = capture(chatReply);
    await chatWire(
      base({ body: { chat_template_kwargs: { enable_thinking: false } }, fetch: fetchImpl }),
    );
    expect(sent.body?.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(sent.body?.model).toBe("m");
  });

  it("never lets a declared field replace the model or the conversation", async () => {
    // It fills gaps; it does not overrule the request. A config that could silently
    // redirect a request to another model would be a strange thing to have written.
    const { sent, fetchImpl } = capture(chatReply);
    await chatWire(
      base({
        body: { model: "somewhere-else", messages: [], max_completion_tokens: 7 },
        fetch: fetchImpl,
      }),
    );
    expect(sent.body?.model).toBe("m");
    expect(sent.body?.messages).toHaveLength(1);
    // The ceiling is set per request too, so the request's own wins here as well.
    expect(sent.body?.max_completion_tokens).toBe(4_096);
  });

  it("merges into the messages shape the same way", async () => {
    const { sent, fetchImpl } = capture(messagesReply);
    await messagesWire(base({ body: { metadata: { user_id: "seven" } }, fetch: fetchImpl }));
    expect(sent.body?.metadata).toEqual({ user_id: "seven" });
    expect(sent.body?.model).toBe("m");
  });
});

/** A project whose one endpoint is declared with everything this file is about. */
async function seamedProject(declaration: string): Promise<string> {
  const root = await makeProject({
    "praecise.config.ts": `import { defineConfig } from "${FRAMEWORK}";
      export default defineConfig({ ${declaration} });`,
    "agents/a.ts": `import { agent } from "${FRAMEWORK}";
      export default agent({ role: "Help.", quality: "fast", memory: false });`,
  });
  roots.push(root);
  return root;
}

const planFor = async (root: string) => {
  const project = await loadProject(root);
  return planAgent(project, project.agents.a!, { env: { HOUSE_KEY: "test-key" } });
};

describe("a declaration in the config reaches the endpoint", () => {
  it("carries the header, the credential header and the body field through the rung", async () => {
    // The seam is only worth anything if it survives the whole path: declaration →
    // planned rung → the request a wire actually sends.
    const root = await seamedProject(`models: {
      house: {
        url: "https://models.test",
        credential: "HOUSE_KEY",
        credentialHeader: "x-house-key",
        headers: { "x-tenant": "seven" },
        body: { chat_template_kwargs: { enable_thinking: false } },
        speaks: "chat",
        fast: "small",
      },
    }`);
    const { sent, fetchImpl } = capture(chatReply);

    await new BuiltinHarness({ stateDir: state, fetch: fetchImpl }).ask(await planFor(root), "hi");

    expect(sent.headers?.["x-house-key"]).toBe("test-key");
    expect(sent.headers).not.toHaveProperty("authorization");
    expect(sent.headers?.["x-tenant"]).toBe("seven");
    expect(sent.body?.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(sent.body?.model).toBe("small");
  });
});

/** An endpoint that is busy for the first `times` requests and then answers. */
function busy(times: number): { fetch: typeof fetch; calls: () => number } {
  let calls = 0;
  const impl = (async () => {
    calls++;
    if (calls <= times) return new Response("slow down", { status: 429 });
    return new Response(JSON.stringify(chatReply), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetch: impl, calls: () => calls };
}

const ENDPOINT = `models: {
  house: { url: "https://models.test", credential: "HOUSE_KEY", speaks: "chat", fast: "small" },
}`;

describe("how patient to be with a busy endpoint", () => {
  it("keeps asking as many times as the limits allow", async () => {
    // An endpoint serving one request at a time refuses everything queued behind the one
    // in flight, and crossing to another model on that pays more precisely because the
    // cheap one was busy. Two tries is the right default and the wrong number here.
    const root = await seamedProject(ENDPOINT);
    const plan = await planFor(root);
    const endpoint = busy(4);

    const harness = await resolveHarness({
      root: state,
      config: { limits: { retries: 4, retryDelay: 1 } },
      fetch: endpoint.fetch,
    });
    const answer = await harness.ask(plan, "hi");

    expect(answer.text).toBe("hi");
    expect(endpoint.calls()).toBe(5);
  });

  it("gives up where the default says to, so the knob is doing the work", async () => {
    const root = await seamedProject(ENDPOINT);
    const plan = await planFor(root);
    const endpoint = busy(4);

    const failure = await new BuiltinHarness({ stateDir: state, fetch: endpoint.fetch })
      .ask(plan, "hi")
      .catch((error: unknown) => error);

    // Three attempts — the first and two retries — and then the rung has had its
    // chances, and with nowhere to cross to the request fails on the same script the
    // raised count answers. Which is the point: the number is what changed.
    expect(failure).toBeInstanceOf(Error);
    expect(endpoint.calls()).toBe(3);
  });

  it("waits the base delay it was given before asking again", async () => {
    // Jitter is half to one and a half of the base, so the least a single retry can wait
    // is half of it. Anything shorter means the setting was not reaching the wait.
    const root = await seamedProject(ENDPOINT);
    const plan = await planFor(root);
    const endpoint = busy(1);

    const started = Date.now();
    const harness = await resolveHarness({
      root: state,
      config: { limits: { retries: 1, retryDelay: 300 } },
      fetch: endpoint.fetch,
    });
    const answer = await harness.ask(plan, "hi");

    expect(answer.text).toBe("hi");
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  });
});
