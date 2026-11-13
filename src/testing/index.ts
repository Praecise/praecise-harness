/// <reference types="node" />
/**
 * Stand-ins for a model, for an app's own tests.
 *
 * An app built on this framework has behaviour worth testing that is not the model's:
 * which tool its guard refuses, what a workflow does with an answer, what happens when
 * an endpoint is down. None of that needs a network, and a test that reaches one is
 * slow, costs money and fails for reasons that are not the app's. So the model is
 * scripted: a test says what it will reply, in order, and reads back what it was asked.
 *
 * Two are here, at two depths.
 *
 * `scriptedModel` is a request shape of its own, registered through `registerWire` like
 * any other, and an endpoint that speaks it. The app is given that endpoint as its
 * `models` and everything above the wire runs as it does in production: the ladder, the
 * router, the tool loop, the guard. It does not depend on what any provider's JSON looks
 * like, so it is the one to reach for.
 *
 * `scriptedEndpoint` is a `fetch` that answers as an endpoint speaking the `messages`
 * shape would, for a test that is about what is put on that wire.
 *
 * Neither names a real model or a real address.
 */

import type { ModelProvider, Prices } from "../define.js";
import { registerWire } from "../harness/wire/index.js";
import {
  ProviderError,
  type Attachment,
  type ChatAdapter,
  type ChatRequest,
  type ChatResponse,
  type Message,
  type Stop,
  type ToolSchema,
} from "../harness/types.js";

/** A tool the scripted model asks for. */
export interface ScriptedCall {
  name: string;
  args?: Record<string, unknown>;
  /** The call's id. Made up, in order, when left out. */
  id?: string;
}

/** One reply of a script. */
export interface ScriptedReply {
  /** What the model says. An object is sent as its JSON, which is what an agent with `returns` is asked for. */
  text?: string | Record<string, unknown> | unknown[];
  /** A tool to ask for instead of, or as well as, answering. */
  tool?: ScriptedCall;
  /** Several, asked for in one turn. */
  tools?: ScriptedCall[];
  /** What the reply reports having cost. Ten tokens in and five out when left out. */
  usage?: Partial<ChatResponse["usage"]>;
  /** Why the reply ended, where a test needs something other than the usual. */
  stop?: Stop;
  /** What the model made besides text. */
  attachments?: Attachment[];
  /**
   * Fail instead of replying. A number is an HTTP status, raised as the `ProviderError`
   * a real endpoint's failure is — so 429 and 5xx are retried and then crossed, as they
   * would be. A string or an `Error` is thrown as it is.
   */
  fail?: number | string | Error;
  /** With a status: how long the endpoint asks to be left alone, in milliseconds. */
  retryAfter?: number;
}

/** A reply, the text of one, or a function that decides when it is asked. */
export type Scripted = string | ScriptedReply | ((request: ScriptedRequest) => string | ScriptedReply);

/** One request the scripted model was sent, as the runtime made it. */
export interface ScriptedRequest {
  /** The model named: which rung of the ladder asked. */
  model: string;
  system: string;
  messages: Message[];
  /** The tools offered on this request. */
  tools: ToolSchema[];
  /** The last thing said by the caller or returned by a tool. */
  last: string;
  effort: number;
  json: boolean;
  schema?: Record<string, unknown>;
  maxTokens?: number;
}

export interface ScriptedModelOptions {
  /** What the endpoint is called in `models`. Default `"scripted"`. */
  name?: string;
  /** Replies when the script has run out. Left out, running out fails the request and says so. */
  fallback?: Scripted;
  /** The names of the three rungs. Default `fast`, `balanced`, `best`: labels, not anybody's models. */
  rungs?: { fast?: string; balanced?: string; best?: string };
  /** Prices to declare on the endpoint, for a test about cost. */
  prices?: Prices;
  /** Anything else to declare on the endpoint: `room`, `output`, `takes`, `tools: false`. */
  endpoint?: Partial<ModelProvider>;
}

