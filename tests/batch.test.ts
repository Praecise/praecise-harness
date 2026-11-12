/**
 * Many questions handed over at once.
 *
 * What goes into a batch is what each wire would have sent on its own, and what comes
 * out is read by the same wire — so an ask in a batch is an ordinary ask whose replies
 * arrive later: its tools run, its guard is asked, and its failure is its own.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { agent, fn, guard } from "../src/define.js";
import type { ChatRequest } from "../src/harness/types.js";
import { knownBatches, registerBatch, replyOf, requestOf } from "../src/harness/wire/batch.js";
import { messagesWire } from "../src/harness/wire/messages.js";
import { createApp } from "../src/sdk.js";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  json?: Record<string, unknown>;
  form?: Record<string, string>;
  file?: string;
}

function recorder(answer: (seen: Seen, all: Seen[]) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const impl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const entry: Seen = { url: String(url), method: init?.method ?? "GET", headers: { ...(init?.headers as Record<string, string>) } };
    if (init?.body instanceof FormData) {
      entry.form = {};
      for (const [key, value] of init.body.entries()) {
        if (typeof value === "string") entry.form[key] = value;
        else entry.file = await value.text();
      }
    } else if (typeof init?.body === "string") {
      entry.json = JSON.parse(init.body) as Record<string, unknown>;
    }
    seen.push(entry);
    return answer(entry, seen);
  }) as typeof fetch;
  return { fetch: impl, seen };
}

const jsonl = (rows: unknown[]): Response => new Response(rows.map((row) => JSON.stringify(row)).join("\n"), { headers: { "content-type": "application/x-jsonl" } });
const noWait = { wait: async (): Promise<void> => undefined };

/** The text of the last user turn of a messages-shaped request body. */
function askedOf(params: Record<string, unknown>): string {
  const messages = params.messages as { role: string; content: { type: string; text?: string }[] }[];
  const first = messages.find((message) => message.role === "user")!;
  return first.content.find((block) => block.type === "text")?.text ?? "";
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "praecise-batch-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

const house = { models: { house: { url: "https://models.test", credential: "HOUSE_KEY", speaks: "messages", fast: "small" } } };

describe("a batch on messages", () => {
  it("hands every question over at once, asks after it until it has ended, and answers in the order asked", async () => {
    let polls = 0;
    let submitted: { custom_id: string; params: Record<string, unknown> }[] = [];
    const model = recorder((seen) => {
      if (seen.method === "POST" && seen.url === "https://models.test/v1/messages/batches") {
        submitted = seen.json!.requests as typeof submitted;
        return Response.json({ id: "msgbatch_1", processing_status: "in_progress", results_url: null });
      }
      if (seen.url === "https://models.test/v1/messages/batches/msgbatch_1") {
        polls++;
        return Response.json(
          polls < 3
            ? { id: "msgbatch_1", processing_status: "in_progress", results_url: null }
            : { id: "msgbatch_1", processing_status: "ended", results_url: "https://models.test/v1/messages/batches/msgbatch_1/results" },
        );
      }
      if (seen.url.endsWith("/results")) {
        // Not in the order they were asked, and one of them refused.
        return jsonl(
          [...submitted].reverse().map((request) =>
            askedOf(request.params).includes("two")
              ? { custom_id: request.custom_id, result: { type: "errored", error: { type: "error", error: { type: "invalid_request_error", message: "no" } } } }
              : {
                  custom_id: request.custom_id,
                  result: {
                    type: "succeeded",
                    message: { content: [{ type: "text", text: `answer to ${askedOf(request.params)}` }], stop_reason: "end_turn", usage: { input_tokens: 7, output_tokens: 3 } },
                  },
                },
          ),
        );
      }
      return new Response("unexpected", { status: 500 });
    });
    const events: string[] = [];
    const app = await createApp({ root, config: house, agents: { a: agent({ role: "Answer.", quality: "fast" }) } }, { env: { HOUSE_KEY: "k" }, fetch: model.fetch });
    const results = await app.askMany("a", ["one", { input: "two" }, "three"], { ...noWait, onBatch: (event) => events.push(`${event.state} ${event.requests}`) });

    expect(results.map((result) => result.answer?.text)).toEqual(["answer to one", undefined, "answer to three"]);
    expect(results[1]!.error?.message).toContain("responded 400");
    expect(results[0]!.answer!.usage.inputTokens).toBe(7);

    // One batch, three requests, each exactly what would have been sent alone — and nothing sent alone.
    expect(submitted.map((request) => request.custom_id)).toEqual(["r0", "r1", "r2"]);
    expect(submitted[0]!.params).toMatchObject({ model: "small", system: [{ type: "text", text: expect.stringContaining("Answer.") }] });
    expect(submitted[0]!.params.stream).toBeUndefined();
    expect(model.seen.filter((entry) => entry.url === "https://models.test/v1/messages")).toHaveLength(0);
    expect(model.seen[0]!.headers).toMatchObject({ "x-api-key": "k", "anthropic-version": "2023-06-01" });
    expect(polls).toBe(3);
    expect(events).toEqual(["submitted 3", "done 3"]);
    await app.close();
  });

  it("runs each agent's tools between batches, through the guard, and batches the turns that follow", async () => {
    const batches: { custom_id: string; params: Record<string, unknown> }[][] = [];
    const model = recorder((seen) => {
      if (seen.method === "POST" && seen.url.endsWith("/v1/messages/batches")) {
        batches.push(seen.json!.requests as { custom_id: string; params: Record<string, unknown> }[]);
        return Response.json({ id: `b${batches.length}`, processing_status: "in_progress" });
      }
      if (seen.url.endsWith("/results")) {
        const batch = batches[Number(/batches\/b(\d+)\//.exec(seen.url)![1]) - 1]!;
        return jsonl(
          batch.map((request) => {
            const turns = (request.params.messages as unknown[]).length;
            const content = turns === 1 ? [{ type: "tool_use", id: `t-${request.custom_id}`, name: "lookup", input: { order: askedOf(request.params) } }] : [{ type: "text", text: `done ${askedOf(request.params)}` }];
            return { custom_id: request.custom_id, result: { type: "succeeded", message: { content, stop_reason: turns === 1 ? "tool_use" : "end_turn", usage: { input_tokens: 1, output_tokens: 1 } } } };
          }),
        );
      }
      return Response.json({ processing_status: "ended" });
    });
    const looked: string[] = [];
    const lookup = fn({ description: "Look an order up.", input: { order: "the order id" }, effect: "read", run: ({ order }) => (looked.push(String(order)), `order ${String(order)} shipped`) });
    const app = await createApp(
      {
        root,
        config: house,
        agents: { a: agent({ role: "Answer.", quality: "fast", tools: ["lookup"] }) },
        functions: { lookup },
        guard: guard((attempt) => (attempt.args.order === "B" ? "Order B is under review and may not be looked up." : undefined)),
      },
      { env: { HOUSE_KEY: "k" }, fetch: model.fetch },
    );
    const results = await app.askMany("a", ["A", "B"], noWait);

    expect(results.map((result) => result.answer?.text)).toEqual(["done A", "done B"]);
    // Two batches of two: the questions, then the turns after the tools.
    expect(batches.map((batch) => batch.length)).toEqual([2, 2]);
    expect(looked).toEqual(["A"]);
    const second = JSON.stringify(batches[1]);
    expect(second).toContain("order A shipped");
    expect(second).toContain("Order B is under review");
    expect(results[0]!.answer!.toolCalls).toEqual([{ name: "lookup", args: { order: "A" } }]);
    await app.close();
  });

  it("cancels the batch and fails what was waiting when the caller gives up", async () => {
    const stop = new AbortController();
    const model = recorder((seen) => {
      if (seen.method === "POST" && seen.url.endsWith("/batches")) return Response.json({ id: "b1", processing_status: "in_progress" });
      if (seen.url.endsWith("/cancel")) return Response.json({ id: "b1", processing_status: "canceling" });
      return Response.json({ id: "b1", processing_status: "in_progress" });
    });
    const app = await createApp({ root, config: house, agents: { a: agent({ role: "Answer.", quality: "fast" }) } }, { env: { HOUSE_KEY: "k" }, fetch: model.fetch });
    const waiting = app.askMany("a", ["one", "two"], {
      signal: stop.signal,
      wait: (_ms, signal) => new Promise((_resume, reject) => signal?.addEventListener("abort", () => reject(new Error("gave up")))),
    });
    setTimeout(() => stop.abort(), 20);
    const results = await waiting;
    expect(results.map((result) => result.error?.message)).toEqual(["gave up", "gave up"]);
    expect(model.seen.at(-1)).toMatchObject({ method: "POST", url: "https://models.test/v1/messages/batches/b1/cancel" });
    await app.close();
  });

  it("is not used for an endpoint that said it has no batch API", async () => {
    const model = recorder(() => Response.json({ content: [{ type: "text", text: "direct" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
    const config = { models: { house: { ...house.models.house, batch: false } } };
    const app = await createApp({ root, config, agents: { a: agent({ role: "Answer.", quality: "fast" }) } }, { env: { HOUSE_KEY: "k" }, fetch: model.fetch });
    const results = await app.askMany("a", ["one", "two"], noWait);
    expect(results.map((result) => result.answer?.text)).toEqual(["direct", "direct"]);
    expect(model.seen.map((entry) => entry.url)).toEqual(["https://models.test/v1/messages", "https://models.test/v1/messages"]);
    await app.close();
  });
});

describe("a batch on responses and chat", () => {
  it("uploads the requests as a file of lines, makes a batch for the surface's path, and reads both result files", async () => {
    const config = { models: { items: { url: "https://items.test/v1", credential: "ITEMS_KEY", speaks: "responses", fast: "mini" } } };
    let lines: { custom_id: string; method: string; url: string; body: Record<string, unknown> }[] = [];
    const reply = (text: string) => ({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }], usage: { input_tokens: 4, output_tokens: 2 } });
    const model = recorder((seen) => {
      if (seen.url === "https://items.test/v1/files" && seen.method === "POST") {
        lines = seen.file!.split("\n").map((line) => JSON.parse(line) as (typeof lines)[number]);
        return Response.json({ id: "file-in" });
      }
      if (seen.url === "https://items.test/v1/batches") return Response.json({ id: "batch_1", status: "validating" });
      if (seen.url === "https://items.test/v1/batches/batch_1") {
        return Response.json({ id: "batch_1", status: "completed", output_file_id: "file-out", error_file_id: "file-err" });
      }
      if (seen.url === "https://items.test/v1/files/file-out/content") {
        return jsonl([{ id: "x", custom_id: "r1", response: { status_code: 200, request_id: "q", body: reply("second") }, error: null }]);
      }
      if (seen.url === "https://items.test/v1/files/file-err/content") {
        return jsonl([{ id: "y", custom_id: "r0", response: { status_code: 400, request_id: "q", body: { error: { message: "bad input" } } }, error: null }]);
      }
      return new Response("unexpected", { status: 500 });
    });
    const app = await createApp({ root, config, agents: { a: agent({ role: "Answer.", quality: "fast" }) } }, { env: { ITEMS_KEY: "k" }, fetch: model.fetch });
    const results = await app.askMany("a", ["first", "second"], noWait);

    expect(results[1]!.answer?.text).toBe("second");
    expect(results[0]!.error?.message).toContain("bad input");
    expect(model.seen[0]).toMatchObject({ form: { purpose: "batch" }, headers: { authorization: "Bearer k" } });
    expect(model.seen[0]!.headers["content-type"]).toBeUndefined();
    expect(lines.map((line) => [line.custom_id, line.method, line.url])).toEqual([["r0", "POST", "/v1/responses"], ["r1", "POST", "/v1/responses"]]);
    expect(lines[0]!.body.model).toBe("mini");
    expect(model.seen[1]!.json).toEqual({ input_file_id: "file-in", endpoint: "/v1/responses", completion_window: "24h" });
    await app.close();
  });

  it("asks one at a time, and says why, where a chat endpoint turns out to have no batch API", async () => {
    const config = { models: { local: { url: "https://local.test/v1", credential: "", speaks: "chat", fast: "tiny" } } };
    const model = recorder((seen) => {
      if (seen.url.endsWith("/files")) return new Response("not found", { status: 404 });
      return Response.json({ choices: [{ message: { content: "hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    });
    const events: string[] = [];
    const app = await createApp({ root, config, agents: { a: agent({ role: "Answer.", quality: "fast" }) } }, { env: {}, fetch: model.fetch });
    const told: string[] = [];
    const results = await app.askMany(
      "a",
      [{ input: "one", options: { onProgress: (event) => void (event.kind === "note" && told.push(event.text)) } }, "two"],
      { ...noWait, onBatch: (event) => events.push(event.state) },
    );
    expect(results.map((result) => result.answer?.text)).toEqual(["hello", "hello"]);
    expect(told.join(" ")).toContain("has no batch API");
    expect(events).toEqual(["direct"]);
    expect(model.seen.map((entry) => entry.url)).toEqual(["https://local.test/v1/files", "https://local.test/v1/chat/completions", "https://local.test/v1/chat/completions"]);
    await app.close();
  });
});

describe("a batch on contents, and a shape with none", () => {
  it("sends the requests inline to the model's batch method and reads the answers by key, or by position", async () => {
    const config = { models: { media: { url: "https://media.test", credential: "MEDIA_KEY", speaks: "contents", fast: "flash" } } };
    let requests: { request: Record<string, unknown>; metadata: { key: string } }[] = [];
    const answer = (text: string) => ({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 } });
    const model = recorder((seen) => {
      if (seen.url === "https://media.test/v1beta/models/flash:batchGenerateContent?key=k") {
        requests = (seen.json!.batch as { input_config: { requests: { requests: typeof requests } } }).input_config.requests.requests;
        return Response.json({ name: "batches/123", metadata: { state: "JOB_STATE_PENDING" } });
      }
      if (seen.url === "https://media.test/v1beta/batches/123?key=k") {
        return Response.json({
          name: "batches/123",
          done: true,
          metadata: { state: "JOB_STATE_SUCCEEDED" },
          response: { inlinedResponses: { inlinedResponses: [{ response: answer("uno") }, { error: { code: 3, message: "blocked" } }] } },
        });
      }
      return new Response("unexpected", { status: 500 });
    });
    const app = await createApp({ root, config, agents: { a: agent({ role: "Answer.", quality: "fast" }) } }, { env: { MEDIA_KEY: "k" }, fetch: model.fetch });
    const results = await app.askMany("a", ["one", "two"], noWait);
    expect(results[0]!.answer?.text).toBe("uno");
    expect(results[1]!.error?.message).toContain("responded 400");
    expect(requests.map((entry) => entry.metadata.key)).toEqual(["r0", "r1"]);
    expect(JSON.stringify(requests[0]!.request.contents)).toContain('"text":"one"');
    await app.close();
  });

  it("asks an endpoint on interactions directly: its vendor's batch API does not take that shape", async () => {
    const config = { models: { media: { url: "https://media.test", credential: "MEDIA_KEY", speaks: "interactions", fast: "flash" } } };
    const model = recorder(() => Response.json({ status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "live" }] }], outputs: [{ type: "text", text: "live" }], usage: {} }));
    const app = await createApp({ root, config, agents: { a: agent({ role: "Answer.", quality: "fast" }) } }, { env: { MEDIA_KEY: "k" }, fetch: model.fetch });
    const results = await app.askMany("a", ["one", "two"], noWait);
    expect(results.every((result) => !result.error)).toBe(true);
    expect(model.seen.map((entry) => entry.url)).toEqual(["https://media.test/v1beta/interactions", "https://media.test/v1beta/interactions"]);
    expect(knownBatches()).toEqual(expect.arrayContaining(["messages", "responses", "chat", "contents"]));
    expect(knownBatches()).not.toContain("interactions");
    await app.close();
  });
});

describe("the seam", () => {
  const request: ChatRequest = {
    model: "small",
    baseUrl: "https://models.test",
    apiKey: "k",
    system: "Be brief.",
    messages: [{ role: "user", content: "hi" }],
    effort: 0,
    depth: "none",
    headers: { "x-tenant": "t1" },
    fetch,
    onText: () => undefined,
  };

  it("stops a wire before it sends, and hands it an answer as though it had", async () => {
    const sent = await requestOf(messagesWire, request);
    expect(sent.url).toBe("https://models.test/v1/messages");
    expect(sent.headers).toMatchObject({ "x-api-key": "k", "x-tenant": "t1" });
    expect(sent.body).toMatchObject({ model: "small", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
    // Nothing in a batch streams, whatever the ask wanted.
    expect(sent.body.stream).toBeUndefined();

    const reply = await replyOf(messagesWire, request, { status: 200, body: { content: [{ type: "text", text: "hello" }], stop_reason: "end_turn", usage: { input_tokens: 2, output_tokens: 1 } } });
    expect(reply).toMatchObject({ text: "hello", stop: "end", usage: { inputTokens: 2, outputTokens: 1 } });
    await expect(replyOf(messagesWire, request, { status: 529, body: { error: "overloaded" } })).rejects.toMatchObject({ status: 529 });
  });

  it("takes a driver for a wire of the app's own, and refuses one for a wire that ships", () => {
    registerBatch("house-wire", { limit: { items: 10, bytes: 1000 }, submit: async () => "h", poll: async () => new Map() });
    expect(knownBatches()).toContain("house-wire");
    expect(() => registerBatch("chat", { limit: { items: 1, bytes: 1 }, submit: async () => "h", poll: async () => new Map() })).toThrow("ships");
  });
});
