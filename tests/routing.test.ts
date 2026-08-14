/**
 * The routing decision on its own, away from any model.
 *
 * Everything here is a pure function of counts, which is the point: what the
 * router costs before it has spent anything is one pass over five numbers.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  Ledger,
  barFor,
  consensusOf,
  difficultyOf,
  divergence,
  ladderFrom,
  likeness,
  riskOf,
  route,
  samplesFor,
  verifyMarginFor,
  EXPLORATION,
  type Decision,
  type Shape,
} from "../src/harness/routing.js";
import { levelOf } from "../src/harness/wire/effort.js";

const shape = (over: Partial<Shape> = {}): Shape => ({
  asked: 20,
  carried: 100,
  turns: 0,
  tools: 0,
  structured: false,
  ...over,
});

describe("reading a request before spending anything on it", () => {
  it("calls a passing question easy and a deep argued one hard", () => {
    expect(difficultyOf(shape())).toBeLessThan(0.1);
    expect(
      difficultyOf(shape({ asked: 4_000, turns: 10, tools: 20, carried: 60_000 })),
    ).toBeGreaterThan(0.85);
  });

  it("counts the conversation, the choice of tools, and everything to be read", () => {
    const bare = difficultyOf(shape());
    expect(difficultyOf(shape({ turns: 8 }))).toBeGreaterThan(bare);
    expect(difficultyOf(shape({ tools: 12 }))).toBeGreaterThan(bare);
    expect(difficultyOf(shape({ carried: 40_000 }))).toBeGreaterThan(bare);
  });

  it("does not read a declared shape as a harder question", () => {
    // It used to add difficulty, which was backwards. The shape is sent to the endpoint
    // as a schema it decodes under, so a reply outside it is unreachable rather than
    // unlikely. What it really changes is that a malformed answer becomes detectable for
    // nothing — a fault axis, not a difficulty one, and not a stakes one either: paying
    // for a check where a free one already sits is the trade this module exists to refuse.
    expect(difficultyOf(shape({ structured: true }))).toBe(difficultyOf(shape()));
  });

  it("does not read a long question as a hard one", () => {
    // Length predicts failure after difficulty has been controlled for, which makes it a
    // statement about the risk of getting this wrong and not about which model should be
    // handed it. Routing a long question upward buys a stronger model for a question that
    // may be trivial; the same evidence spent on a check buys a second look at exactly the
    // failure length actually predicts.
    expect(difficultyOf(shape({ asked: 8_000 }))).toBe(difficultyOf(shape()));
    expect(riskOf(shape({ asked: 8_000 }))).toBe(1);
    expect(riskOf(shape({ asked: 0 }))).toBe(0);
  });

  it("scores the short hard question above the long easy one", () => {
    // The case the old weights got exactly wrong, and the case being wrong costs most on:
    // a terse question at the end of a deep conversation with a wide choice of tools.
    const terse = shape({ asked: 30, turns: 8, tools: 12 });
    const rambling = shape({ asked: 20_000 });
    expect(difficultyOf(terse)).toBeGreaterThan(difficultyOf(rambling));
  });

  it("stays inside nought and one however extreme the counts get", () => {
    const wild = difficultyOf(shape({ asked: 1e9, turns: 1e6, tools: 1e6, carried: 1e9 }));
    expect(wild).toBeGreaterThan(0);
    expect(wild).toBeLessThanOrEqual(1);
  });
});

describe("choosing where to start", () => {
  it("has nothing to decide when one model is configured", () => {
    const reading = route(shape({ asked: 5_000, turns: 20 }), 1);
    expect(reading.entry).toBe(0);
    expect(reading.verify).toBe(false);
  });

  it("sends an easy question to the cheapest model and does not check it", () => {
    const reading = route(shape(), 3);
    expect(reading.entry).toBe(0);
    expect(reading.verify).toBe(false);
  });

  it("skips the cheap model outright when the request is plainly beyond it", () => {
    const reading = route(shape({ asked: 4_000, turns: 10, tools: 20, carried: 60_000 }), 3);
    expect(reading.entry).toBe(2);
  });

  it("checks a long question rather than sending it to a stronger model", () => {
    // This used to pass because length was the heaviest difficulty term, so a long
    // question sat just under the next band and the margin caught it. It now passes for
    // the reason it should always have: the question is EASY — three turns, no tools —
    // and it is CHECKED, because 2,500 characters is a real risk of getting it wrong
    // whatever the estimate says. Same decision, honest cause.
    const long = route(shape({ asked: 2_500, turns: 3 }), 2);
    expect(long.entry).toBe(0);
    expect(long.difficulty).toBeLessThan(0.25);
    expect(long.verify).toBe(true);

    // Short and easy, where nothing suggests either a stronger model or a second look.
    expect(route(shape({ asked: 200 }), 2).verify).toBe(false);
  });

  it("never checks the answer of the model it has nothing better than", () => {
    expect(route(shape({ asked: 4_000, turns: 10, tools: 20, carried: 60_000 }), 3).verify).toBe(
      false,
    );
  });

  it("an agent that has been climbing needlessly is pulled back down", () => {
    // Leaning moves the DIFFICULTY estimate, so the request it is shown on has to be one
    // that scores on difficulty at all. It used to be a 1,400-character question, which
    // now scores zero and would have made this test pass on nothing.
    const request = shape({ turns: 4, tools: 6 });
    expect(route(request, 3, -1).difficulty).toBeLessThan(route(request, 3, 0).difficulty);
    expect(route(request, 3, 1).difficulty).toBeGreaterThan(route(request, 3, 0).difficulty);
  });
});

describe("what a switch costs", () => {
  it("wants less doubt before switching the longer the prompt is", () => {
    // Switching means the next model reads all of it again from cold, so a
    // marginal doubt about a long prompt is not worth acting on.
    expect(barFor(shape({ carried: 40_000 }))).toBeLessThan(barFor(shape({ carried: 0 })));
  });

  it("checks more where checking is cheap and switching is dear", () => {
    // An extra answer re-reads a prompt this model has already read; a switch
    // re-reads it on one that has not. The longer the prompt, the further apart
    // those two prices are, so more of the doubt is worth settling in place.
    expect(samplesFor(shape({ carried: 0 }))).toBe(2);
    expect(samplesFor(shape({ carried: 60_000 }))).toBe(3);
  });
});

describe("how much room a request is given on the model it lands on", () => {
  it("asks for none of it when the question sat at the bottom of the band", () => {
    expect(route(shape(), 3).effort).toBeLessThan(0.1);
  });

  it("asks for more of it the further up its band the question sat", () => {
    // Stated on the axes that survived the correction: a request with a conversation and
    // a choice of tools behind it sits higher in its band than a bare one. It used to be
    // stated on question length, which now moves nothing here at all.
    const low = route(shape({ turns: 1 }), 3).effort;
    const high = route(shape({ turns: 4, tools: 4 }), 3).effort;
    expect(high).toBeGreaterThan(low);
    expect(high).toBeLessThanOrEqual(1);
  });
});

describe("escalating along depth before escalating across models", () => {
  it("climbs to depths the endpoint can actually tell apart, and no further", () => {
    // A step that renders to the same level as the one before it is a duplicate answer
    // bought twice. This is the coupling to the wire stated as a check rather than taken
    // as an import: if `levelOf` ever gains or loses a level, this fails here instead of
    // quietly paying for calls that cannot differ.
    const ladder = ladderFrom(0);
    expect(new Set(ladder.map(levelOf)).size).toBe(ladder.length);
    expect(ladder.length).toBe(3);
    expect(ladder[0]).toBe(0);
    expect(ladder[ladder.length - 1]).toBe(1);
  });

  it("ascends, and starts wherever the request landed", () => {
    const ladder = ladderFrom(0.5);
    expect(ladder[0]).toBe(0.5);
    expect([...ladder].sort((a, b) => a - b)).toEqual(ladder);
    expect(ladder.every((step) => step <= 1)).toBe(true);
  });

  it("gives a rung that will not take a depth argument exactly one attempt", () => {
    // As `compile/models.ts` is written the cheapest rung of every ladder is capped at
    // zero — which is the rung a cascade starts on. So this is not an edge case, it is
    // the common one, and the honest answer is that such a rung has no escalation
    // available to it but a crossing.
    expect(ladderFrom(0, 0)).toEqual([0]);
    expect(ladderFrom(0.8, 0)).toEqual([0]);
  });

  it("never proposes more depth than the rung is allowed", () => {
    for (const ceiling of [0, 0.2, 0.33, 0.5, 1]) {
      const ladder = ladderFrom(0, ceiling);
      expect(ladder.every((step) => step <= ceiling)).toBe(true);
      expect(ladder.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("puts the ladder on the reading, so nothing downstream has to guess at it", () => {
    const reading = route(shape(), 3);
    expect(reading.ladder[0]).toBe(reading.effort);
    expect(reading.ladder.length).toBeGreaterThan(1);
  });
});

describe("randomising a share of decisions, so the record can be read back", () => {
  const middling = shape({ turns: 4, tools: 4 });
  /** A coin that always comes up inside epsilon, and then picks the first alternative. */
  const explores = () => 0;
  /** A coin that never comes up inside epsilon. */
  const never = () => 1;

  it("is off unless asked for, and says so in the propensity", () => {
    const r = route(middling, 3);
    expect(r.explored).toBe(false);
    expect(r.propensity).toBe(1);
  });

  it("is a pure function of counts when nothing randomises it", () => {
    // Routing that is nondeterministic by default makes every test above it flaky and
    // every "why did this go to the expensive model" unanswerable. Both costs are borne
    // by whoever runs the app, so both are theirs to accept rather than ours to impose.
    const once = route(middling, 3, 0, "balanced");
    for (let i = 0; i < 20; i++) expect(route(middling, 3, 0, "balanced")).toEqual(once);
  });

  it("records the propensity of the choice it did NOT randomise", () => {
    // This is the whole point. A deterministic log gives every unchosen rung a propensity
    // of exactly zero, which is where inverse propensity weighting breaks and where the
    // doubly-robust form degenerates into a regression that cannot detect its own
    // misspecification. Writing 1 - epsilon down converts {0, 1} into {epsilon, 1 - epsilon}.
    const r = route(middling, 3, 0, "balanced", { epsilon: 0.02, random: never });
    expect(r.explored).toBe(false);
    expect(r.propensity).toBeCloseTo(0.98);
  });

  it("sends a randomised decision to a rung the estimate did not choose, and prices it", () => {
    // From the bottom rung there is one alternative, so the whole of epsilon goes to it.
    const on = route(middling, 3, 0, "balanced", { epsilon: 0.02, random: explores });
    const off = route(middling, 3, 0, "balanced");
    expect(on.explored).toBe(true);
    expect(on.entry).not.toBe(off.entry);
    expect(on.propensity).toBeCloseTo(0.02);
    expect(on.why).toContain("on purpose");

    // From a rung with a neighbour on each side, epsilon is split between them.
    const between = shape({ turns: 8, tools: 4 });
    expect(route(between, 3).entry).toBe(1);
    expect(
      route(between, 3, 0, "balanced", { epsilon: 0.02, random: explores }).propensity,
    ).toBeCloseTo(0.01);
  });

  it("only ever moves one rung, because the boundary is where support is needed", () => {
    // Both coins land inside the cap, which is what epsilon is really worth here.
    for (const coin of [explores, () => 0.049]) {
      const r = route(middling, 3, 0, "balanced", { epsilon: 1, random: coin });
      expect(r.explored).toBe(true);
      expect(Math.abs(r.entry - route(middling, 3).entry)).toBe(1);
    }
  });

  it("re-reads the request from wherever it was randomised to", () => {
    // A randomised decision is a real decision, not a label stuck on the old one: if the
    // coin sent it to the top rung there is nothing above it, and checking exists to
    // decide whether to climb.
    const hard = shape({ turns: 8, tools: 12, carried: 40_000 });
    const up = route(hard, 2, 0, "balanced", { epsilon: 1, random: explores });
    expect(up.entry).toBe(0);
    expect(up.verify).toBe(true);
  });

  it("caps what it will spend on evidence however much is asked for", () => {
    // The cost has to be bounded and knowable BEFORE it is spent, which stops being true
    // the moment a config file can ask for half the traffic.
    const r = route(middling, 3, 0, "balanced", { epsilon: 1, random: never });
    expect(r.propensity).toBeGreaterThanOrEqual(0.95);
    expect(EXPLORATION).toBeGreaterThan(0);
    expect(EXPLORATION).toBeLessThanOrEqual(0.05);
  });

  it("spends nothing on evidence under cost, and nothing on it under quality", () => {
    // Neither extreme opted into a tradeoff, and exploration is a tradeoff. Under cost an
    // operator declined to pay for information; under quality they bought a promise about
    // the answer, and randomising a share of requests downward spends that promise.
    const cheap = route(middling, 3, 0, "cost", { epsilon: 1, random: explores });
    expect(cheap.explored).toBe(false);
    expect(cheap.propensity).toBe(1);

    const best = route(middling, 3, 0, "quality", { epsilon: 1, random: explores });
    expect(best.explored).toBe(false);
    expect(best.entry).toBe(2);
    expect(best.effort).toBe(1);
    expect(best.verify).toBe(false);
  });

  it("has nowhere else to send a request when one model is configured", () => {
    const r = route(middling, 1, 0, "balanced", { epsilon: 1, random: explores });
    expect(r.explored).toBe(false);
    expect(r.propensity).toBe(1);
    expect(r.entry).toBe(0);
  });
});

