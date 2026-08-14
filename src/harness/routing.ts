/**
 * Which model a request goes to, how much depth it is given, and when that
 * choice is revisited.
 *
 * ── The one constraint everything here answers to ──────────────────────────────
 *
 * ESCALATE ALONG DEPTH BEFORE ESCALATING ACROSS MODELS. A deeper pass on the rung
 * already answering costs one call on a warm prefix cache. Crossing to another model
 * costs one call on a cold one, because a cache belongs to the model that filled it,
 * and it costs it whether or not the crossing turns out to have been needed. Those are
 * not the same price and the old shape of this module priced them as though they were:
 * it treated a k-sample check as free and the cold re-read as total, which is exactly
 * backwards. Checking k times costs k× the cheap rung outright; the cold re-read costs
 * C/S, twenty to thirty per cent on a normal ladder. See `SAMPLES` for the arithmetic
 * that forced this round.
 *
 * Four things fall out of that one change, which is why it is the change rather than
 * one of four. It removes the k multiplier, because a depth step is one call and not k.
 * It removes the cold re-read, because nothing switches model. It removes the standing
 * dependence on measured agreement, a signal that DECAYS as models improve — on hard
 * benchmarks a frontier model agrees with itself at 0.8 or above on most items and is
 * wrong on nearly half of those agreements — because the second answer is now a better
 * answer rather than a repeat. And it spends the escalation through a provider-native
 * per-request control that is generally available, rather than a mechanism this
 * framework invented and has to defend alone.
 *
 * The granularity follows from what each move costs to undo. DEPTH is per request:
 * cheap, cache-preserving, reversible, so it moves per request. MODEL is per task:
 * cache-destroying and not reversible within a request, so it moves only on a signal
 * strong enough to have earned it. And escalation is triggered on the OUTPUT, after the
 * fact — never on the prompt alone, which is a guess dressed as a measurement.
 *
 * ── What the router cannot learn, and the one line that fixes it ───────────────
 *
 * `Ledger` records what was chosen. Until it also records HOW LIKELY that choice was,
 * it can be read for exactly one thing: given that a request escalated, was the escalation
 * worth it. It cannot be read for whether escalating was RIGHT, because a deterministic
 * rule gives every unchosen rung a propensity of exactly zero — inverse propensity
 * weighting is severely biased there, and the doubly-robust form degenerates silently
 * into a plain regression with no correction term and no way to notice it has. Fitting
 * that regression is the trap: its errors correlate with the rule that produced the log,
 * so the offline number improves while nothing real does.
 *
 * `Exploration` is the fix and it is small: send a known, bounded share of decisions to
 * a rung the policy would not have chosen, and write the propensity down. That turns
 * {0, 1} into {ε, 1−ε}, which is the difference between a log that can be evaluated and
 * one that cannot. It is off unless an operator turns it on — see `EXPLORATION`.
 *
 * `quality` stays the only thing an AUTHOR sets. What an OPERATOR sets is
 * `preference` — cost, balanced, or quality — because the tradeoff between
 * paying less and answering better is genuinely theirs and not the framework's
 * to assume. Under `quality` none of the machinery above runs at all: the
 * strongest rung answers at full depth and nothing is checked, because checking
 * exists to decide whether to climb.
 *
 * One thing this module deliberately does NOT do: fuse measured agreement with a
 * model's own verbalised confidence. The result that pairing rests on comes from a
 * paper whose own numbers did not survive a second reading of its sampling grid, and
 * hard-coding a threshold from an unverified figure is the failure this codebase keeps
 * finding in other people's routers.
 */

import { appendFile, mkdir, open, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Preference } from "../define.js";

