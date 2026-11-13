/**
 * Asked before every model call, and told what each one cost.
 *
 * Prices say what a request cost once it is over (`usage.cost`), and a spending limit
 * stops a workflow run that has gone past one. Neither can say no to the next call: an
 * app that sells its agents by the request, or caps what one customer may spend in a
 * day, has to be asked before the tokens are bought, by something that knows who they
 * are being bought for. That is the meter. It is the app's, like the guard, and it is
 * asked the way the guard is: say nothing and the call is made, answer with a sentence
 * and it is not.
 *
 * A refusal is not a failure of the model, so nothing is retried and nothing climbs. The
 * request ends with `MeterRefused`, carrying the sentence, and whatever had already been
 * spent on it has already been settled.
 *
 * `settle` is called once for every call that was reserved, whether it answered or
 * threw, so a meter that holds a reservation can always let go of it.
 */

import type { Money, Quality } from "../define.js";
import { amountOf, type Price } from "./cost.js";
import { tokens } from "./budget.js";
import type { AskCaller, ChatRequest, ChatResponse } from "./types.js";

/**
 * What a call is for.
 *
 *   "answer"        — a rung working on the request: its first reply and every tool turn after it
 *   "sample"        — the same question asked again, to check an answer against itself
 *   "summary"       — notes on a stretch of work that has outgrown its room
 *   "advice"        — the strongest rung consulted by an agent answering on a cheaper one
 *   "transcription" — a recording written down for a rung that cannot hear
 *   "classifier"    — the permission classifier deciding on a tool call
 */
export type CallPurpose = "answer" | "sample" | "summary" | "advice" | "transcription" | "classifier";

/** One model call about to be made, as a meter is shown it. */
export interface MeteredCall {
  /** Unique to this call, and the same in `reserve` and `settle`. */
  id: string;
  /** The agent the call is made for. An agent another agent asked is named itself. */
  agent: string;
  purpose: CallPurpose;
  /** The endpoint, as named in `models`, and the model on it. */
  provider: string;
  model: string;
  /** Which rung of the ladder that model is. */
  rung: Quality;
  /** Who the request is for and what the app sent with it. See `AskOptions`. */
  caller?: AskCaller;
  context?: unknown;
  /**
   * What the call is expected to take. `inputTokens` is counted from what is being
   * sent, roughly; `outputTokens` is the most the reply may be, where the endpoint or
   * the request says; `cost` is both at the endpoint's declared price, where it
   * declared one. An upper estimate, not a quote.
   */
  estimate: { inputTokens: number; outputTokens?: number; cost?: Money };
}

/** What a call took, as the endpoint reported it. All zero for a call that failed before answering. */
export interface MeteredUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  /** At the endpoint's declared price, where it declared one. */
  cost?: Money;
}

/**
 * The app's say over what is spent on models.
 *
 * `reserve` is asked before every model call the runtime makes for the app: each rung's
 * reply and every tool turn, the samples drawn to check an answer, a deeper pass, a
 * climb, a summary of long work, an advisor consulted, a recording transcribed, and all
 * of those again for an agent another agent asked or started in the background. Answer
 * with nothing to let the call be made, or with a sentence to refuse it; a `reserve`
 * that throws is read as a refusal. `settle` follows every call that was let through.
 */
export interface Meter {
  reserve(call: MeteredCall): string | undefined | void | Promise<string | undefined | void>;
  /** `error` is set when the call threw; `usage` is then all zero. */
  settle?(call: MeteredCall, usage: MeteredUsage, error?: unknown): void | Promise<void>;
}

/** The meter said no. Ends the request; not a provider failure, and never climbed past. */
export class MeterRefused extends Error {
  readonly call: MeteredCall;
  /** The sentence the meter answered with. */
  readonly reason: string;
  constructor(call: MeteredCall, reason: string) {
    super(
      `the meter refused a model call for agent "${call.agent}" (${call.provider}/${call.model}, ${call.purpose}): ${reason}`,
    );
    this.name = "MeterRefused";
    this.call = call;
    this.reason = reason;
  }
}

