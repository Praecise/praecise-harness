/**
 * The app, behind the Responses API.
 *
 * `POST /v1/responses` is the request shape a great many clients already speak: SDKs,
 * agent frameworks, anything written against the open Responses specification. Serving
 * it means such a client can call an agent of this app by changing a base URL. The
 * `model` it names is the agent.
 *
 * It is the mirror of `harness/wire/responses.ts`. That file speaks this shape to a
 * model endpoint; this one answers it. What it answers with is the app's agent, with
 * everything that implies: the agent's own instructions, tools, guard, ladder and
 * memory. A caller chooses the agent and what to ask, and nothing about how it runs.
 *
 * ── What maps onto what ───────────────────────────────────────────────────────
 *
 *   model                  the agent's name
 *   input                  the question; earlier items are the conversation so far
 *   instructions,          said to the agent as the caller's instructions, ahead of
 *   system / developer     the question. They do not replace the agent's own.
 *   previous_response_id   a named conversation (`harness/threads.ts`). A response's id
 *                          says which conversation and how far into it, so continuing
 *                          from an earlier response forks from there, as the API has it
 *   store: false           nothing is kept, and the response cannot be continued
 *   tools                  client tools: the agent may call them, and the call is
 *                          handed back to the client as a `function_call` item
 *   stream                 the standard events, in the standard order
 *
 * Sampling parameters (`temperature`, `top_p`, the penalties, `max_output_tokens`,
 * `reasoning`) are accepted and echoed and NOT applied: how an agent is run is its
 * author's decision, and the endpoints behind it are chosen per request by the router.
 * What cannot be honoured at all is refused by name instead of being ignored:
 * `background`, a structured `text.format`, `tool_choice` other than `auto` or `none`.
 *
 * ── Client tools ──────────────────────────────────────────────────────────────
 *
 * A tool the client supplies runs on the client. When the agent calls one, the response
 * ends with a `function_call` item and the agent's turn is held open, in this process,
 * until the next request brings the `function_call_output` under `previous_response_id`.
 * Held for a bounded time (two minutes unless configured), after which the turn is
 * abandoned. The agent's own tools are not the client's business and do not appear as
 * items: they run here, under the app's guard, as they do for any other caller.
 *
 * Calls arrive one at a time. An agent that wants two client tools is answered for the
 * first before it is asked for the second, because the loop that runs tools runs them
 * in the order the model asked unless they are declared read-only, and a client's
 * function has declared nothing.
 */

import { randomBytes } from "node:crypto";

import type { App } from "../app.js";
import type { LocalTool } from "../compile/plan.js";
import type { Answer, Attachment, Message, Progress } from "../harness/types.js";
import { safeMessage } from "../redact.js";

/** Where the ingress is served. The path every Responses client appends to its base URL. */
export const RESPONSES_PATH = "/v1/responses";

/** The standard error envelope: `{ error: { message, type, param, code } }`. */
export interface ResponsesError {
  error: { message: string; type: string; param: string | null; code: string | null };
}

/** One item of a response's output. */
export type ResponseItem =
  | {
      type: "message";
      id: string;
      status: "in_progress" | "completed" | "incomplete";
      role: "assistant";
      content: { type: "output_text"; text: string; annotations: unknown[] }[];
    }
  | {
      type: "function_call";
      id: string;
      call_id: string;
      name: string;
      arguments: string;
      status: "in_progress" | "completed" | "incomplete";
    };

/** A response, as the API returns one. Every field the specification requires is present. */
export interface ResponseResource {
  id: string;
  object: "response";
  created_at: number;
  completed_at: number | null;
  status: "in_progress" | "completed" | "failed" | "incomplete";
  incomplete_details: { reason: string } | null;
  model: string;
  previous_response_id: string | null;
  instructions: string | null;
  output: ResponseItem[];
  error: { code: string; message: string } | null;
  tools: unknown[];
  tool_choice: unknown;
  truncation: string;
  parallel_tool_calls: boolean;
  text: { format: { type: "text" } };
  top_p: number;
  presence_penalty: number;
  frequency_penalty: number;
  top_logprobs: number;
  temperature: number;
  reasoning: { effort: string | null; summary: string | null } | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    input_tokens_details: { cached_tokens: number };
    output_tokens_details: { reasoning_tokens: number };
  } | null;
  max_output_tokens: number | null;
  max_tool_calls: number | null;
  store: boolean;
  background: boolean;
  service_tier: string;
  metadata: unknown;
  safety_identifier: string | null;
  prompt_cache_key: string | null;
}