/**
 * Answers compared when a rung is checked and has NO depth left to add.
 *
 * This is the fallback, not the mechanism. Where the rung can be asked again at a
 * greater depth, the check and the escalation are the same call: ask once more with
 * more room, compare the two, and if they disagree the deeper answer is already in hand
 * and is the one kept. That is one extra call which buys both a signal and a better
 * answer. k identical repeats buy only the signal, and buy it k times over.
 *
 * ── The arithmetic that demoted this constant ─────────────────────────────────
 *
 * Checking k times costs k× the cheap rung. With C and S the cheap and strong input
 * prices and p the share of requests that escalate, cascading beats going straight to
 * the strong model only while `p < 1 - k·C/S`. That is not a wide margin:
 *
 *   cheap:strong 1:5   k=1 → p<80%   k=2 → p<60%   k=3 → p<40%
 *   cheap:strong 1:3   k=1 → p<67%   k=2 → p<33%   k=3 → never pays
 *   cheap:strong 3:5   k=1 → p<40%   k=2 → never   k=3 → never
 *
 * At the values below — two samples, three on a long prompt — a ladder whose rungs sit
 * at 3:5 or 1:3 loses at EVERY escalation rate. There is no p that rescues it. So the
 * repeat-sampling check is not the router's instrument; it is what is left when the rung
 * answering has been capped at zero depth and there is nothing cheaper to try. Which
 * rungs those are is decided in `compile/models.ts`, not here.
 *
 * Never one — one sample is not a check. Never many: three answers already settle
 * whether a model is repeating itself or improvising, and a fourth is the arithmetic
 * above getting worse.
 */
const SAMPLES = { least: 2, most: 3 } as const;

/**
 * The depths an endpoint can actually tell apart, ascending.
 *
 * Three, and three is not a taste: a provider takes depth as a named level, and the
 * wire renders this number into one of three of them. A ladder with more steps than
 * that sends two identical requests and pays twice for one answer. The cuts mirror
 * `levelOf` in `wire/effort.ts`; a test pins the two together rather than an import,
 * because the coupling is a fact to be checked and not a dependency to be taken.
 *
 * The top step is 1 rather than the top cut, so that an endpoint taking depth as a
 * token budget gets a real increase at the top of the ladder and not a rounding one.
 */
const DEPTHS = [0, 0.33, 0.66] as const;

/**
 * The share of decisions to send somewhere the policy would not have sent them.
 *
 * Shipped as a number rather than as a default, because randomising a live app's
 * routing is a purchase — a known slice of the bill spent on evidence — and a framework
 * that makes that purchase on an operator's behalf has spent money it was not given.
 * There is a second cost that is easy to miss: routing that is nondeterministic by
 * default makes every test above it flaky and every "why did this go to the expensive
 * model" unanswerable. Both are borne by whoever runs the app, so both are theirs to
 * accept. Two per cent is the value to accept: enough overlap to estimate with, small
 * enough that the worst case is a rounding error on a bill.
 */
export const EXPLORATION = 0.02;

/**
 * The most exploration that will be honoured, whatever is asked for.
 *
 * The point of ε-greedy here is a cost that is bounded and knowable BEFORE it is spent.
 * A cap is what makes that sentence true no matter what someone types into a config
 * file at four in the morning. Five per cent is the top of the range the exploration
 * literature treats as routine for a live system.
 */
const EXPLORE_CAP = 0.05;

/** How close to the top of its band a request must sit before it is checked. */
const VERIFY_MARGIN = 0.12;

/** Agreement required to keep a cheap answer, before the cost of climbing is priced in. */
const BASE_BAR = 0.6;

/** How far an agent's own history is allowed to move the estimate. */
const LEAN = 0.15;

/** Climbs that must have been settled either way before history is leaned on. */
const ENOUGH = 4;

/** Below this much difference, a stronger model said what the cheaper one said. */
const SAME_ANSWER = 0.25;

/** Characters of prompt at which a re-read counts as fully expensive. */
const REREAD_FULL = 40_000;

/** Characters of question at which length alone is a real risk of getting it wrong. */
const LONG = 2_000;

/** Tail of the record read back at startup, enough to be recent without being everything. */
const TAIL_BYTES = 64 * 1024;

const saturate = (value: number): number => (value <= 0 ? 0 : value >= 1 ? 1 : value);

/**
 * What can be known about a request without reading it — which is to say,
 * without spending anything. Every one of these is a count.
 */