/** One request reached the number of model calls it may make. See `AskOptions.maxCalls`. */
export class CallLimitReached extends Error {
  readonly limit: number;
  constructor(limit: number, agent: string) {
    super(
      `this request has made ${limit} model call${limit === 1 ? "" : "s"}, which is the most one request may make ` +
        `(\`maxCalls\`, or \`limits.calls\`); the next one, for agent "${agent}", was not made`,
    );
    this.name = "CallLimitReached";
    this.limit = limit;
  }
}

/**
 * The model calls one request has made, counted across every agent it reaches.
 *
 * Shared with an agent this one asks and with one it starts in the background, so a
 * limit on a request is a limit on the whole of it and not on each level of it.
 */
export class Tally {
  calls = 0;
  readonly max?: number;
  /** Set once the meter has refused: every later call of the request is refused with it. */
  stopped?: MeterRefused;
  constructor(max?: number) {
    this.max = typeof max === "number" && Number.isFinite(max) && max >= 0 ? Math.trunc(max) : undefined;
  }
}

let made = 0;

/** A rough count of what a request sends, and the most it may get back, priced where there is a price. */
export function estimateOf(request: ChatRequest, price?: Price, output?: number): MeteredCall["estimate"] {
  let inputTokens = tokens(request.system);
  for (const message of request.messages) {
    inputTokens += tokens(message.content) + 4;
    if (message.toolCalls?.length) inputTokens += tokens(JSON.stringify(message.toolCalls));
  }
  if (request.tools?.length) inputTokens += tokens(JSON.stringify(request.tools));
  const outputTokens = request.maxTokens ?? output;
  return {
    inputTokens,
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(price
      ? { cost: { amount: amountOf({ inputTokens, outputTokens: outputTokens ?? 0 }, price), currency: price.currency } }
      : {}),
  };
}

/** Where a call is being made: enough to describe it to a meter. */
export interface CallSite {
  agent: string;
  purpose: CallPurpose;
  provider: string;
  model: string;
  rung: Quality;
  price?: Price;
  /** The most a reply from this endpoint may be, where it said. */
  output?: number;
  caller?: AskCaller;
  context?: unknown;
}

const NOTHING: MeteredUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };

/**
 * Make one model call under a request's tally and the app's meter.
 *
 * The count is checked first, so a request past its limit does not trouble the meter
 * for a reservation it could not use. A `settle` that throws is dropped: the call has
 * been made and paid for, and an answer already in hand is not failed by bookkeeping.
 */
export async function meteredCall(
  meter: Meter | undefined,
  tally: Tally,
  site: CallSite,
  request: ChatRequest,
  ask: (request: ChatRequest) => Promise<ChatResponse>,
): Promise<ChatResponse> {
  if (tally.stopped) throw tally.stopped;
  if (tally.max !== undefined && tally.calls >= tally.max) throw new CallLimitReached(tally.max, site.agent);
  tally.calls++;
  if (!meter) return ask(request);

  const call: MeteredCall = {
    id: `call-${Date.now().toString(36)}-${(++made).toString(36)}`,
    agent: site.agent,
    purpose: site.purpose,
    provider: site.provider,
    model: site.model,
    rung: site.rung,
    ...(site.caller !== undefined ? { caller: site.caller } : {}),
    ...(site.context !== undefined ? { context: site.context } : {}),
    estimate: estimateOf(request, site.price, site.output),
  };

  let said: string | undefined | void;
  try {
    said = await meter.reserve(call);
  } catch (err) {
    // Asked whether to spend, the meter did not manage to say yes.
    said = `the meter could not be asked (${(err as Error)?.message ?? String(err)})`;
  }
  if (typeof said === "string" && said.trim()) {
    tally.stopped = new MeterRefused(call, said.trim());
    throw tally.stopped;
  }

  const settle = async (usage: MeteredUsage, error?: unknown): Promise<void> => {
    try {
      await meter.settle?.(call, usage, error);
    } catch {
      // The call is made either way; see above.
    }
  };

  let reply: ChatResponse;
  try {
    reply = await ask(request);
  } catch (err) {
    await settle(NOTHING, err);
    throw err;
  }
  await settle({
    ...reply.usage,
    ...(site.price ? { cost: { amount: amountOf(reply.usage, site.price), currency: site.price.currency } } : {}),
  });
  return reply;
}