/** One streaming event. `type` is also the SSE `event:` field, as the specification requires. */
export interface ResponseEvent {
  type: string;
  sequence_number: number;
  [field: string]: unknown;
}

export interface ResponsesOptions {
  /** How long a turn waits for the client to return a tool's result. Default two minutes. */
  toolWaitMs?: number;
  /** Who the request is for, as the holder of the app's token vouches. */
  person?: string;
  /** Stops the work when the caller goes away. */
  signal?: AbortSignal;
}

/** What the transport sends back: one body with its status, or a stream of events. */
export type ResponsesAnswer =
  | { status: number; body: ResponseResource | ResponsesError }
  | { stream: AsyncGenerator<ResponseEvent, void, void> };

const failure = (status: number, type: string, message: string, param: string | null = null, code: string | null = null) => ({
  status,
  body: { error: { message, type, param, code } } satisfies ResponsesError,
});

const invalid = (message: string, param: string | null = null, code: string | null = null) =>
  failure(400, "invalid_request_error", message, param, code);

const newId = (prefix: string): string => `${prefix}_${randomBytes(12).toString("hex")}`;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// ── Conversations ──────────────────────────────────────────────────────────────

/** The conversation a response id belongs to, and how many turns into it the response ends. */
function chainOf(id: string): { thread: string; turns: number } | undefined {
  // The suffix says which response of a turn it was, where a turn took more than one.
  const match = /^resp_([0-9a-f]{24})_(\d{1,9})(?:s\d{1,4})?$/.exec(id);
  return match ? { thread: `resp-${match[1]}`, turns: Number(match[2]) } : undefined;
}

const responseId = (thread: string, turns: number): string => `resp_${thread.slice("resp-".length)}_${turns}`;

// ── A turn that is under way ───────────────────────────────────────────────────

/** What a turn says as it goes: the runtime's own events, and a client tool being called. */
type Happening = Progress | { kind: "client call"; callId: string; name: string; args: string };

/**
 * One ask, which may span several responses.
 *
 * The ask runs once, in the background, and its events are queued. Each response reads
 * the queue until the ask ends or stops at a client tool. A turn stopped at a tool is
 * kept by the id of the response that reported the call, until the result comes or the
 * wait runs out.
 */
class Turn {
  readonly agent: string;
  readonly thread?: string;
  /** How many turns the conversation will hold once this ask has been recorded. */
  readonly turnsAfter: number;
  /** The call the client has been asked to make, when the turn is stopped at one. */
  waiting?: { callId: string; resolve: (output: string) => void };
  /** How many responses this turn has been reported in so far. */
  responses = 0;

  private readonly queue: Happening[] = [];
  private wake?: () => void;
  private readonly stop = new AbortController();
  private timer?: NodeJS.Timeout;

  constructor(agent: string, thread: string | undefined, turnsAfter: number) {
    this.agent = agent;
    this.thread = thread;
    this.turnsAfter = turnsAfter;
  }

  get signal(): AbortSignal {
    return this.stop.signal;
  }

  push(event: Happening): void {
    this.queue.push(event);
    this.wake?.();
    this.wake = undefined;
  }

  /** The next thing that happened, when it has. */
  async next(): Promise<Happening> {
    while (!this.queue.length) {
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
    return this.queue.shift()!;
  }

  /** A client tool was called: say so, and wait for the client. */
  call(name: string, args: Record<string, unknown>): Promise<string> {
    const callId = newId("call");
    return new Promise<string>((resolve, reject) => {
      this.waiting = { callId, resolve };
      this.stop.signal.addEventListener("abort", () => reject(new Error("the client did not return this tool's result")), {
        once: true,
      });
      this.push({ kind: "client call", callId, name, args: JSON.stringify(args) });
    });
  }

  /** Abandon the turn if nothing comes for it within `ms`. */
  expireIn(ms: number, gone: () => void): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      gone();
      this.abandon();
    }, ms);
    this.timer.unref?.();
  }

  /** The client answered: go on. */
  answer(output: string): void {
    clearTimeout(this.timer);
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.resolve(output);
  }

  abandon(): void {
    clearTimeout(this.timer);
    this.waiting = undefined;
    this.stop.abort();
  }
}

