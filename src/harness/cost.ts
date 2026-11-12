/**
 * What a request cost in money, where the app said what its models charge.
 *
 * The framework ships no model ids and so it ships no prices: a price list written into
 * it would be wrong within the month, and wrong in the direction nobody checks. An
 * endpoint declares what a million tokens cost on each of its models, in a currency it
 * names, and everything here is arithmetic over that declaration. An endpoint that
 * declared nothing is not priced at zero — it is not priced, and the difference is kept
 * all the way up: an answer carries a cost only where one was worked out.
 *
 * Amounts are kept per currency rather than as one number. A ladder may cross endpoints
 * billed in different currencies, and adding dollars to euros produces a figure that is
 * precise, plausible and meaningless.
 */

import type { Money, Prices, Quality, Rates } from "../define.js";

/** What one rung charges: the rates for its model, and the currency they are in. */
export interface Price extends Rates {
  currency: string;
}

/** Money spent, by currency code. */
export type Cost = Record<string, number>;

/** The token counts a price is applied to. Cached, written and reasoning tokens are parts of the two totals. */
export interface Counted {
  inputTokens: number;
  outputTokens: number;
  /** Tokens spent on a model with no declared price, on a ladder where another has one. */
  unpricedTokens?: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

const PER = 1_000_000;

const rate = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * The price of one rung's model, from what its endpoint declared.
 *
 * `named` is the rung whose model name this rung ended up running on — an endpoint that
 * names only `balanced` runs every rung on it, and every rung is then charged what
 * `balanced` costs. A declaration that is not a currency and two usable numbers is no
 * declaration: nothing is priced on a guess at what was meant.
 */
export function priceFor(prices: Prices | undefined, named: Quality | undefined): Price | undefined {
  if (!prices || !named) return undefined;
  const rates = prices[named];
  const currency = typeof prices.currency === "string" ? prices.currency.trim().toUpperCase() : "";
  if (!rates || !currency || !rate(rates.input) || !rate(rates.output)) return undefined;
  return {
    currency,
    input: rates.input,
    output: rates.output,
    ...(rate(rates.cachedRead) ? { cachedRead: rates.cachedRead } : {}),
    ...(rate(rates.cacheWrite) ? { cacheWrite: rates.cacheWrite } : {}),
    ...(rate(rates.reasoning) ? { reasoning: rates.reasoning } : {}),
  };
}

/**
 * What these tokens cost at this price.
 *
 * Every wire reports cache reads and cache writes inside `inputTokens`, and reasoning
 * inside `outputTokens`, so each is taken out of its total before it is charged at its
 * own rate — and charged at the plain rate where the endpoint declared no other, which
 * is what an endpoint that does not distinguish them bills.
 */
export function amountOf(usage: Counted, price: Price): number {
  const read = Math.min(usage.cachedTokens ?? 0, usage.inputTokens);
  const written = Math.min(usage.cacheWriteTokens ?? 0, usage.inputTokens - read);
  const thought = Math.min(usage.reasoningTokens ?? 0, usage.outputTokens);
  return (
    ((usage.inputTokens - read - written) * price.input +
      read * (price.cachedRead ?? price.input) +
      written * (price.cacheWrite ?? price.input) +
      (usage.outputTokens - thought) * price.output +
      thought * (price.reasoning ?? price.output)) /
    PER
  );
}

/** Add one call's cost to a running total. Nothing is added, and nothing created, where there is no price. */
export function charge(into: { cost?: Cost }, price: Price | undefined, usage: Counted): void {
  if (!price) return;
  const cost = (into.cost ??= {});
  cost[price.currency] = (cost[price.currency] ?? 0) + amountOf(usage, price);
}

/** Add one total to another, currency by currency. */
export function addCost(into: { cost?: Cost }, from: Cost | undefined): void {
  if (!from) return;
  const cost = (into.cost ??= {});
  for (const [currency, amount] of Object.entries(from)) cost[currency] = (cost[currency] ?? 0) + amount;
}

/** How much of a total is in the currency a limit is stated in. */
export function spentIn(cost: Cost | undefined, limit: Money): number {
  return cost?.[limit.currency.trim().toUpperCase()] ?? 0;
}

/**
 * Why a spending limit cannot be held against this usage, or nothing if it can.
 *
 * A limit in money only means something if everything spent under it was priced, and
 * priced in the limit's own currency. Tokens no price covered are spend the limit
 * cannot see, so they are a reason to stop rather than a zero.
 */
export function unpriced(usage: Counted & { cost?: Cost }, limit: Money): string | undefined {
  const currency = limit.currency.trim().toUpperCase();
  const others = Object.keys(usage.cost ?? {}).filter((code) => code !== currency);
  if (others.length) return `part of it was priced in ${others.join(", ")}, not ${currency}`;
  if (usage.unpricedTokens) return `part of it was answered by a model with no declared price`;
  if (usage.inputTokens + usage.outputTokens > 0 && usage.cost?.[currency] === undefined) {
    return `the model that answered has no declared price in ${currency}`;
  }
  return undefined;
}

/** An amount as it is written in a sentence: enough places to see a fraction of a cent. */
export function money(amount: number, currency: string): string {
  return `${Number(amount.toFixed(6))} ${currency.trim().toUpperCase()}`;
}