describe("asking the same model twice and comparing", () => {
  it("reports full agreement when it said the same thing", () => {
    const { agreement } = consensusOf(["refunds take five days", "refunds take five days"]);
    expect(agreement).toBe(1);
  });

  it("reports little agreement when it did not", () => {
    const { agreement } = consensusOf([
      "refunds take five business days",
      "shipping is handled by a courier",
      "please contact your bank about it",
    ]);
    expect(agreement).toBeLessThan(0.2);
  });

  it("keeps the answer the others back, not the one that came first", () => {
    const { text } = consensusOf([
      "the warranty is void once opened",
      "refunds take five business days",
      "refunds take five business days from receipt",
    ]);
    expect(text).toContain("five business days");
  });

  it("does not read a denial as a version of the claim it denies", () => {
    // "not" is the whole difference between these two, so treating it as noise
    // is exactly how a router talks itself into keeping the wrong answer.
    const { agreement } = consensusOf([
      "the refund is allowed under this policy",
      "the refund is not allowed under this policy",
    ]);
    expect(agreement).toBeLessThan(1);
  });

  it("says nothing was measured when there was only one answer", () => {
    expect(consensusOf(["alone"]).agreement).toBe(1);
    expect(consensusOf([]).text).toBe("");
  });

  it("measures how far a second answer moved from the first", () => {
    expect(divergence("five business days", "five business days")).toBe(0);
    expect(divergence("five business days", "ask your bank")).toBe(1);
  });
});