/** Turns stopped at a client tool, by the id of the response that reported the call. */
const waitingTurns = new WeakMap<App, Map<string, Turn>>();

function waitingFor(app: App): Map<string, Turn> {
  const found = waitingTurns.get(app);
  if (found) return found;
  const made = new Map<string, Turn>();
  waitingTurns.set(app, made);
  return made;
}

/** The most turns that may be held open at once. Each one holds a place in the app's ask queue. */
const MOST_WAITING = 64;

// ── Reading the request ────────────────────────────────────────────────────────

/** The text of a message item's content, and what came with it that is not text. */
function contentOf(content: unknown, at: string): { text: string; attachments: Attachment[] } | string {
  if (typeof content === "string") return { text: content, attachments: [] };
  if (!Array.isArray(content)) return `${at}.content must be a string or a list of content parts`;
  const texts: string[] = [];
  const attachments: Attachment[] = [];
  for (const [index, part] of content.entries()) {
    if (!isObject(part)) return `${at}.content[${index}] must be an object`;
    if ((part.type === "input_text" || part.type === "output_text" || part.type === "text") && typeof part.text === "string") {
      texts.push(part.text);
    } else if (part.type === "refusal" && typeof part.refusal === "string") {
      texts.push(part.refusal);
    } else if (part.type === "input_image" && typeof part.image_url === "string") {
      // The media type has to be known to send an image on, and only a data URL says it.
      const data = /^data:([\w.+-]+\/[\w.+-]+);base64,(.*)$/s.exec(part.image_url);
      if (!data) {
        return `${at}.content[${index}]: an input_image must be a base64 data URL here; this agent is not given addresses to fetch`;
      }
      attachments.push({ mime: data[1]!, data: data[2]! });
    } else {
      return `${at}.content[${index}] is a "${String(part.type)}" part, which this endpoint does not take`;
    }
  }
  return { text: texts.join("\n"), attachments };
}

interface Read {
  agent: string;
  /** What the caller said the agent should be told, ahead of the question. */
  preface: string[];
  /** The conversation the request itself carried, before its last question. */
  earlier: Message[];
  question: string;
  attachments: Attachment[];
  /** Results for client tool calls, by call id. */
  outputs: Map<string, string>;
  clientTools: { name: string; description: string; parameters: Record<string, unknown> }[];
}

/** What a function tool's result is, as text for the model. */
function outputText(output: unknown): string | undefined {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return undefined;
  const parts = contentOf(output, "output");
  return typeof parts === "string" ? undefined : parts.text;
}