export interface ScriptedModel {
  /** Give this to the app: `config: { models: model.models }`. Needs no credential. */
  models: Record<string, ModelProvider>;
  /** Every request made, in order. */
  requests: ScriptedRequest[];
  /** Add replies to the end of the script. */
  push(...replies: Scripted[]): void;
  /** How many scripted replies have not been used. */
  readonly remaining: number;
  /** The wire itself, for a test that calls it directly. */
  wire: ChatAdapter;
  /** The name the wire is registered under. */
  speaks: string;
}

let made = 0;

const DEFAULT_USAGE = { inputTokens: 10, outputTokens: 5, cachedTokens: 0 };

function replyFrom(said: string | ScriptedReply): ScriptedReply {
  return typeof said === "string" ? { text: said } : said;
}

function textOf(text: ScriptedReply["text"]): string {
  if (text === undefined) return "";
  return typeof text === "string" ? text : JSON.stringify(text);
}

/**
 * A model that says what a test tells it to.
 *
 *     const model = scriptedModel([
 *       { tool: { name: "lookup", args: { order: "9" } } },
 *       "It shipped on Tuesday.",
 *     ]);
 *     const app = await createApp({ config: { models: model.models }, agents, functions });
 *     const answer = await app.ask("support", "where is order 9?");
 *     model.requests[1].last; // what `lookup` returned
 *
 * Each request takes the next reply. The ladder has three rungs on the one endpoint, so
 * a failure scripted first is retried or climbed past exactly as a real one is, and
 * `requests[n].model` says which rung asked.
 */
export function scriptedModel(replies: Scripted[] = [], options: ScriptedModelOptions = {}): ScriptedModel {
  const speaks = `scripted-${++made}`;
  const queue = [...replies];
  const requests: ScriptedRequest[] = [];
  let calls = 0;

  const wire: ChatAdapter = async (request: ChatRequest): Promise<ChatResponse> => {
    if (request.signal?.aborted) throw request.signal.reason ?? new Error("aborted");
    const last = request.messages.at(-1);
    const asked: ScriptedRequest = {
      model: request.model,
      system: request.system,
      // A copy: the runtime goes on adding to the conversation it sent.
      messages: request.messages.map((message) => ({ ...message })),
      tools: request.tools ?? [],
      last: last?.content ?? "",
      effort: request.effort,
      json: Boolean(request.json),
      ...(request.schema ? { schema: request.schema } : {}),
      ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
    };
    requests.push(asked);

    const next = queue.length ? queue.shift()! : options.fallback;
    if (next === undefined) {
      throw new Error(
        `the scripted model was asked ${requests.length} time(s) and its script had ${replies.length} repl${replies.length === 1 ? "y" : "ies"}. ` +
          `Add a reply for this request, or pass \`fallback\`.`,
      );
    }
    const reply = replyFrom(typeof next === "function" ? next(asked) : next);

    if (reply.fail !== undefined) {
      if (typeof reply.fail === "number") {
        throw new ProviderError(options.name ?? "scripted", reply.fail, textOf(reply.text) || "scripted failure", reply.retryAfter);
      }
      throw typeof reply.fail === "string" ? new Error(reply.fail) : reply.fail;
    }

    const text = textOf(reply.text);
    const toolCalls = [...(reply.tool ? [reply.tool] : []), ...(reply.tools ?? [])].map((call) => ({
      id: call.id ?? `call_${++calls}`,
      name: call.name,
      args: call.args ?? {},
    }));
    // Handed over a word at a time where the runtime asked for fragments, as an endpoint would.
    if (request.onText && text) for (const piece of text.split(/(?<=\s)/)) request.onText(piece);

    return {
      text,
      toolCalls,
      usage: { ...DEFAULT_USAGE, ...reply.usage },
      stop: reply.stop ?? (toolCalls.length ? "tools" : "end"),
      ...(reply.attachments?.length ? { attachments: reply.attachments } : {}),
    };
  };

  registerWire(speaks, wire);

  return {
    models: {
      [options.name ?? "scripted"]: {
        // An address nothing is sent to: the wire above answers in its place.
        url: `scripted://${speaks}`,
        credential: "",
        speaks,
        fast: options.rungs?.fast ?? "fast",
        balanced: options.rungs?.balanced ?? "balanced",
        best: options.rungs?.best ?? "best",
        ...(options.prices ? { prices: options.prices } : {}),
        ...options.endpoint,
      },
    },
    requests,
    push: (...more) => void queue.push(...more),
    get remaining() {
      return queue.length;
    },
    wire,
    speaks,
  };
}