describe("comparing what two answers decided", () => {
  it("reads a rewrite of the same decision as the same decision", () => {
    const a = `{"refund": true, "days": 5}`;
    const b = `{"days": 5, "refund": true}`;
    expect(likeness(a, b)).toBe(1);
  });

  it("reads a shared preamble around opposite decisions as disagreement", () => {
    const a = `{"note": "checked against the policy above", "refund": true}`;
    const b = `{"note": "checked against the policy above", "refund": false}`;
    expect(likeness(a, b)).toBeLessThan(1);
  });

  it("falls back to the words when there was no declared shape to compare", () => {
    expect(likeness("five business days", "five business days")).toBe(1);
  });

  it("compares the words when only one side came back in shape", () => {
    expect(likeness(`{"days": 5}`, "about five days")).toBeLessThan(1);
  });
});

describe("the record the router keeps", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "praecise-routing-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const climb = (changed: number): Decision => ({
    at: Date.now(),
    agent: "support",
    shape: shape(),
    difficulty: 0.3,
    entry: 0,
    rungs: 2,
    propensity: 1,
    explored: false,
    verified: true,
    agreement: 0.4,
    climbed: true,
    changed,
    settled: 1,
  });

  it("leans on nothing until it has seen enough to lean on", async () => {
    const ledger = new Ledger(dir);
    expect(await ledger.leaning("support")).toBe(0);
    await ledger.record(climb(0.9));
    expect(await ledger.leaning("support")).toBe(0);
  });

  it("pulls down an agent whose climbs keep landing on the same answer", async () => {
    const ledger = new Ledger(dir);
    for (let i = 0; i < 5; i++) await ledger.record(climb(0));
    expect(await ledger.leaning("support")).toBe(-1);
  });

  it("does not read a changed answer as a better one", async () => {
    const ledger = new Ledger(dir);
    for (let i = 0; i < 5; i++) await ledger.record(climb(0.9));
    expect(await ledger.leaning("support")).toBe(0);
  });

  it("pushes up an agent whose climbs keep repairing something that broke", async () => {
    const ledger = new Ledger(dir);
    for (let i = 0; i < 5; i++) {
      await ledger.record({
        ...climb(0.9),
        before: { malformed: true, toolErrors: 0 },
        after: { malformed: false, toolErrors: 0 },
      });
    }
    expect(await ledger.leaning("support")).toBe(1);
  });

  it("pulls down a climb that broke something the cheaper answer had right", async () => {
    const ledger = new Ledger(dir);
    for (let i = 0; i < 5; i++) {
      await ledger.record({
        ...climb(0.9),
        before: { malformed: false, toolErrors: 0 },
        after: { malformed: false, toolErrors: 2 },
      });
    }
    expect(await ledger.leaning("support")).toBe(-1);
  });

  it("remembers across a restart, because a process is not the unit of learning", async () => {
    const first = new Ledger(dir);
    for (let i = 0; i < 5; i++) await first.record(climb(0));
    expect(await new Ledger(dir).leaning("support")).toBe(-1);
  });

  it("keeps one agent's history out of another's", async () => {
    const ledger = new Ledger(dir);
    for (let i = 0; i < 5; i++) await ledger.record(climb(0));
    expect(await ledger.leaning("billing")).toBe(0);
  });

  it("does not count a request that never climbed as evidence either way", async () => {
    const ledger = new Ledger(dir);
    for (let i = 0; i < 9; i++) {
      await ledger.record({ ...climb(0), climbed: false, changed: undefined });
    }
    expect(await ledger.leaning("support")).toBe(0);
  });
});

describe("value of computation (stakes-aware verify)", () => {
  it("checks a high-stakes request at a wider margin than a low-stakes one of the same difficulty", () => {
    const base = { asked: 800, carried: 0, turns: 0, tools: 0, structured: false };
    const low = route({ ...base, stakes: 0 }, 3);
    const high = route({ ...base, stakes: 1 }, 3);
    expect(low.verify).toBe(false); // mid-band, low stakes → checking buys nothing
    expect(high.verify).toBe(true); // same difficulty, high stakes → worth ruling out
    expect(high.entry).toBe(low.entry); // stakes changes whether to CHECK, not where to start
  });

  it("verifyMarginFor reduces to the tuned constant at zero stakes and widens to the band at full stakes", () => {
    const band = 1 / 3;
    expect(verifyMarginFor({ asked: 0, carried: 0, turns: 0, tools: 0, structured: false, stakes: 0 }, band)).toBeCloseTo(0.12);
    expect(verifyMarginFor({ asked: 0, carried: 0, turns: 0, tools: 0, structured: false, stakes: 1 }, band)).toBeCloseTo(band);
  });
});
