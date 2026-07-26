/**
 * Which model a request goes to, and when that choice is revisited.
 *
 * The obvious way to spend less is to start at the cheapest model and climb
 * until an answer looks good enough. That pays the cheap model on every single
 * request, including the ones that were always going to end up at the top, and
 * every climb makes the next model read the whole prompt again from cold. So
 * the choice is made up front, from the shape of the request, and climbing is
 * what happens when that choice turns out to have been wrong.
 *
 * Nothing here asks a model how sure it is. A model asked that will say it is
 * sure. What it will not do is give the same answer twice to a question it is
 * guessing at — so a rung that might be out of its depth is asked more than
 * once and the answers are compared against each other. Agreement is measured
 * rather than reported, and measuring it costs cheap calls that run at the same
 * time instead of one expensive call that runs after.
 *
 * Agreement is a proxy and a known-imperfect one: a model can be consistently
 * wrong, and the better the model the more often it is confidently consistent
 * about something untrue. That is why it is only ever measured on a rung that
 * has somewhere better to go, and never used to bless the best answer available
 * — where the signal is weakest is exactly where nothing here relies on it.
 *
 * None of this is a dial. `quality` stays the only thing an author sets; all of
 * it happens underneath.
 *
 * Deliberately not built: asking a *different* model and comparing, which reads
 * well but collapses on inspection — the cheapest different model worth asking
 * is the one this would climb to, and having asked it there is nothing left to
 * decide.
 */

import { appendFile, mkdir, open, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Samples taken when a rung's answer is checked before it is allowed to stand. */
const SAMPLES = 3;

/** How close to the top of its band a request must sit before it is checked. */
const VERIFY_MARGIN = 0.12;

/** Agreement required to keep a cheap answer, before the cost of climbing is priced in. */
const BASE_BAR = 0.6;

/** How far an agent's own history is allowed to move the estimate. */
const LEAN = 0.15;

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

export interface Reading {
  /** Index into the rungs: where this request starts, rather than at the bottom. */
  entry: number;
  /** Whether that rung's answer is checked against itself before it stands. */
  verify: boolean;
  difficulty: number;
  /** How much agreement will be enough, if it is checked. */
  bar: number;
  /** Said plainly, for the notes. */
  why: string;
}

/**
 * Pick where to start. The estimate is cut into as many bands as there are
 * rungs, so `quality` decides how much room there is to be wrong in and this
 * decides where in that room a request falls.
 *
 * A request near the top of its band is the one worth checking: it is the case
 * where the estimate was nearly a different answer. A request in the middle of
 * its band is not close to anything, and checking it would buy nothing.
 */
export function route(shape: Shape, rungs: number, leaning = 0): Reading {
  const difficulty = saturate(difficultyOf(shape) + LEAN * leaning);
  const bar = barFor(shape);
  if (rungs <= 1) {
    return { entry: 0, verify: false, difficulty, bar, why: "one model is configured" };
  }

  const band = 1 / rungs;
  const entry = Math.min(rungs - 1, Math.floor(difficulty / band));
  const headroom = (entry + 1) * band - difficulty;
  const verify = entry < rungs - 1 && headroom < VERIFY_MARGIN;

  return {
    entry,
    verify,
    difficulty,
    bar,
    why: verify
      ? "close to the edge of what this model handles"
      : "well inside what this model handles",
  };
}

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

  const sets = samples.map(wordsOf);
  let kept = 0;
  let agreement = -1;
  for (let i = 0; i < samples.length; i++) {
    let total = 0;
    for (let j = 0; j < samples.length; j++) {
      if (i !== j) total += overlap(sets[i]!, sets[j]!);
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
export const divergence = (before: string, after: string): number =>
  1 - overlap(wordsOf(before), wordsOf(after));

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
  /** How much the stronger answer differed from the one it replaced. */
  changed?: number;
  /** Rung the answer that stands came from. */
  settled: number;
}

/** Whether a climb turned out to have been worth making. */
const wasted = (decision: Decision): boolean =>
  decision.climbed && decision.changed !== undefined && decision.changed < 0.25;

interface Tally {
  climbs: number;
  wasted: number;
}

export const SAMPLE_COUNT = SAMPLES;

/**
 * What the router chose, kept where it can be read back.
 *
 * A router that cannot be told when it was wrong stays wrong, and the thing it
 * is least likely to notice about itself is the request it sent up that the
 * cheap model had already answered. Two facts are worth keeping and neither
 * costs an extra call: whether an answer was climbed past, and whether climbing
 * changed it. A climb whose answer agrees with the one it replaced was a climb
 * that bought nothing.
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
    if (tally.climbs < 4) return 0;
    const justified = tally.climbs - tally.wasted;
    return (justified - tally.wasted) / tally.climbs;
  }

  async record(decision: Decision): Promise<void> {
    const tally = await this.tally(decision.agent);
    if (decision.climbed) {
      tally.climbs++;
      if (wasted(decision)) tally.wasted++;
    }
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
    const tally: Tally = { climbs: 0, wasted: 0 };
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
          const decision = JSON.parse(line) as Decision;
          if (!decision.climbed) continue;
          tally.climbs++;
          if (wasted(decision)) tally.wasted++;
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