// ── An endpoint on the `messages` shape, as a fetch ──────────────────────────

/** One reply of a scripted `messages` endpoint. */
export interface EndpointReply {
  text: string;
  /** Tool the model should ask for instead of answering. */
  tool?: { name: string; args: unknown };
  /** Provider-native stop reason, where a test needs one other than the usual. */
  stop?: string;
  /** Answer with this HTTP status and `text` as the body, instead of a reply. */
  status?: number;
  /** Token counts to report. Ten in and five out when left out. */
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface ScriptedEndpoint {
  /** Give this to the app as `fetch`. */
  fetch: typeof fetch;
  /** Every request body the endpoint received, with the model it named. */
  calls: { model: string; body: Record<string, unknown> }[];
}

/** The scripted reply, delivered a word at a time as server-sent events. */
function asEvents(reply: EndpointReply, stop: string): Response {
  const text = reply.text
    ? reply.text.split(/(?<=\s)/).map((piece) => ({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: piece },
      }))
    : [];

  const tool = reply.tool
    ? [
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "t1", name: reply.tool.name },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(reply.tool.args) },
        },
      ]
    : [];

  const frames = [
    { type: "message_start", message: { usage: { input_tokens: reply.usage?.input_tokens ?? 10 } } },
    ...text,
    ...tool,
    { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: reply.usage?.output_tokens ?? 5 } },
  ];

  return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/**
 * A stand-in for an endpoint on the `messages` shape, as a `fetch`. Each request takes
 * the next scripted reply, so a test can drive a ladder turn by turn and read back the
 * bodies that were sent. The app's endpoint is declared with `speaks: "messages"` and
 * any address; nothing is sent to it.
 */
export function scriptedEndpoint(replies: EndpointReply[]): ScriptedEndpoint {
  const calls: { model: string; body: Record<string, unknown> }[] = [];
  const queue = [...replies];

  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ model: String(body.model), body });

    if (!url.includes("/v1/messages")) {
      return new Response("not found", { status: 404 });
    }

    const reply = queue.shift() ?? { text: "no more scripted replies" };
    if (reply.status !== undefined && (reply.status < 200 || reply.status > 299)) {
      return new Response(reply.text, { status: reply.status });
    }
    const stop = reply.stop ?? (reply.tool ? "tool_use" : "end_turn");
    if (body.stream) return asEvents(reply, stop);

    const content = [
      ...(reply.text ? [{ type: "text", text: reply.text }] : []),
      ...(reply.tool
        ? [{ type: "tool_use", id: "t1", name: reply.tool.name, input: reply.tool.args }]
        : []),
    ];

    return new Response(
      JSON.stringify({
        content,
        stop_reason: stop,
        usage: { input_tokens: reply.usage?.input_tokens ?? 10, output_tokens: reply.usage?.output_tokens ?? 5 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  return { fetch: impl, calls };
}

/**
 * The system prompt of a request a scripted `messages` endpoint recorded, as text.
 *
 * That shape sends it as blocks once it marks the stable part for keeping, and a test
 * asking what the model was told should not have to know that.
 */
export function systemText(system: unknown): string {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system.map((block) => (block as { text?: string }).text ?? "").join("\n\n");
}