function read(app: App, body: Record<string, unknown>): Read | ReturnType<typeof failure> {
  const agents = app.agentNames;
  let agent: string | undefined;
  if (typeof body.model === "string" && body.model) agent = body.model;
  else if (agents.length === 1) agent = agents[0];
  if (!agent) return invalid("model is required: it names the agent to ask", "model", "missing_required_parameter");
  if (!app.plans[agent]) {
    return invalid(`The requested model '${agent}' does not exist. This app's agents are: ${agents.join(", ") || "none"}.`, "model", "model_not_found");
  }

  if (body.background === true) return invalid("background responses are not supported by this endpoint", "background", "unsupported_parameter");
  const format = isObject(body.text) && isObject(body.text.format) ? body.text.format.type : undefined;
  if (format !== undefined && format !== "text") {
    return invalid(
      `text.format "${String(format)}" is not supported: an agent's output shape is declared by its author (\`returns\`), not per request`,
      "text.format",
      "unsupported_parameter",
    );
  }
  const choice = body.tool_choice;
  if (choice !== undefined && choice !== null && choice !== "auto" && choice !== "none") {
    return invalid('tool_choice must be "auto" or "none" here: an agent decides for itself which tool to call', "tool_choice", "unsupported_parameter");
  }

  const clientTools: Read["clientTools"] = [];
  if (body.tools !== undefined && body.tools !== null) {
    if (!Array.isArray(body.tools)) return invalid("tools must be a list", "tools");
    for (const [index, tool] of body.tools.entries()) {
      if (!isObject(tool) || tool.type !== "function") {
        return invalid(`tools[${index}] is not a function tool; function tools are the only kind a client can supply`, `tools[${index}]`, "unsupported_parameter");
      }
      if (typeof tool.name !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name)) {
        return invalid(`tools[${index}].name must be 1 to 64 letters, digits, "_" or "-"`, `tools[${index}].name`);
      }
      clientTools.push({
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : `Call the client's ${tool.name} function.`,
        parameters: isObject(tool.parameters) ? tool.parameters : { type: "object", properties: {} },
      });
    }
  }

  const preface: string[] = [];
  if (typeof body.instructions === "string" && body.instructions.trim()) preface.push(body.instructions.trim());

  const earlier: Message[] = [];
  const outputs = new Map<string, string>();
  let question = "";
  let attachments: Attachment[] = [];
  /** Whether the last thing in the input was a question, which is what there has to be to answer. */
  let asked = false;

  if (typeof body.input === "string") {
    question = body.input;
    asked = true;
  } else if (Array.isArray(body.input)) {
    for (const [index, item] of body.input.entries()) {
      const at = `input[${index}]`;
      if (!isObject(item)) return invalid(`${at} must be an object`, at);
      const type = item.type ?? (typeof item.role === "string" ? "message" : undefined);

      if (type === "message") {
        const content = contentOf(item.content, at);
        if (typeof content === "string") return invalid(content, at);
        if (item.role === "system" || item.role === "developer") {
          if (content.text.trim()) preface.push(content.text.trim());
          continue;
        }
        if (item.role !== "user" && item.role !== "assistant") return invalid(`${at}.role must be user, assistant, system or developer`, `${at}.role`);
        // A question that was followed by something else is part of the conversation so far.
        if (asked) earlier.push({ role: "user", content: question, ...(attachments.length ? { attachments } : {}) });
        asked = false;
        if (item.role === "assistant") {
          earlier.push({ role: "assistant", content: content.text });
        } else {
          question = content.text;
          attachments = content.attachments;
          asked = true;
        }
      } else if (type === "function_call_output") {
        if (typeof item.call_id !== "string") return invalid(`${at}.call_id is required`, `${at}.call_id`);
        const text = outputText(item.output);
        if (text === undefined) return invalid(`${at}.output must be a string or a list of text parts`, `${at}.output`);
        outputs.set(item.call_id, text);
      } else if (type === "function_call" || type === "reasoning" || type === "compaction") {
        // A call the client is replaying is already on record with the turn that made
        // it, and reasoning and compaction items are the endpoint's own notes, which
        // an agent here does not take from a caller.
        continue;
      } else if (type === "item_reference") {
        return invalid(`${at}: item references are not supported; send the item itself, or continue with previous_response_id`, at, "unsupported_parameter");
      } else {
        return invalid(`${at} is a "${String(type)}" item, which this endpoint does not take`, at);
      }
    }
  } else if (body.input !== undefined && body.input !== null) {
    return invalid("input must be a string or a list of items", "input");
  }

  if (!asked && !outputs.size) {
    return invalid("input must end with a user message, or carry the function_call_output a previous response is waiting for", "input");
  }
  if (asked && outputs.size) {
    return invalid(
      "send a function_call_output on its own: the turn it belongs to has not finished, and the next user message goes in the request after it",
      "input",
    );
  }
  return { agent, preface, earlier, question, attachments, outputs, clientTools };
}

// ── Answering ──────────────────────────────────────────────────────────────────

/** The fields of a response that echo the request, with the specification's defaults where it said nothing. */
function echoOf(body: Record<string, unknown>, agent: string, id: string): ResponseResource {
  const number = (value: unknown, otherwise: number): number => (typeof value === "number" ? value : otherwise);
  const reasoning = isObject(body.reasoning)
    ? {
        effort: typeof body.reasoning.effort === "string" ? body.reasoning.effort : null,
        summary: typeof body.reasoning.summary === "string" ? body.reasoning.summary : null,
      }
    : null;
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    completed_at: null,
    status: "in_progress",
    incomplete_details: null,
    model: agent,
    previous_response_id: typeof body.previous_response_id === "string" ? body.previous_response_id : null,
    instructions: typeof body.instructions === "string" ? body.instructions : null,
    output: [],
    error: null,
    tools: Array.isArray(body.tools)
      ? body.tools.map((tool) => {
          const given = tool as Record<string, unknown>;
          return {
            type: "function",
            name: given.name,
            description: given.description ?? null,
            parameters: given.parameters ?? null,
            strict: given.strict ?? null,
          };
        })
      : [],
    tool_choice: body.tool_choice ?? "auto",
    truncation: typeof body.truncation === "string" ? body.truncation : "disabled",
    parallel_tool_calls: false,
    text: { format: { type: "text" } },
    top_p: number(body.top_p, 1),
    presence_penalty: number(body.presence_penalty, 0),
    frequency_penalty: number(body.frequency_penalty, 0),
    top_logprobs: number(body.top_logprobs, 0),
    temperature: number(body.temperature, 1),
    reasoning,
    usage: null,
    max_output_tokens: typeof body.max_output_tokens === "number" ? body.max_output_tokens : null,
    max_tool_calls: typeof body.max_tool_calls === "number" ? body.max_tool_calls : null,
    store: body.store !== false,
    background: false,
    service_tier: typeof body.service_tier === "string" ? body.service_tier : "default",
    metadata: body.metadata ?? {},
    safety_identifier: typeof body.safety_identifier === "string" ? body.safety_identifier : null,
    prompt_cache_key: typeof body.prompt_cache_key === "string" ? body.prompt_cache_key : null,
  };
}

