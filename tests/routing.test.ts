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
  route,
  type Decision,
  type Shape,
} from "../src/harness/routing.js";

const shape = (over: Partial<Shape> = {}): Shape => ({
  asked: 20,
  carried: 100,
  turns: 0,
  tools: 0,
  structured: false,
  ...over,
});

describe("reading a request before spending anything on it", () => {
  it("calls a short question easy and a long argued one hard", () => {
    expect(difficultyOf(shape())).toBeLessThan(0.1);
    expect(
      difficultyOf(shape({ asked: 4_000, turns: 10, tools: 20, carried: 60_000 })),
    ).toBeGreaterThan(0.85);
  });

  it("counts every part of what has to be read, not just the question", () => {
    const bare = difficultyOf(shape());
    expect(difficultyOf(shape({ turns: 8 }))).toBeGreaterThan(bare);
    expect(difficultyOf(shape({ tools: 12 }))).toBeGreaterThan(bare);
    expect(difficultyOf(shape({ structured: true }))).toBeGreaterThan(bare);
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

  it("checks the answer only when the estimate was nearly a different one", () => {
    // Just inside the cheapest band of two, which is where being wrong costs
    // something and where the estimate deserves the least trust.
    const borderline = route(shape({ asked: 2_500, turns: 3 }), 2);
    expect(borderline.entry).toBe(0);
    expect(borderline.verify).toBe(true);

    // Comfortably inside it, where checking would buy nothing.
    expect(route(shape({ asked: 200 }), 2).verify).toBe(false);
  });

  it("never checks the answer of the model it has nothing better than", () => {
    expect(route(shape({ asked: 4_000, turns: 10, tools: 20, carried: 60_000 }), 3).verify).toBe(
      false,
    );
  });

  it("an agent that has been climbing needlessly is pulled back down", () => {
    const request = shape({ asked: 1_400 });
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

  it("pushes up an agent whose climbs keep changing the answer", async () => {
    const ledger = new Ledger(dir);
    for (let i = 0; i < 5; i++) await ledger.record(climb(0.9));
    expect(await ledger.leaning("support")).toBe(1);
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
