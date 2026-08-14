/**
 * Which model a request goes to, how much room it is given, and when that
 * choice is revisited.
 *
 * The obvious way to spend less is to start at the cheapest model and climb
 * until an answer looks good enough. That pays the cheap model on every single
 * request, including the ones that were always going to end up at the top, and
 * every climb makes the next model read the whole prompt again from cold. So
 * the choice is made up front, from the shape of the request, and climbing is
 * what happens when that choice turns out to have been wrong.
 *
 * A rung that might be out of its depth is asked more than once and the answers
 * are compared against each other, so agreement is MEASURED rather than reported.
 *
 * `quality` stays the only thing an AUTHOR sets. What an OPERATOR sets is
 * `preference` — cost, balanced, or quality — because the tradeoff between
 * paying less and answering better is genuinely theirs and not the framework's
 * to assume. Under `quality` none of the machinery above runs at all: the
 * strongest rung answers at full depth and nothing is checked, because checking
 * exists to decide whether to climb.
 *
 * Two things here are known to be weaker than they read, and are recorded rather
 * than quietly relied on.
 *
 * Measured agreement is a proxy whose quality DECAYS as models improve. On hard
 * benchmarks a frontier model agrees with itself at 0.8 or above on roughly
 * three quarters of items, and close to half of those agreements are wrong. So
 * the signal this module leans on gets worse every time the rungs get better —
 * which is why `quality` does not use it, and why it is never used to bless the
 * best answer available.
 *
 * And "nothing here asks a model how sure it is" is too strong as stated. What a
 * model reports about itself is unreliable on reasoning, where correctness rides
 * on a chain it cannot inspect; it is considerably better than that on recall,
 * and on current frontier models it is near human parity. The measured result is
 * that the two signals FUSED beat either alone, and beat many samples of
 * agreement at a fraction of the cost. This module does not yet do that, and
 * saying so is more use than a sentence claiming the question is settled.
 */

import { appendFile, mkdir, open, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Preference } from "../define.js";

/**
 * Samples taken when a rung's answer is checked before it is allowed to stand.
 *
 * Never one — one sample is not a check. Never many: three answers already
 * settle whether a model is repeating itself or improvising, and a fourth costs
 * as much as the climb it is trying to avoid.
 */
const SAMPLES = { least: 2, most: 3 } as const;

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

/** Tail of the record read back at startup, enough to be recent without being everything. */
const TAIL_BYTES = 64 * 1024;

const saturate = (value: number): number => (value <= 0 ? 0 : value >= 1 ? 1 : value);

/**
 * What can be known about a request without reading it — which is to say,
 * without spending anything. Every one of these is a count.
 */
export interface Shape {
  /** Characters of the request itself. */
  asked: number;
  /** Characters read before answering can start: instructions, recall, history. */
  carried: number;
  /** Turns of conversation behind this one. */
  turns: number;
  /** Tools the model has to choose between. */
  tools: number;
  /** Whether the answer has to come back in a declared shape. */
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
 * The weights are a starting position, not a measurement. What makes them
 * defensible is that every one of them is recorded against what actually
 * happened, so an agent whose requests are consistently misjudged pulls its own
 * estimate back into line — see `Ledger`.
 */
export function difficultyOf(shape: Shape): number {
  return saturate(
    0.35 * saturate(shape.asked / 2_000) +
      0.2 * saturate(shape.turns / 8) +
      0.2 * saturate(shape.tools / 12) +
      0.15 * saturate(shape.carried / REREAD_FULL) +
      0.1 * (shape.structured ? 1 : 0),
  );
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
 * How many times to ask, when an answer is being checked.
 *
 * Checking has to cost less than the climb it might save, or it is the same
 * mistake a cascade makes one level up: paying for certainty about a cheap
 * answer until the certainty costs more than the expensive answer would have.
 * Nothing here knows what a model charges — a base url and a model id belong to
 * the app that chose them — so this is priced in the one currency the framework
 * can see. An extra sample re-reads a prefix the same rung has just read, and
 * the climb re-reads it on a rung that has not, so the longer the prompt the
 * wider that gap gets and the more checking is worth doing. On a short prompt
 * nothing is amortised, and the fewest samples that constitute a check is two.
 */
export function samplesFor(shape: Shape): number {
  const warmth = saturate(shape.carried / REREAD_FULL);
  return SAMPLES.least + Math.round((SAMPLES.most - SAMPLES.least) * warmth);
}

/**
 * The margin (of band-headroom) within which an answer is worth checking — the
 * value-of-computation trigger, made explicit. At `stakes = 0` this is exactly
 * `VERIFY_MARGIN` (the tuned default), so behaviour is unchanged; as stakes rise it
 * widens toward the full band, until at `stakes = 1` any answer below the top rung is
 * checked. The hand-tuned constant is thus the zero-stakes case of a VOC objective,
 * not a separate rule.
 */
export function verifyMarginFor(shape: Shape, band: number): number {
  const stakes = saturate(shape.stakes ?? 0);
  return VERIFY_MARGIN + stakes * (band - VERIFY_MARGIN);
}

export interface Reading {
  /** Index into the rungs: where this request starts, rather than at the bottom. */
  entry: number;
  /** Whether that rung's answer is checked against itself before it stands. */
  verify: boolean;
  /** How many answers to compare, if it is checked. */
  samples: number;
  /**
   * How much of the room this rung has should be asked for, 0..1. A request
   * sitting low in its band gets a model that answers; one near the top of it
   * gets a model that thinks first.
   */
  effort: number;
  difficulty: number;
  /** How much agreement will be enough, if it is checked. */
  bar: number;
  /** Said plainly, for the notes. */
  why: string;
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

export function route(shape: Shape, rungs: number, leaning = 0, preference: Preference = "balanced"): Reading {
  const difficulty = saturate(difficultyOf(shape) + LEAN * leaning);
  const bar = barFor(shape);
  const samples = samplesFor(shape);

  if (rungs <= 1) {
    return {
      entry: 0,
      verify: false,
      samples,
      effort: difficulty,
      difficulty,
      bar,
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
      difficulty,
      bar,
      why: "the operator asked for quality: the strongest rung, at full depth, with nothing above it to climb to",
    };
  }

  const band = 1 / rungs;
  const estimated = Math.min(rungs - 1, Math.floor(difficulty / band));
  // Under `cost` the operator has said they would rather pay for a check than for a
  // climb, so start one rung lower than the estimate wherever there is a rung to start
  // lower on. The check below then decides whether that was optimistic — which is the
  // trade a cascade is actually for, made explicit instead of assumed.
  const entry = preference === "cost" ? Math.max(0, estimated - 1) : estimated;
  const headroom = (entry + 1) * band - difficulty;
  // Value of computation: check when the request sits within the (stakes-widened)
  // margin of the next band — near enough that the estimate was nearly a different
  // answer, and consequential enough that being wrong is worth ruling out. Starting
  // deliberately low means the answer is always worth checking.
  const verify =
    entry < rungs - 1 && (preference === "cost" || headroom < verifyMarginFor(shape, band));

  return {
    entry,
    verify,
    samples,
    // Where in this rung's band the request sits. The same number that decides
    // whether the choice was nearly a different one decides how hard to work.
    effort: saturate((difficulty - entry * band) / band),
    difficulty,
    bar,
    why: verify
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
  verified: boolean;
  agreement?: number;
  climbed: boolean;
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
 */
export class Ledger {
  private readonly tallies = new Map<string, Promise<Tally>>();

  constructor(private readonly dir: string) {}

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