function usageOf(answer: Answer): NonNullable<ResponseResource["usage"]> {
  return {
    input_tokens: answer.usage.inputTokens,
    output_tokens: answer.usage.outputTokens,
    total_tokens: answer.usage.inputTokens + answer.usage.outputTokens,
    input_tokens_details: { cached_tokens: answer.usage.cachedTokens },
    output_tokens_details: { reasoning_tokens: answer.usage.reasoningTokens ?? 0 },
  };
}

/**
 * One response: read a turn until it ends or stops at a client tool, saying what
 * happens as the standard events.
 *
 * `resource` is the response as it stands, changed as the turn goes; every event that
 * carries the response carries a copy of it as it was at that moment.
 */
async function* segment(
  app: App,
  turn: Turn,
  resource: ResponseResource,
  options: ResponsesOptions,
): AsyncGenerator<ResponseEvent, void, void> {
  let sequence = 0;
  const event = (type: string, fields: Record<string, unknown>): ResponseEvent => ({ type, sequence_number: sequence++, ...fields });
  const snapshot = (): ResponseResource => structuredClone(resource);

  yield event("response.created", { response: snapshot() });
  yield event("response.in_progress", { response: snapshot() });

  /** The message being said, if one is open. */
  let saying: Extract<ResponseItem, { type: "message" }> | undefined;
  /** What the last message that closed said, to know whether the answer repeats it. */
  let lastSaid = "";

  function* open(): Generator<ResponseEvent> {
    saying = { type: "message", id: newId("msg"), status: "in_progress", role: "assistant", content: [] };
    resource.output.push(saying);
    yield event("response.output_item.added", { output_index: resource.output.length - 1, item: structuredClone(saying) });
    saying.content.push({ type: "output_text", text: "", annotations: [] });
    yield event("response.content_part.added", {
      item_id: saying.id,
      output_index: resource.output.length - 1,
      content_index: 0,
      part: structuredClone(saying.content[0]),
    });
  }
  function* say(text: string): Generator<ResponseEvent> {
    if (!saying) yield* open();
    saying!.content[0]!.text += text;
    yield event("response.output_text.delta", {
      item_id: saying!.id,
      output_index: resource.output.length - 1,
      content_index: 0,
      delta: text,
    });
  }
  function* close(): Generator<ResponseEvent> {
    if (!saying) return;
    const item = saying;
    const at = resource.output.indexOf(item);
    saying = undefined;
    lastSaid = item.content[0]!.text;
    yield event("response.output_text.done", { item_id: item.id, output_index: at, content_index: 0, text: lastSaid });
    yield event("response.content_part.done", { item_id: item.id, output_index: at, content_index: 0, part: structuredClone(item.content[0]) });
    item.status = "completed";
    yield event("response.output_item.done", { output_index: at, item: structuredClone(item) });
  }

  for (;;) {
    const happened = await turn.next();

    if (happened.kind === "text") {
      yield* say(happened.text);
      continue;
    }
    // Anything that is not a fragment ends the message being said, as it does on every
    // other stream this app serves.
    yield* close();

    if (happened.kind === "client call") {
      const item: ResponseItem = {
        type: "function_call",
        id: newId("fc"),
        call_id: happened.callId,
        name: happened.name,
        arguments: "",
        status: "in_progress",
      };
      resource.output.push(item);
      const at = resource.output.length - 1;
      yield event("response.output_item.added", { output_index: at, item: structuredClone(item) });
      yield event("response.function_call_arguments.delta", { item_id: item.id, output_index: at, delta: happened.args });
      item.arguments = happened.args;
      yield event("response.function_call_arguments.done", { item_id: item.id, output_index: at, arguments: happened.args });
      item.status = "completed";
      yield event("response.output_item.done", { output_index: at, item: structuredClone(item) });

      // The response is complete: what it asked for is a tool result, and the turn
      // waits here for the request that brings one.
      const held = waitingFor(app);
      held.set(resource.id, turn);
      turn.expireIn(options.toolWaitMs ?? 120_000, () => held.delete(resource.id));
      resource.status = "completed";
      resource.completed_at = Math.floor(Date.now() / 1000);
      yield event("response.completed", { response: snapshot() });
      return;
    }

    if (happened.kind === "done") {
      const text = happened.answer.text;
      // What was just said, fragment by fragment, is the answer. Saying it again whole
      // would give the caller the same text twice.
      if (text && text !== lastSaid) {
        yield* say(text);
        yield* close();
      }
      resource.usage = usageOf(happened.answer);
      resource.status = "completed";
      resource.completed_at = Math.floor(Date.now() / 1000);
      yield event("response.completed", { response: snapshot() });
      return;
    }

    if (happened.kind === "failed") {
      resource.status = "failed";
      resource.error = { code: "server_error", message: safeMessage(new Error(happened.error), "responses") };
      yield event("response.failed", { response: snapshot() });
      return;
    }
    // Routing, checking, the agent's own tool calls: how the answer was arrived at is
    // not something this API has items for, and inventing one would be describing the
    // app's internals in a vocabulary the client did not ask for.
  }
}

