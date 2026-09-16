/**
 * What happens when an endpoint stops talking.
 *
 * A request with no clock on it is not patient, it is indefinite — and the failure is
 * invisible from inside, because a socket that is open and silent looks exactly like a
 * model that is thinking. These are the three outcomes that distinction has to produce:
 * a rung that failed and is crossed away from, a long answer arriving steadily that is
 * never cut off for being long, and a half-arrived answer that is kept rather than
 * thrown away along with what it cost.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { planAgent } from "../src/compile/plan.js";
import { loadProject } from "../src/project/load.js";
import { BuiltinHarness } from "../src/harness/builtin.js";
import { chatWire } from "../src/harness/wire/chat.js";
import { ProviderError, type ChatRequest } from "../src/harness/types.js";
import { cleanup, FRAMEWORK, makeProject } from "./helpers.js";

/** Short enough that a test is a test, long enough that a scheduled gap is not one. */
const IDLE = "80";
const TOTAL = "60";

let state: string;
const roots: string[] = [];

beforeEach(async () => {
  state = await mkdtemp(join(tmpdir(), "praecise-state-"));
  process.env.PRAECISE_WIRE_IDLE_MS = IDLE;
  process.env.PRAECISE_WIRE_TOTAL_MS = TOTAL;
});

afterEach(async () => {
  delete process.env.PRAECISE_WIRE_IDLE_MS;
  delete process.env.PRAECISE_WIRE_TOTAL_MS;
  await rm(state, { recursive: true, force: true });
  await Promise.all(roots.splice(0).map(cleanup));
});

const wait = (ms: number) => new Promise((resume) => setTimeout(resume, ms));

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

/** An endpoint that accepts the connection and then never answers at all. */
const silent = (): typeof fetch =>
  (async (_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () =>
        reject(new DOMException("the operation was aborted", "AbortError")),
      );
    })) as unknown as typeof fetch;

/**
 * An endpoint that streams the frames it is given, `gap` apart, and then either
 * finishes or goes quiet with the connection still open — which is what a hung server
 * looks like from here, and what nothing but a clock can tell from a slow one.
 */
function streaming(frames: unknown[], gap: number, end: "close" | "quiet"): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let stopped = false;
        const encoder = new TextEncoder();
        init.signal?.addEventListener("abort", () => {
          stopped = true;
          try {
            controller.error(new DOMException("the operation was aborted", "AbortError"));
          } catch {
            // Already closed: nothing left to abort.
          }
        });
        void (async () => {
          for (const frame of frames) {
            await wait(gap);
            if (stopped) return;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
          }
          if (end === "close" && !stopped) controller.close();
        })();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
}

/** One frame of the shape this wire streams. */
const says = (text: string) => ({ choices: [{ delta: { content: text } }] });

describe("a clock on every request to the chat shape", () => {
  it("reports a silent endpoint as a rung that failed", async () => {
    // Shaped as a provider failure, status and all, because that is what the router
    // already knows how to read: a rung that did not answer is crossed away from, and
    // status 0 is not a rate limit, so the same rung is not asked again first.
    const failure = await chatWire(base({ fetch: silent() })).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).provider).toBe("chat");
    expect((failure as ProviderError).status).toBe(0);
    expect((failure as ProviderError).message).toContain("did not answer");
  });

  it("leaves the caller's own cancellation as the caller's", async () => {
    // The clock is composed with the caller's signal rather than substituted for it.
    // A wire that dropped the caller's signal would make an abort button stop working;
    // one that dressed a cancellation up as a provider failure would send the router
    // looking for another model to run a request nobody wants any more.
    const stop = new AbortController();
    const pending = chatWire(base({ fetch: silent(), signal: stop.signal })).catch(
      (error: unknown) => error,
    );
    stop.abort();

    const failure = await pending;
    expect(failure).not.toBeInstanceOf(ProviderError);
    expect((failure as Error).name).toBe("AbortError");
  });

  it("starts the clock again at every frame, so a long answer is never cut off", async () => {
    // Four frames thirty milliseconds apart outlast an eighty-millisecond clock twice
    // over. None of the GAPS does, and the gap is what says whether anyone is working.
    const said: string[] = [];
    const reply = await chatWire(
      base({
        fetch: streaming([says("one "), says("two "), says("three "), says("four")], 30, "close"),
        onText: (text) => said.push(text),
      }),
    );

    expect(reply.text).toBe("one two three four");
    expect(said).toHaveLength(4);
    expect(reply.finishReason).not.toBe("timeout");
  });

  it("keeps the text that arrived when the stream goes quiet", async () => {
    // The words were already shown to whoever asked and were already paid for. Throwing
    // the reply away in favour of an error is the worst of the outcomes available.
    const reply = await chatWire(
      base({ fetch: streaming([says("half an ")], 5, "quiet"), onText: () => {} }),
    );

    expect(reply.text).toBe("half an ");
    expect(reply.finishReason).toBe("timeout");
    expect(reply.notes?.join(" ")).toContain("stopped sending");
  });

  it("reports a stream that said nothing at all as a rung that failed", async () => {
    // Nothing to salvage, so this is simply an endpoint that did not answer — and it
    // must arrive in the shape that gets the request moved to another model.
    const failure = await chatWire(
      base({ fetch: streaming([], 5, "quiet"), onText: () => {} }),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).status).toBe(0);
  });
});

describe("what the router does with a timeout", () => {
  it("crosses to the next model rather than asking the silent one again", async () => {
    // The whole reason the timeout is shaped as a provider failure. A rate limit earns
    // patience with the same rung; an endpoint that has stopped talking earns none,
    // because waiting longer is exactly what already did not work.
    const root = await makeProject({
      "praecise.config.ts": `import { defineConfig } from "${FRAMEWORK}";
        export default defineConfig({
          models: {
            house: {
              url: "https://models.test",
              credential: "HOUSE_KEY",
              speaks: "chat",
              fast: "small",
              balanced: "mid",
            },
          },
        });`,
      "agents/a.ts": `import { agent } from "${FRAMEWORK}";
        export default agent({ role: "Help.", quality: "balanced", memory: false });`,
    });
    roots.push(root);
    const project = await loadProject(root);
    const plan = await planAgent(project, project.agents.a!, { env: { HOUSE_KEY: "test-key" } });

    let calls = 0;
    const impl = (async (_url: string, init: RequestInit) => {
      calls++;
      if (calls === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("the operation was aborted", "AbortError")),
          );
        });
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "recovered" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const answer = await new BuiltinHarness({ stateDir: state, fetch: impl }).ask(plan, "hi");

    expect(answer.text).toBe("recovered");
    expect(answer.notes?.join(" ")).toContain("trying the next model");
    expect(answer.notes?.join(" ")).not.toContain("is busy");
    expect(calls).toBe(2);
  });
});