export interface Shape {
  /**
   * Characters of the request itself.
   *
   * NOT a difficulty term, and it used to be the heaviest one. Length is a FAILURE-RISK
   * axis: controlling for difficulty, a longer prompt still predicts a wrong answer.
   * Loading it as difficulty conflated two things that behave differently and scored the
   * short-but-hard question — the one where being wrong costs most — as easy. It is read
   * by `riskOf` instead, where it widens the margin at which an answer is worth checking
   * rather than moving which model the request starts on.
   */
  asked: number;
  /** Characters read before answering can start: instructions, recall, history. */
  carried: number;
  /** Turns of conversation behind this one. */
  turns: number;
  /** Tools the model has to choose between. */
  tools: number;
  /**
   * Whether the answer has to come back in a declared shape.
   *
   * NOT a difficulty term, and it used to be one. A declared shape is sent to the
   * endpoint as a schema it decodes under, so a reply outside that shape is unreachable
   * rather than merely unlikely — if anything it makes the request EASIER to satisfy.
   *
   * The obvious correction is to move it to `stakes`, since what asking for a shape
   * really signals is that something downstream will parse the answer. That correction
   * is wrong, and it is worth saying why rather than leaving the next reader to make it.
   * `stakes` exists to justify a PAID check. A declared shape already carries a FREE
   * one: the reply either parsed or it did not, and `Faults.malformed` is that answer
   * for nothing. Promoting it to stakes would buy a paid check in precisely the place a
   * free one already sits — and the first thing it would catch is the planner, whose own
   * output is structured, tripling the cost of every plan to learn something the parser
   * had already reported. So it is read here as a fault axis rather than a stakes one:
   * it decides what can be checked for free, not what is worth paying to check.
   */
  structured: boolean;
  /** How consequential being wrong is, 0..1 (default 0). The value of checking an
   *  answer is (chance the estimate is wrong × cost of being wrong) − cost of checking;
   *  stakes is the cost-of-being-wrong term, so a high-stakes request is checked at a
   *  wider margin than a low-stakes one of the same difficulty. */
  stakes?: number;
}

/**
 * How hard this looks, before anything has read it. Zero is a question the
 * smallest model answers; one is a question it should not be handed.
 *
 * Three terms, and only three: how much conversation sits behind the request, how many
 * tools it has to choose between, and how much text has to be read before answering can
 * start. Two terms that used to be here are gone, and the reasons are on `Shape.asked`
 * and `Shape.structured`. Removing the heaviest of the five is not a tuning change: a
 * long question no longer starts on a stronger model, it gets its answer CHECKED, which
 * is what a risk term is for.
 *
 * The three that remain are weighted equally. That is a deliberate refusal rather than
 * laziness: with the term that dominated the estimate removed, any ranking among the
 * survivors would be a measurement this module has not made, and inventing one is how a
 * hand-tuned constant acquires a false pedigree. Equal thirds says out loud that the
 * ordering is unknown. What makes that defensible is that every estimate is recorded
 * against what actually happened, so an agent whose requests are consistently misjudged
 * pulls its own back into line — see `Ledger`.
 *
 * One consequence is worth stating because it bounds the whole ladder: an agent with no
 * tools cannot score above two thirds, so on a three-rung ladder it reaches the top rung
 * only at the very top of the other two axes. That is the intended reading. A toolless
 * agent with a short history is not doing the kind of work the strongest rung is for.
 */
export function difficultyOf(shape: Shape): number {
  return saturate(
    (saturate(shape.turns / 8) +
      saturate(shape.tools / 12) +
      saturate(shape.carried / REREAD_FULL)) /
      3,
  );
}

/**
 * How likely this request is to be got wrong, as distinct from how hard it is.
 *
 * These come apart, which is the whole reason for the split. Length predicts failure
 * after difficulty has been controlled for — a long prompt is not a harder question, it
 * is more surface to lose the thread on — so it belongs to the decision about whether an
 * answer is worth checking and not to the decision about which model answers. Routing a
 * long question upward buys a stronger model for a question that may be trivial;
 * checking it buys a second look at exactly the failure length actually predicts.
 */
export function riskOf(shape: Shape): number {
  return saturate(shape.asked / LONG);
}

/**
 * How much agreement is enough to let a cheap answer stand.
 *
 * Climbing is not free, and its cost is not only the stronger model's price: it
 * reads the whole prompt again with none of it cached, because a cache belongs
 * to the model that filled it. The longer the prompt, the more a switch costs
 * and the less a marginal doubt is worth acting on.
 */
