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

/** The three words every endpoint that takes a word for depth accepts. */
export const LEVELS: readonly Level[] = ["low", "medium", "high"];

/**
 * Effort 0..1 as one of the words an endpoint takes, shallowest first.
 *
 * Endpoints have grown words above `high`, and which of them a given model accepts is a
 * fact about the endpoint — one rejects `max`, another rejects `minimal`. So the words
 * are the provider's to declare and the scale is divided evenly among however many it
 * named: three words keep the thirds this always used, and five put full effort on the
 * fifth.
 */
export function levelOf(effort: number, levels: readonly string[] = LEVELS): string {
  const words = levels.length ? levels : LEVELS;
  const at = Math.floor(Math.min(1, Math.max(0, effort)) * words.length + 0.02);
  return words[Math.min(words.length - 1, at)]!;
}

export function budgetOf(effort: number): number {
  return Math.round(LEAST + (MOST - LEAST) * Math.min(1, Math.max(0, effort)));
}