/**
 * Answer one `POST /v1/responses`.
 *
 * A request that cannot be served is answered with the standard error envelope and an
 * HTTP status, before anything is streamed. One that can is answered with the response,
 * or, where it asked to `stream`, with the events that build it.
 */
export async function handleResponses(app: App, body: unknown, options: ResponsesOptions = {}): Promise<ResponsesAnswer> {
  if (!isObject(body)) return invalid("the request body must be a JSON object");
  const request = read(app, body);
  if ("status" in request) return request;

  const held = waitingFor(app);
  const previous = typeof body.previous_response_id === "string" ? body.previous_response_id : undefined;
  const store = body.store !== false;
  const notFound = (): ResponsesAnswer =>
    invalid(`Previous response with id '${previous}' not found.`, "previous_response_id", "previous_response_not_found");

  let turn: Turn;

  if (request.outputs.size) {
    // A tool result: it continues the turn that asked for it, and nothing else can.
    const waiting = previous ? held.get(previous) : undefined;
    if (!previous) {
      return invalid("a function_call_output continues a response; send that response's id as previous_response_id", "previous_response_id");
    }
    if (!waiting?.waiting) return notFound();
    if (waiting.agent !== request.agent) {
      return invalid(`response '${previous}' was with the agent '${waiting.agent}', not '${request.agent}'`, "model");
    }
    const output = request.outputs.get(waiting.waiting.callId);
    if (output === undefined || request.outputs.size !== 1) {
      return invalid(`response '${previous}' is waiting for the output of call '${waiting.waiting.callId}', and for nothing else`, "input");
    }
    held.delete(previous);
    turn = waiting;
    turn.answer(output);
  } else {
    // A question. Which conversation it belongs to, and how much of it comes before.
    let thread: string | undefined;
    let turnsBefore = 0;
    if (previous) {
      // A turn that was waiting on a tool and is being talked past is given up: the
      // caller has moved on, and the conversation goes on from where that turn began.
      const abandoned = held.get(previous);
      const chain = abandoned?.thread ? { thread: abandoned.thread, turns: abandoned.turnsAfter - 2 } : chainOf(previous);
      if (abandoned) {
        held.delete(previous);
        abandoned.abandon();
      }
      if (!chain) return notFound();
      const kept = await app.threads.load(chain.thread);
      // A first response whose turn was abandoned has no conversation on record yet.
      if (!kept && !(abandoned && chain.turns === 0)) return notFound();
      if (kept && kept.turns.length < chain.turns) return notFound();
      if (kept && kept.agent !== request.agent) {
        return invalid(`response '${previous}' was with the agent '${kept.agent}', not '${request.agent}'`, "model");
      }
      if (!kept || kept.turns.length === chain.turns) {
        thread = chain.thread;
        turnsBefore = chain.turns;
      } else if (store) {
        // Continuing from a response that is not the latest: the conversation forks
        // there. What came after stays with the conversation it was said in.
        thread = `resp-${randomBytes(12).toString("hex")}`;
        await app.threads.append(thread, request.agent, kept.turns.slice(0, chain.turns).map(({ at: _at, ...message }) => message));
        turnsBefore = chain.turns;
      } else {
        request.earlier.unshift(...kept.turns.slice(0, chain.turns).map(({ at: _at, ...message }) => message));
      }
      if (!store && thread) {
        // Asked not to be kept: what was said before is read, and nothing is added.
        const before = await app.threads.carry(thread);
        request.earlier.unshift(...before);
        thread = undefined;
      }
    } else if (store) {
      thread = `resp-${randomBytes(12).toString("hex")}`;
    }

    // The conversation the request itself carried goes on record ahead of the question.
    if (thread && request.earlier.length) {
      await app.threads.append(thread, request.agent, request.earlier);
      turnsBefore += request.earlier.length;
    }

    if (held.size >= MOST_WAITING) {
      const oldest = held.keys().next().value as string;
      held.get(oldest)?.abandon();
      held.delete(oldest);
    }

    const started = new Turn(request.agent, thread, turnsBefore + 2);
    turn = started;
    const tools: LocalTool[] =
      body.tool_choice === "none"
        ? []
        : request.clientTools.map((tool) => ({
            ...tool,
            // Whatever the client's function does, it does somewhere this app cannot
            // see, so nothing it returns is taken on trust.
            trust: "untrusted" as const,
            run: (args: Record<string, unknown>) => started.call(tool.name, args),
          }));
    const input = [
      request.preface.length ? `Instructions from the caller:\n${request.preface.join("\n\n")}` : "",
      request.question,
    ]
      .filter(Boolean)
      .join("\n\n");
    if (options.signal) options.signal.addEventListener("abort", () => (started.waiting ? undefined : started.abandon()), { once: true });

    // The ask runs behind the responses that report it, because it may outlast one.
    // Its progress is queued in the call that reports it, so that a client tool's call
    // takes its place among the fragments said before it, in the order they happened.
    // Middleware may replace the reply, so where one is installed the fragments are
    // withheld, as `App.watch` withholds them, and the answer is said whole.
    const withheld = Boolean(app.project.middleware);
    void app
      .ask(request.agent, input, {
        ...(thread ? { thread } : { history: request.earlier }),
        task: request.question,
        signal: started.signal,
        onProgress: (event) => (withheld && event.kind === "text" ? undefined : started.push(event)),
        ...(tools.length ? { tools } : {}),
        ...(request.attachments.length ? { attachments: request.attachments } : {}),
        ...(options.person ? { caller: { person: options.person } } : {}),
        surface: "responses",
      })
      .then(
        (answer) => started.push({ kind: "done", answer }),
        // Refused before it began (an unknown agent, an input too long to ask), or failed on the way.
        (err: unknown) => started.push({ kind: "failed", error: (err as Error).message }),
      );
  }

  // An id is announced in the first event, before it is known whether this response
  // will finish the turn or stop at a tool, so one scheme has to serve both: the point
  // the turn will reach, and which response of the turn this is. A response that
  // stopped at a tool is found by its id among the waiting turns; once its turn has
  // finished, the same id reads as the point the turn reached.
  const part = turn.responses++;
  const id = turn.thread ? `${responseId(turn.thread, turn.turnsAfter)}${part ? `s${part}` : ""}` : newId("resp");
  const events = segment(app, turn, echoOf(body, request.agent, id), options);

  if (body.stream === true) return { stream: events };

  let last: ResponseResource | undefined;
  for await (const event of events) {
    const carried = (event as { response?: ResponseResource }).response;
    if (carried) last = carried;
  }
  if (!last) return failure(500, "server_error", "the response ended without saying how");
  if (last.status === "failed") return failure(500, "server_error", last.error?.message ?? "the agent failed to answer");
  return { status: 200, body: last };
}

/** One event as an SSE frame: the type in `event:`, as the specification requires, and no `id:`. */
export function responsesFrame(event: ResponseEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