export function barFor(shape: Shape): number {
  return BASE_BAR * (1 - 0.4 * saturate(shape.carried / REREAD_FULL));
}

/**
 * How many answers to compare, when a rung is checked and has no depth left to add.
 *
 * Only reached on a rung capped at zero depth — everywhere else the second answer comes
 * from a deeper pass and there is exactly one of it. The shaping is unchanged from when
 * this was the main path: an extra sample re-reads a prefix the same rung has just read,
 * and a crossing re-reads it on a model that has not, so the longer the prompt the wider
 * that gap gets and the more a repeat is worth. On a short prompt nothing is amortised,
 * and the fewest answers that constitute a check is two.
 */
export function samplesFor(shape: Shape): number {
  const warmth = saturate(shape.carried / REREAD_FULL);
  return SAMPLES.least + Math.round((SAMPLES.most - SAMPLES.least) * warmth);
}

/**
 * The margin (of band-headroom) within which an answer is worth checking — the
 * value-of-computation trigger, made explicit.
 *
 * The objective is (chance the estimate is wrong × cost of being wrong) − cost of
 * checking, and both of the first two terms are now present: `riskOf` is the chance and
 * `stakes` is the cost. They combine as a noisy-or rather than a sum, because either one
 * alone is a reason to look again and neither is a reason to look twice; adding them
 * would let a long low-stakes question out-argue a short critical one.
 *
 * At zero risk and zero stakes this is exactly `VERIFY_MARGIN`, so the hand-tuned
 * constant survives as the corner of a stated objective rather than as a separate rule.
 * At full weight it is the whole band, and every answer below the top rung is checked —
 * which is only literally true because the comparison in `route` is inclusive. It was
 * not, and a request whose difficulty was exactly zero sat exactly one band from the
 * next rung and so escaped checking at `stakes = 1`, in flat contradiction of what this
 * function's own contract promised. That was invisible while `asked` inflated every
 * difficulty above zero.
 */
export function verifyMarginFor(shape: Shape, band: number): number {
  const stakes = saturate(shape.stakes ?? 0);
  const worry = 1 - (1 - riskOf(shape)) * (1 - stakes);
  return VERIFY_MARGIN + worry * (band - VERIFY_MARGIN);
}

/** Which of the three depths an endpoint can express this number lands in. */
const depthOf = (effort: number): number => (effort >= DEPTHS[2] ? 2 : effort >= DEPTHS[1] ? 1 : 0);

/**
 * The depths to ask this rung for, in order, before giving up on it and crossing to
 * another model.
 *
 * The first entry is where the request starts; each one after it is a step an endpoint
 * can actually tell apart from the one before, so no step in this list buys a duplicate
 * of the previous answer at a higher price. It is short by construction — at most three
 * — because a provider's depth control has three settings and a ladder cannot have more
 * rungs than the thing it climbs.
 *
 * `ceiling` is the rung's own cap, `Rung.effort`. A rung capped at zero returns a single
 * step, which is the honest answer: it has no depth to add and the only escalation
 * available to it is a crossing. That case is common — as `compile/models.ts` is written,
 * the cheapest rung on every ladder is capped at zero, which is exactly the rung a
 * cascade starts on. So the constraint at the top of this file is real but currently
 * reaches only the middle of a ladder, and moving that cap is a decision about which
 * endpoints will accept a depth argument, not a decision about routing.
 */
export function ladderFrom(effort: number, ceiling = 1): number[] {
  const cap = saturate(ceiling);
  const start = Math.min(saturate(effort), cap);
  const steps = [start];
  for (let depth = depthOf(start) + 1; depth < DEPTHS.length; depth++) {
    // The last depth asks for all of the room rather than for its own threshold, so an
    // endpoint that takes a token budget gets a real increase and not a rounding one.
    const step = depth === DEPTHS.length - 1 ? 1 : DEPTHS[depth]!;
    if (step > cap) break;
    steps.push(step);
  }
  return steps;
}

