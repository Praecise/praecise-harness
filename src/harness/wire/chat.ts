import type { ChatAdapter, ChatRequest, ChatResponse, Message, ToolCall } from "../types.js";
import { ProviderError } from "../types.js";
import { levelOf } from "./effort.js";
import { Fragments, events } from "./sse.js";

/**
 * How long a stream may go quiet before the endpoint counts as gone.
 *
 * A request with no clock on it is not patient, it is indefinite: a server that accepts
 * a connection and then stops writing holds the caller until something else gives up,
 * and on a single-slot endpoint it holds the slot too. Measured between FRAMES rather
 * than over the whole answer, because a long answer arriving steadily is the endpoint
 * working and a short answer that stopped halfway is the endpoint hung, and only the
 * gap between frames tells those apart.
 */
const IDLE_MS = 45_000;

/**
 * How long a request that will arrive in one piece may take.
 *
 * Nothing is observable until it lands, so there are no frames to measure the gaps
 * between and the only honest clock is one on the whole thing. Generous, because a
 * thinking model with a full budget genuinely does take minutes.
 */
const TOTAL_MS = 240_000;

/**
 * The completion ceiling for a request that names none.
 *
 * The messages wire has always defaulted this and this one did not, so a chat request
 * decoded without bound — one runaway answer can hold an endpoint that serves one
 * request at a time for as long as it cares to keep writing. A default is not a
 * judgement about how long an answer should be; it is the difference between a request
 * that ends and one that might not.
 */
const CEILING = 4_096;

/**
 * The least room a request that asks for thinking may be given.
 *
 * On a thinking endpoint the completion budget is one pool, spent on the reasoning
 * first and on the answer with whatever is left. Ask for depth and sixteen tokens and
 * the whole of it goes on thought, and what comes back is an empty string billed as
 * work. `starvedOfBudget` in interactions.ts names that after the fact; this stops it
 * happening, which is the cheaper of the two.
 */
const THINKING_FLOOR = 512;

/** A clock's length, overridable per deployment, ignoring anything that is not a positive number. */
function clockMs(name: string, fallback: number): number {
  const ms = Number(process.env[name]);
  return Number.isFinite(ms) && ms > 0 ? ms : fallback;
}

/**
 * A deadline that can be pushed forward, composed with whatever the caller already holds.
 *
 * Composed rather than substituted: a caller that passed a signal is still entitled to
 * cancel, and a wire that quietly replaced it would make an abort button stop working.
 * Which of the two ended the request is worth keeping — the caller's own cancellation is
 * theirs to handle, and only the clock's is turned into a provider failure.
 */
class Clock {
  readonly signal: AbortSignal;
  readonly ms: number;
  private readonly why: string;
  private readonly own = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private fired = false;

  constructor(ms: number, why: string, caller?: AbortSignal) {
    this.ms = ms;
    this.why = why;
    this.signal = caller ? AbortSignal.any([caller, this.own.signal]) : this.own.signal;
  }

  /** Start the countdown, or start it again from now. */
  arm(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.fired = true;
      this.own.abort();
    }, this.ms);
  }

  stop(): void {
    clearTimeout(this.timer);
  }

  /** Whether it was this clock that ended the request rather than the caller. */
  get expired(): boolean {
    return this.fired;
  }

  /**
   * The failure a timeout is reported as.
   *
   * Deliberately the shape a dead endpoint already produces, status and all. The router
   * reads a provider failure as this rung not answering and crosses to the next one; a
   * timeout is the same fact arriving more slowly, and giving it a shape of its own would
   * only mean somewhere upstream learning to treat it the same way again.
   */
  expiry(): ProviderError {
    return new ProviderError("chat", 0, `${this.why} within ${this.ms}ms`);
  }
}

interface RequestToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface RequestMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: RequestToolCall[];
  tool_call_id?: string;
}

interface ResponseToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface ResponsePayload {
  choices?: {
    message?: { content?: string | null; tool_calls?: ResponseToolCall[] };
    finish_reason?: string;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

function toMessages(system: string, messages: Message[]): RequestMessage[] {
  const out: RequestMessage[] = [];
  if (system) out.push({ role: "system", content: system });

  for (const message of messages) {
    if (message.role === "tool") {
      out.push({
        role: "tool",
        content: message.content ?? "",
        tool_call_id: message.toolCallId ?? "",
      });
      continue;
    }

    const entry: RequestMessage = { role: message.role, content: message.content ?? "" };
    if (message.role === "assistant" && message.toolCalls?.length) {
      entry.tool_calls = message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
      }));
    }
    out.push(entry);
  }

  return out;
}

function parseArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export const chatWire: ChatAdapter = async (request: ChatRequest): Promise<ChatResponse> => {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: toMessages(request.system, request.messages),
  };

  /**
   * Whether this request asks for depth the provider said this endpoint can give.
   *
   * `planModels` sets effort to 1 on the balanced and best rungs regardless of what the
   * provider declared, so the effort number alone was never evidence about the endpoint.
   */
  const thinking = request.effort > 0 && (request.depth === "effort" || request.depth === "budget");

  // `depth` is how the endpoint takes a request for more room, as the PROVIDER declared
  // it, and only one of the three ways is this field. This wire ignored the declaration
  // and sent `reasoning_effort` to every endpoint whose effort was above zero; a
  // self-hosted server rejects the field outright rather than ignoring it, so a rung that
  // declared it takes no reasoning parameter could not be reached at all. An endpoint
  // that takes depth as a token budget must not be sent it either — it is the same
  // unknown field there, differing only in which of the two the author had in mind.
  // Undeclared is not a declaration, and this wire's own default for an undeclared
  // provider is "none", so silence means the field stays off.
  if (thinking && request.depth === "effort") {
    body.reasoning_effort = levelOf(request.effort);
  }

  // Every request leaves here with a ceiling on it, whether or not the caller set one.
  // Without it a reply decodes until the endpoint decides to stop, which on an endpoint
  // serving one request at a time is a slot held for as long as the answer rambles.
  // A thinking request gets a floor as well: the budget covers the reasoning and the
  // reply out of one pool, and one too small to hold both is spent entirely on the first.
  const ceiling = request.maxTokens ?? CEILING;
  body.max_completion_tokens = thinking ? Math.max(ceiling, THINKING_FLOOR) : ceiling;
  // With a schema this is constrained decoding, and on this shape `strict` lives INSIDE
  // a named json_schema wrapper — unlike the responses shape, where it sits beside the
  // schema. Same vendor, same feature, different nesting; getting it wrong does not error,
  // it just quietly stops constraining, which is the failure that makes a guarantee useless.
  if (request.schema) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "reply", strict: true, schema: request.schema },
    };
  } else if (request.json) {
    body.response_format = { type: "json_object" };
  }

  if (request.tools?.length) {
    body.tools = request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  // Usage is left out of a stream unless it is asked for, and a request whose
  // cost cannot be accounted for is one the router cannot learn from.
  if (request.onText) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }

  // A streamed answer is watched between frames; one that arrives whole is watched as a
  // whole, because until it lands there is nothing to measure the gaps between.
  const clock = request.onText
    ? new Clock(clockMs("PRAECISE_WIRE_IDLE_MS", IDLE_MS), "the endpoint sent nothing further", request.signal)
    : new Clock(clockMs("PRAECISE_WIRE_TOTAL_MS", TOTAL_MS), "the endpoint did not answer", request.signal);
  clock.arm();

  try {
    const response = await request.fetch(`${request.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: headersFor(request),
      // Whatever the provider declared this endpoint needs sits UNDER what the wire
      // built, so a field in a config can fill a gap the protocol does not name and
      // cannot quietly replace the model or the conversation.
      body: JSON.stringify(request.body ? { ...request.body, ...body } : body),
      signal: clock.signal,
    });

    if (!response.ok) {
      throw new ProviderError("chat", response.status, await response.text());
    }

    if (request.onText) return await readStream(response, request.onText, clock);

    const payload = (await response.json()) as ResponsePayload;
    const choice = payload.choices?.[0];

    const toolCalls: ToolCall[] = (choice?.message?.tool_calls ?? []).map((call) => ({
      id: call.id ?? "",
      name: call.function?.name ?? "",
      args: parseArguments(call.function?.arguments),
    }));

    return {
      text: choice?.message?.content ?? "",
      toolCalls,
      usage: {
        inputTokens: payload.usage?.prompt_tokens ?? 0,
        outputTokens: payload.usage?.completion_tokens ?? 0,
        cachedTokens: payload.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      },
      finishReason: choice?.finish_reason,
    };
  } catch (error) {
    // An abort raised by the clock is this endpoint failing to answer and is reported as
    // that. One raised by the caller's own signal is not: it is the caller cancelling,
    // and dressing it up as a provider failure would send the router looking for another
    // model to run a request nobody wants any more.
    if (clock.expired && !(error instanceof ProviderError)) throw clock.expiry();
    throw error;
  } finally {
    clock.stop();
  }
};

/**
 * Where the credential goes, and anything else this endpoint insists on.
 *
 * An endpoint you host yourself may need no credential at all. An empty key here would
 * send `Bearer ` — a malformed header that some servers reject and others record as a
 * failed auth attempt, so the absence has to be expressed by leaving the header out
 * rather than by sending an empty one. Others take a credential but not a bearer, and
 * read one as an anonymous caller; those name the header they want, and the credential
 * still comes from the environment rather than through the app's hands.
 *
 * Declared headers are applied last, so an app can correct anything above them.
 */
function headersFor(request: ChatRequest): Record<string, string> {
  const credential = request.credentialHeader ?? "authorization";
  const value = request.credentialHeader ? request.apiKey : `Bearer ${request.apiKey}`;
  return {
    ...(request.apiKey ? { [credential]: value } : {}),
    "content-type": "application/json",
    ...request.headers,
  };
}

/** This wire streams the same envelope, with `delta` where `message` would be. */
interface StreamChunk {
  choices?: {
    delta?: {
      content?: string | null;
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: ResponsePayload["usage"];
}

/**
 * Read the stream, and keep whatever arrived if it stops arriving.
 *
 * The frames are drawn one at a time rather than with `for await` so that the answer
 * built so far survives the iterator throwing. A stream that dies halfway used to take
 * the text with it, which is the worst of the three outcomes available: the caller has
 * already been shown those words, they were paid for, and the reply they came from was
 * then discarded in favour of an error. What comes back instead is the partial answer,
 * marked as cut short in `finishReason` and explained in a note, so nothing downstream
 * mistakes it for a model that chose to stop there.
 */
async function readStream(
  response: Response,
  onText: (text: string) => void,
  clock: Clock,
): Promise<ChatResponse> {
  const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  const fragments = new Fragments();
  const frames = events(response.body);
  let text = "";
  let finishReason: string | undefined;
  /** Set when the stream ended before the endpoint said it had finished. */
  let cut: string | undefined;

  try {
    for (;;) {
      const next = await frames.next();
      if (next.done) break;
      // A frame is evidence the endpoint is still working, so the idle clock starts
      // again from here. Measured from the last frame rather than from the request,
      // a long answer arriving steadily never runs out of time.
      clock.arm();
      const chunk = next.value as StreamChunk;

      if (chunk.usage) {
        usage.inputTokens = chunk.usage.prompt_tokens ?? usage.inputTokens;
        usage.outputTokens = chunk.usage.completion_tokens ?? usage.outputTokens;
        usage.cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? usage.cachedTokens;
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;

      const content = choice.delta?.content;
      if (content) {
        text += content;
        onText(content);
      }

      for (const call of choice.delta?.tool_calls ?? []) {
        const at = call.index ?? 0;
        if (call.id || call.function?.name) fragments.open(at, call.id ?? "", call.function?.name ?? "");
        if (call.function?.arguments) fragments.push(at, call.function.arguments);
      }
    }
  } catch (error) {
    // Nothing arrived, so there is nothing to salvage and this is simply a rung that did
    // not answer — the same failure, and the same shape, as an endpoint that never
    // opened the stream at all.
    if (!text) throw clock.expired ? clock.expiry() : error;
    cut = clock.expired
      ? `the endpoint stopped sending after ${text.length} character(s) and nothing further arrived within ${clock.ms}ms; this answer is what had already been said`
      : `the stream ended before the endpoint finished (${(error as Error).message}); this answer is what had already been said`;
  } finally {
    // Return the iterator whichever way the loop left, so the body is released rather
    // than held open by a generator nobody is drawing from.
    await frames.return(undefined);
  }

  const toolCalls: ToolCall[] = fragments.done().filter((call) => call.name);
  return {
    text,
    toolCalls,
    usage,
    // "timeout" rather than whatever the endpoint last said, because it did not say it
    // had finished, and a caller reading `finishReason` is asking exactly that.
    finishReason: cut ? "timeout" : finishReason,
    ...(cut ? { notes: [cut] } : {}),
  };
}
