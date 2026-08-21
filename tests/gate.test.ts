/**
 * The permit pool, and the promise it is actually making.
 *
 * `Gate` exists because a limit re-created per list is not a limit: four items each
 * running a four-wide body is sixteen in flight while every level honours four. So one
 * pool is made at the top of a run and carried down by every nested context, and its
 * whole value is a number nobody ever observes directly — the peak concurrency. That
 * number is what these tests measure, because it is the only thing that can regress
 * without anything else going wrong.
 *
 * The second half is what the pool REFUSES, which is subtler than what it allows. It
 * refuses to hand a permit to a latecomer ahead of a queue that has already formed, and
 * it refuses to lose a permit when the work throws. Both are one line in `run`, both are
 * invisible in a passing suite that only counts, and both turn a bounded run into a
 * stalled one when they break.
 */

import { describe, expect, it } from "vitest";

import { Gate } from "../src/gate.js";

/** A promise plus the handles to settle it, so a test can hold work open. */
function held<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((ok, no) => {
    resolve = ok;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** Let every already-queued microtask and timer callback run. */
const settle = (): Promise<void> => new Promise((go) => setTimeout(go, 0));

/** Records how many pieces of work were in flight at the busiest moment. */
function counter() {
  let now = 0;
  let peak = 0;
  return {
    get peak() {
      return peak;
    },
    async work<T>(body: () => Promise<T> | T): Promise<T> {
      now++;
      peak = Math.max(peak, now);
      try {
        return await body();
      } finally {
        now--;
      }
    },
  };
}

describe("how many at once", () => {
  it("never runs more than its permits, however many are offered at once", async () => {
    const gate = new Gate(3);
    const seen = counter();
    await Promise.all(
      Array.from({ length: 30 }, () => gate.run(() => seen.work(() => settle()))),
    );
    expect(seen.peak).toBe(3);
    expect(gate.available).toBe(3);
  });

  it("one pool shared by nested lists bounds the whole tree, not each level", async () => {
    // The reason the class exists. Four outer items each scheduling four inner ones is
    // sixteen without a shared pool; with one it is four, and the outer scheduling must
    // NOT be holding a permit while it waits for the inner work — that is the discipline
    // the pool depends on and cannot enforce.
    const gate = new Gate(4);
    const seen = counter();
    await Promise.all(
      Array.from({ length: 4 }, () =>
        Promise.all(
          Array.from({ length: 4 }, () => gate.run(() => seen.work(() => settle()))),
        ),
      ),
    );
    expect(seen.peak).toBeLessThanOrEqual(4);
    expect(gate.available).toBe(4);
  });

  it("reports the permits nobody is holding while work is in flight", async () => {
    const gate = new Gate(2);
    const first = held();
    const running = gate.run(() => first.promise);
    await settle();
    expect(gate.available).toBe(1);
    first.resolve();
    await running;
    expect(gate.available).toBe(2);
  });
});

describe("what the pool refuses", () => {
  it("refuses to let a latecomer jump a queue that had already formed", async () => {
    // The `finally` hands the permit straight to the next waiter instead of returning it
    // to `free` and letting whoever asks next take it. Without that, an arrival between
    // the release and the re-acquire overtakes callers that were already waiting, and a
    // steady stream of arrivals can starve the head of the queue indefinitely.
    const gate = new Gate(1);
    const order: string[] = [];
    const first = held();

    const running = gate.run(async () => {
      order.push("first");
      await first.promise;
    });
    await settle();

    const queued = ["b", "c", "d"].map((name) =>
      gate.run(async () => {
        order.push(name);
      }),
    );
    await settle();

    // Arrives after the queue exists, and must go behind it.
    const late = gate.run(async () => {
      order.push("late");
    });

    first.resolve();
    await Promise.all([running, ...queued, late]);
    expect(order).toEqual(["first", "b", "c", "d", "late"]);
  });

  it("refuses to lose a permit when the work throws", async () => {
    // A leaked permit is not a crash; it is a run that gets quieter and then stops. With
    // one permit and no release on failure, the very next caller waits forever.
    const gate = new Gate(1);
    await expect(gate.run(async () => {
      throw new Error("the tool refused");
    })).rejects.toThrow("the tool refused");
    expect(gate.available).toBe(1);
    await expect(gate.run(async () => "after")).resolves.toBe("after");
  });

  it("hands the permit to the next waiter even when the holder failed", async () => {
    const gate = new Gate(1);
    const first = held();
    const running = gate.run(() => first.promise).catch(() => "failed");
    await settle();

    let ran = false;
    const next = gate.run(async () => {
      ran = true;
    });
    await settle();
    expect(ran).toBe(false);

    first.reject(new Error("upstream is down"));
    await Promise.all([running, next]);
    expect(ran).toBe(true);
    expect(gate.available).toBe(1);
  });

  it("propagates what the work returned and what it threw, unchanged", async () => {
    const gate = new Gate(2);
    await expect(gate.run(async () => ({ id: 7 }))).resolves.toEqual({ id: 7 });
    const raised = new Error("exact");
    await expect(gate.run(async () => {
      throw raised;
    })).rejects.toBe(raised);
  });
});

describe("a permit count that could not bound anything", () => {
  it("treats zero, negative and non-numeric permits as one rather than as none", () => {
    // A pool of zero would be a pool nothing can ever pass through, which is a deadlock
    // dressed as configuration. One is the smallest honest answer.
    expect(new Gate(0).available).toBe(1);
    expect(new Gate(-5).available).toBe(1);
    expect(new Gate(Number.NaN).available).toBe(1);
    expect(new Gate(0.4).available).toBe(1);
  });

  it("floors a fractional count rather than admitting a fraction of a caller", () => {
    expect(new Gate(2.9).available).toBe(2);
  });

  it("still runs work at a permit count of one", async () => {
    const gate = new Gate(0);
    const seen = counter();
    await Promise.all(Array.from({ length: 5 }, () => gate.run(() => seen.work(() => settle()))));
    expect(seen.peak).toBe(1);
  });

  // HAZARD (pinned, not fixed). The floor is enforced and the ceiling is not:
  // `Math.max(1, Math.floor(Infinity) || 1)` is `Infinity`, so `limits.concurrency` set to
  // Infinity — or to 1e9 — produces a pool that admits everything, and the run is bounded
  // by nothing but the event loop. That is arguably what the author asked for, which is
  // why it is pinned rather than clamped: choosing a ceiling means choosing a number the
  // framework would be imposing on apps that never asked for one.
  it("accepts an unbounded permit count, so a pool can be no bound at all (hazard)", async () => {
    const gate = new Gate(Number.POSITIVE_INFINITY);
    expect(gate.available).toBe(Number.POSITIVE_INFINITY);
    const seen = counter();
    await Promise.all(Array.from({ length: 20 }, () => gate.run(() => seen.work(() => settle()))));
    expect(seen.peak).toBe(20);
  });
});

describe("the discipline the pool cannot enforce", () => {
  // HAZARD (pinned, not fixed). The class comment says permits are held around work and
  // never around the scheduling of more work, and that this is what makes the pool
  // deadlock-free. It is a rule about CALLERS. Nothing in `Gate` checks it, and a caller
  // that breaks it — awaiting a permit from inside one it already holds — hangs forever
  // with no error, no timeout and no diagnostic.
  //
  // This is pinned rather than fixed because the fix is real work with a real cost:
  // re-entrancy detection needs the pool to know which logical task is asking, which means
  // AsyncLocalStorage on the hot path of every model call. Worth deciding on its own
  // merits. Until then, the rule lives in this test as well as in the comment, so that
  // anyone tempted to move a `gate.run` inside another has something that says why not.
  it("deadlocks if a permit-holder waits for a permit — by design, and undetected", async () => {
    const gate = new Gate(1);
    let inner = false;

    const nested = gate.run(async () => {
      await gate.run(async () => {
        inner = true;
      });
    });

    const outcome = await Promise.race([
      nested.then(() => "finished"),
      new Promise((go) => setTimeout(() => go("still waiting"), 50)),
    ]);

    expect(outcome).toBe("still waiting");
    expect(inner).toBe(false);
    // Left hanging deliberately; it is unreachable and holds nothing but memory. Asserting
    // it here is the point — this is what the runner is avoiding by holding a permit around
    // the model call and never around `runList`.
    void nested;
  });
});