export interface Reading {
  /** Index into the rungs: where this request starts, rather than at the bottom. */
  entry: number;
  /** Whether that rung's answer is checked before it stands. */
  verify: boolean;
  /** How many answers to compare, if it is checked on a rung with no depth to add. */
  samples: number;
  /**
   * How much of the room this rung has should be asked for, 0..1. A request
   * sitting low in its band gets a model that answers; one near the top of it
   * gets a model that thinks first.
   */
  effort: number;
  /**
   * The depths to ask the entry rung for, in order, before crossing to another model.
   * Begins at `effort`. This is what the REQUEST warrants; the rung's own cap
   * (`Rung.effort`) clamps it, and on a rung capped at zero it collapses to one step.
   */
  ladder: number[];
  difficulty: number;
  /** How much agreement will be enough, if it is checked. */
  bar: number;
  /**
   * How likely this decision was, given the request.
   *
   * One under a deterministic policy, which is the same as saying the log it goes into
   * cannot be read for anything counterfactual. `1 - ε` and `ε / alternatives` once
   * exploration is on. Written down at the moment of the decision because it cannot be
   * reconstructed afterwards: a log that records the choice but not its probability has
   * thrown away the only thing that makes off-policy estimation possible.
   */
  propensity: number;
  /** Whether this decision was the randomised one rather than the policy's. */
  explored: boolean;
  /** Said plainly, for the notes. */
  why: string;
}

/**
 * How much of the routing to randomise, and where the coin comes from.
 *
 * Absent entirely means no randomisation, and `route` stays a pure function of counts.
 * That is the default on purpose — see `EXPLORATION` for why a framework must not spend
 * an operator's money on evidence they did not ask for, and why a router that is
 * nondeterministic by default is a support burden as well as a bill.
 */
export interface Exploration {
  /** Share of decisions sent where the policy would not have sent them. Capped at 5%. */
  epsilon?: number;
  /** Where the coin comes from. Injectable, so that a test is a test and not a dice roll. */
  random?: () => number;
}

/**
 * The rungs a randomised decision may be sent to instead.
 *
 * Adjacent rungs only. The counterfactual worth buying support for is the one the policy
 * was nearly choosing anyway — that is where the decision boundary is, and a boundary is
 * where an estimator needs overlap. Jumping from the cheapest rung to the strongest to
 * "explore" would pay the largest possible price for the least informative observation,
 * about a request nothing suggested was hard.
 */
function alternatives(entry: number, rungs: number): number[] {
  return [entry - 1, entry + 1].filter((at) => at >= 0 && at < rungs);
}

/**
 * Pick where to start, and how much room to ask for. The estimate is cut into
 * as many bands as there are rungs, so `quality` decides how much room there is
 * to be wrong in and this decides where in that room a request falls.
 *
 * A request near the top of its band is the one worth checking: it is the case
 * where the estimate was nearly a different answer. A request in the middle of
 * its band is not close to anything, and checking it would buy nothing.
 */
export type { Preference };

