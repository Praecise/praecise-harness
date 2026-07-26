/**
 * How much room a request asks for, said the way each endpoint takes it.
 *
 * The router works in one number because that is the only thing it can reason
 * about: how far into what this rung can do the request reaches. Endpoints take
 * that as a named level or as a token budget, and which of the two is a fact
 * about the endpoint rather than about the request.
 */

/** Least depth worth asking for. Below this an endpoint has no room to use it. */
const LEAST = 1_024;

/** Most any one request may be given, however hard it looked. */
const MOST = 8_192;

export type Level = "low" | "medium" | "high";

export function levelOf(effort: number): Level {
  return effort >= 0.66 ? "high" : effort >= 0.33 ? "medium" : "low";
}

export function budgetOf(effort: number): number {
  return Math.round(LEAST + (MOST - LEAST) * Math.min(1, Math.max(0, effort)));
}