export function route(
  shape: Shape,
  rungs: number,
  leaning = 0,
  preference: Preference = "balanced",
  explore?: Exploration,
): Reading {
  const difficulty = saturate(difficultyOf(shape) + LEAN * leaning);
  const bar = barFor(shape);
  const samples = samplesFor(shape);

  if (rungs <= 1) {
    return {
      entry: 0,
      verify: false,
      samples,
      effort: difficulty,
      ladder: ladderFrom(difficulty),
      difficulty,
      bar,
      propensity: 1,
      explored: false,
      why: "one model is configured",
    };
  }

  // The operator's own tradeoff, applied before any of the estimating below.
  //
  // `quality` is not "the cascade, biased upward" — it is the cascade turned off. Start
  // at the strongest rung, ask for all of it, and check nothing, because checking exists
  // to decide whether to climb and there is nowhere left to climb to. Two findings make
  // this the right shape rather than a lazy one: sampling the same model repeatedly is
  // actively harmful on long context, and agreement DECAYS as a model gets better —
  // measured at 77% of hard-benchmark items agreeing at 0.8 or above, with nearly half
  // of those agreements wrong. An escalation signal that weakens every time the models
  // improve is the wrong thing to spend a frontier operator's requests on.
  if (preference === "quality") {
    return {
      entry: rungs - 1,
      verify: false,
      samples,
      effort: 1,
      ladder: [1],
      difficulty,
      bar,
      // Exploration is off here whatever was asked for, and not as an oversight. Under
      // `cost` an operator has declined to pay for information; under `quality` they
      // have bought a promise about the ANSWER, and randomising a share of requests down
      // to a weaker rung would spend that promise instead of the budget. Neither extreme
      // opted into the tradeoff, and exploration is a tradeoff. Only `balanced` explores.
      propensity: 1,
      explored: false,
      why: "the operator asked for quality: the strongest rung, at full depth, with nothing above it to climb to",
    };
  }

  const band = 1 / rungs;
  const estimated = Math.min(rungs - 1, Math.floor(difficulty / band));
  // Under `cost` the operator has said they would rather pay for a check than for a
  // climb, so start one rung lower than the estimate wherever there is a rung to start
  // lower on. The check below then decides whether that was optimistic — which is the
  // trade a cascade is actually for, made explicit instead of assumed.
  const intended = preference === "cost" ? Math.max(0, estimated - 1) : estimated;

  const epsilon =
    preference === "cost" ? 0 : Math.min(EXPLORE_CAP, Math.max(0, explore?.epsilon ?? 0));
  const coin = explore?.random ?? Math.random;
  const options = epsilon > 0 ? alternatives(intended, rungs) : [];
  let entry = intended;
  let propensity = 1;
  let explored = false;
  if (options.length) {
    propensity = 1 - epsilon;
    if (coin() < epsilon) {
      explored = true;
      entry = options[Math.min(options.length - 1, Math.floor(coin() * options.length))]!;
      propensity = epsilon / options.length;
    }
  }

  const headroom = (entry + 1) * band - difficulty;
  // Value of computation: check when the request sits within the (risk- and
  // stakes-widened) margin of the next band — near enough that the estimate was nearly a
  // different answer, and either likely enough to be wrong or consequential enough that
  // being wrong is worth ruling out. Inclusive, so that a fully weighted margin really
  // does mean every answer below the top rung, which is what `verifyMarginFor` claims.
  // Starting deliberately low means the answer is always worth checking.
  const verify =
    entry < rungs - 1 && (preference === "cost" || headroom <= verifyMarginFor(shape, band));

  // Where in this rung's band the request sits. The same number that decides whether the
  // choice was nearly a different one decides how deep to go first.
  const effort = saturate((difficulty - entry * band) / band);

  return {
    entry,
    verify,
    samples,
    effort,
    ladder: ladderFrom(effort),
    difficulty,
    bar,
    propensity,
    explored,
    why: explored
      ? "sent somewhere the estimate did not choose, on purpose, so the record can be read back"
      : verify
        ? "close to the edge of what this model handles"
        : "well inside what this model handles",
  };
}

// ── Comparing two answers ──────────────────────────────────────────────────

export interface Consensus {
  /** The sample the others most agree with. */
  text: string;
  /** How much they agree with it, 0..1. */
  agreement: number;
}

/**
 * Words that carry meaning. Negations stay in deliberately: "the refund is
 * allowed" and "the refund is not allowed" are the pair this has to be able to
 * tell apart, and dropping "not" as noise is exactly how that goes wrong.
 */
const NOISE = new Set(
  ("a an and are as at be been being by for from had has have he her his i if in into is it its " +
    "me my of on or our so that the their them then there these they this those to was we were " +
    "what when where which while who whom whose will with would you your")
    .split(" "),
);

function wordsOf(text: string): Set<string> {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(words.filter((word) => !NOISE.has(word)));
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / (a.size + b.size - shared);
}

/** Every scalar an object holds, keyed by where it sits in it. */
function leaves(value: unknown, into: Map<string, string>, path = ""): void {
  if (value === null || typeof value !== "object") {
    into.set(path, String(value).trim().toLowerCase().replace(/\s+/g, " "));
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, at) => leaves(item, into, `${path}[${at}]`));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    leaves(item, into, path ? `${path}.${key}` : key);
  }
}

/** What an answer decided, when it decided it in a declared shape. */
function decisionOf(text: string): Map<string, string> | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const found = new Map<string, string>();
  leaves(parsed, found);
  return found.size ? found : undefined;
}

function sameDecision(a: Map<string, string>, b: Map<string, string>): number {
  const keys = new Set([...a.keys(), ...b.keys()]);
  let agreed = 0;
  for (const key of keys) if (a.has(key) && a.get(key) === b.get(key)) agreed++;
  return agreed / keys.size;
}

/**
 * How alike two answers are, 0..1.
 *
 * Where an answer came back in a declared shape, what it decided is the fields
 * and the prose around them is not the answer — two replies agreeing on every
 * field agree, however differently they are worded. Comparing words instead
 * would read a rewrite as a disagreement and a shared preamble as an agreement,
 * both in the direction that makes a router climb when it should not have.
 * Words are the fallback, for answers that have nothing better to compare.
 */
export function likeness(a: string, b: string): number {
  const left = decisionOf(a);
  const right = decisionOf(b);
  if (left && right) return sameDecision(left, right);
  return overlap(wordsOf(a), wordsOf(b));
}

/**
 * Which of these answers the others back up, and by how much.
 *
 * The one kept is the one nearest the rest rather than the one that arrived
 * first, because arriving first says nothing. The number returned is about that
 * answer specifically — how well supported the thing being kept is — not about
 * how tidy the set was.
 */
export function consensusOf(samples: string[]): Consensus {
  if (samples.length < 2) return { text: samples[0] ?? "", agreement: 1 };

  let kept = 0;
  let agreement = -1;
  for (let i = 0; i < samples.length; i++) {
    let total = 0;
    for (let j = 0; j < samples.length; j++) {
      if (i !== j) total += likeness(samples[i]!, samples[j]!);
    }
    const mean = total / (samples.length - 1);
    if (mean > agreement) {
      agreement = mean;
      kept = i;
    }
  }
  return { text: samples[kept]!, agreement: Math.max(0, agreement) };
}

/** How much a second answer differs from the one it replaced, 0..1. */
export const divergence = (before: string, after: string): number => 1 - likeness(before, after);

// ── The record ─────────────────────────────────────────────────────────────

/**
 * What was wrong with an answer, as far as anything could tell without asking a
 * model about it.
 *
 * These are the only things about an answer that are free and true at once. A
 * declared shape either parsed or it did not; a tool either answered or it
 * returned an error. Everything else worth knowing costs a call to find out,
 * and a router that spends a call to grade a call has stopped saving anything.
 */
export interface Faults {
  /** A declared shape came back unparseable. */
  malformed: boolean;
  /** Tool calls that came back an error. */
  toolErrors: number;
}

const faulty = (faults?: Faults): boolean =>
  Boolean(faults && (faults.malformed || faults.toolErrors > 0));

/** What was chosen for one request, and what came of it. */
export interface Decision {
  at: number;
  agent: string;
  shape: Shape;
  difficulty: number;
  /** Rung it started on, and how many there were. */
  entry: number;
  rungs: number;
  /**
   * How likely `entry` was, given the request. See `Reading.propensity`.
   *
   * Required rather than optional, and that is a breaking change to anyone writing a
   * `Decision` by hand. It is the right kind of breaking: a row without a propensity is
   * a row nothing can be estimated from, and letting it be omitted would mean the log
   * silently reverts to the un-evaluable state this field exists to end. A row read back
   * from before this field existed is treated as deterministic, which is what it was.
   */
  propensity: number;
  /** Whether this decision was randomised rather than chosen. */
  explored: boolean;
  verified: boolean;
  agreement?: number;
  climbed: boolean;
  /**
   * Depth steps taken on the entry rung before any crossing.
   *
   * Recorded and NOT fed to `verdictOf`. A verdict is about whether a crossing was worth
   * its price, and a depth step has a different price and a different question attached
   * to it. Scoring the two on one scale would let cheap steps pay off expensive
   * crossings in the same average, which is how a router talks itself into crossing.
   */
  deepened?: number;
  /** What was wrong with the answer the climb replaced. */
  before?: Faults;
  /** What was wrong with the answer that stands. */
  after?: Faults;
  /** How much the stronger answer differed from the one it replaced. */
  changed?: number;
  /** Rung the answer that stands came from. */
  settled: number;
}

/**
 * Whether a climb was worth making — decided from what could be checked, and
 * left undecided when nothing could.
 *
 * The tempting label is whether climbing changed the answer, because it is free
 * and always available. It is also the wrong question: it measures whether the
 * answer moved, not whether it improved. A router fitted to it learns to prefer
 * whichever rung paraphrases least, and a stronger model that restructures a
 * correct answer is scored as having earned the climb it did not need.
 *
 * So a change is never allowed to argue *for* a climb. It is allowed to argue
 * against one — an answer that came back the same is evidence the climb bought
 * nothing — and every other case waits for something checkable or stays
 * unproven. An unproven climb is recorded and not counted, which costs the
 * router some evidence and saves it from learning the wrong thing.
 */
export type Verdict = "justified" | "wasted" | "unproven";

export function verdictOf(decision: Decision): Verdict {
  if (!decision.climbed) return "unproven";

  const before = faulty(decision.before);
  const after = faulty(decision.after);

  // It fixed something that was demonstrably broken.
  if (before && !after) return "justified";
  // Still broken: the climb proved nothing either way.
  if (before) return "unproven";
  // It was sound before and is not now, which is worse than not climbing.
  if (after) return "wasted";

  return decision.changed !== undefined && decision.changed < SAME_ANSWER ? "wasted" : "unproven";
}

interface Tally {
  justified: number;
  wasted: number;
}

/**
 * What the router chose, kept where it can be read back.
 *
 * A router that cannot be told when it was wrong stays wrong, and the thing it
 * is least likely to notice about itself is the request it sent up that the
 * cheap model had already answered. What it needs is a label that costs nothing
 * and means something — see `verdictOf` for why those two are harder to have at
 * once than they look.
 *
 * The file accumulates on purpose — it is the record a real predictor would be
 * fitted to later. Only its tail is read back, which is enough to lean on
 * without reading a year of it at startup.
 *
 * What it can and cannot answer is worth knowing before anyone fits anything to it.
 * With `propensity` at 1 on every row — the default, and what every row written before
 * `Exploration` existed says — the only stratum with support for more than one rung is
 * the escalated one, so the log answers "given that this escalated, was it worth it"
 * and nothing else. It cannot answer whether escalating was right, because the requests
 * that did not escalate never saw the stronger rung at all. Fitting a regression to it
 * anyway is the standard trap: the errors correlate with the rule that wrote the log,
 * so the offline score improves while the router does not.
 */
export class Ledger {
  private readonly tallies = new Map<string, Promise<Tally>>();

  private readonly dir: string;

  constructor(

    dir: string

  ) {

    this.dir = dir;
}

  private path(agent: string): string {
    return join(this.dir, "routing", `${agent.replace(/[^\w.-]/g, "_")}.jsonl`);
  }

  /**
   * Which way this agent's own history says the estimate has been off, -1..1.
   * Below zero means it has been climbing when it did not need to.
   */
  async leaning(agent: string): Promise<number> {
    const tally = await this.tally(agent);
    const settled = tally.justified + tally.wasted;
    if (settled < ENOUGH) return 0;
    return (tally.justified - tally.wasted) / settled;
  }

  async record(decision: Decision): Promise<void> {
    const tally = await this.tally(decision.agent);
    count(tally, decision);
    const path = this.path(decision.agent);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(decision)}\n`, "utf8");
  }

  private tally(agent: string): Promise<Tally> {
    let pending = this.tallies.get(agent);
    if (!pending) {
      pending = this.seed(agent);
      this.tallies.set(agent, pending);
    }
    return pending;
  }

  private async seed(agent: string): Promise<Tally> {
    const tally: Tally = { justified: 0, wasted: 0 };
    const path = this.path(agent);
    let handle;
    try {
      const { size } = await stat(path);
      handle = await open(path, "r");
      const start = Math.max(0, size - TAIL_BYTES);
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      // The first line is dropped when the tail cut into it: half a row is not
      // a row, and one missing decision cannot matter to a running average.
      const lines = buffer.toString("utf8").split("\n").slice(start > 0 ? 1 : 0);
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          count(tally, JSON.parse(line) as Decision);
        } catch {
          // A truncated write is one row, not a reason to route blind.
        }
      }
    } catch {
      // Nothing recorded yet, which is the normal state on a first run.
    } finally {
      await handle?.close();
    }
    return tally;
  }
}

function count(tally: Tally, decision: Decision): void {
  const verdict = verdictOf(decision);
  if (verdict === "justified") tally.justified++;
  else if (verdict === "wasted") tally.wasted++;
}
