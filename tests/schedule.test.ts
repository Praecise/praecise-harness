/**
 * A clock is a source.
 *
 * A schedule is the one trigger everybody assumes is simple and that goes wrong in
 * the same two places: what a time means where clocks change, and what happens to
 * the ticks that fell due while nothing was running. Both are decided here and held
 * still, along with the thing that makes a clock safe to restart — a tick is named
 * by when it was due, so it starts one run however often it is handed over.
 */
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../src/app.js";
import { clock, cronNext, type Tick } from "../src/schedule.js";
import type { SourceEvent } from "../src/sources.js";
import { FRAMEWORK, MODEL_ENV, TEST_ENDPOINT, cleanup, makeProject } from "./helpers.js";

const at = (iso: string): number => Date.parse(iso);
const next = (expression: string, after: string, zone?: string): string =>
  new Date(cronNext(expression, at(after), zone)).toISOString();

describe("a cron expression", () => {
  it("falls due at the next minute its five fields match", () => {
    expect(next("0 2 * * *", "2026-01-01T03:00:00Z")).toBe("2026-01-02T02:00:00.000Z");
    expect(next("0 2 * * *", "2026-01-01T01:59:59Z")).toBe("2026-01-01T02:00:00.000Z");
    // Strictly after: a tick is not its own successor.
    expect(next("0 2 * * *", "2026-01-01T02:00:00Z")).toBe("2026-01-02T02:00:00.000Z");
    expect(next("*/15 * * * *", "2026-01-01T10:07:00Z")).toBe("2026-01-01T10:15:00.000Z");
    expect(next("5/20 * * * *", "2026-01-01T10:26:00Z")).toBe("2026-01-01T10:45:00.000Z");
    expect(next("0 9-17/4 * * *", "2026-01-01T13:30:00Z")).toBe("2026-01-01T17:00:00.000Z");
    expect(next("30 6 1,15 * *", "2026-01-02T00:00:00Z")).toBe("2026-01-15T06:30:00.000Z");
  });

  it("reads months and days of the week by name, and Sunday as 0 or 7", () => {
    // 2026-01-01 is a Thursday.
    expect(next("0 9 * * mon-fri", "2026-01-02T10:00:00Z")).toBe("2026-01-05T09:00:00.000Z");
    expect(next("0 0 * * 7", "2026-01-01T00:00:00Z")).toBe("2026-01-04T00:00:00.000Z");
    expect(next("0 0 * * SUN", "2026-01-01T00:00:00Z")).toBe("2026-01-04T00:00:00.000Z");
    expect(next("0 0 1 mar *", "2026-01-01T00:00:00Z")).toBe("2026-03-01T00:00:00.000Z");
  });

  it("matches either day field when both are restricted, as cron always has", () => {
    // The 13th, or any Friday: Friday the 2nd comes first.
    expect(next("0 0 13 * fri", "2026-01-01T00:00:00Z")).toBe("2026-01-02T00:00:00.000Z");
    expect(next("0 0 13 * fri", "2026-01-09T00:00:00Z")).toBe("2026-01-13T00:00:00.000Z");
  });

  it("finds a date that comes round rarely", () => {
    expect(next("0 0 29 2 *", "2026-03-01T00:00:00Z")).toBe("2028-02-29T00:00:00.000Z");
  });

  it("is read in the zone it names, through a change of clocks", () => {
    // New York moves its clocks forward on 2026-03-08: nine in the morning is 14:00Z
    // the day before and 13:00Z from then on.
    expect(next("0 9 * * *", "2026-03-07T00:00:00Z", "America/New_York")).toBe("2026-03-07T14:00:00.000Z");
    expect(next("0 9 * * *", "2026-03-07T15:00:00Z", "America/New_York")).toBe("2026-03-08T13:00:00.000Z");
  });

  it("does not fire at a time the zone skips, and fires once at a time it repeats", () => {
    // 02:30 does not happen in New York on 2026-03-08. The next one is the day after.
    expect(next("30 2 * * *", "2026-03-07T08:00:00Z", "America/New_York")).toBe("2026-03-09T06:30:00.000Z");
    // 01:30 happens twice on 2026-11-01. The first is taken, and the second is not a new tick.
    expect(next("30 1 * * *", "2026-10-31T12:00:00Z", "America/New_York")).toBe("2026-11-01T05:30:00.000Z");
    expect(next("30 1 * * *", "2026-11-01T05:30:00Z", "America/New_York")).toBe("2026-11-02T06:30:00.000Z");
  });

  it("is refused with what is wrong with it, where the clock is made", () => {
    expect(() => clock("c", { cron: "0 2 * *" })).toThrow("five fields");
    expect(() => clock("c", { cron: "61 2 * * *" })).toThrow("the minute field");
    expect(() => clock("c", { cron: "0 2 * * funday" })).toThrow("the day of week field");
    expect(() => clock("c", { cron: "0 0 31 2 *" })).toThrow("never falls due");
    expect(() => clock("c", { cron: "0 2 * * *", zone: "Mars/Olympus" })).toThrow("not a time zone");
    expect(() => clock("c", { every: 0 })).toThrow("greater than zero");
  });
});

/** A clock's time, moved only by the clock waiting or by the test. */
function time(start: string) {
  let now = at(start);
  return {
    now: () => now,
    sleep: async (ms: number) => void (now += ms),
    set: (iso: string) => void (now = at(iso)),
  };
}

/** The first `count` ticks a clock yields, continuing after `cursor`. */
async function ticks(source: ReturnType<typeof clock>, cursor: string | undefined, count: number): Promise<SourceEvent[]> {
  const stop = new AbortController();
  const found: SourceEvent[] = [];
  for await (const event of source.subscribe(cursor, stop.signal)) {
    found.push(event);
    if (found.length === count) stop.abort();
  }
  return found;
}

const when = (events: SourceEvent[]): string[] => events.map((each) => (each.event as Tick).scheduled);
const missed = (events: SourceEvent[]): number[] => events.map((each) => (each.event as Tick).missed);

describe("a clock", () => {
  it("ticks on an interval, each tick carrying when it was due as its cursor", async () => {
    const t = time("2026-01-01T00:00:00Z");
    const found = await ticks(clock("pulse", { every: 60 }, t), undefined, 3);

    expect(when(found)).toEqual(["2026-01-01T00:01:00.000Z", "2026-01-01T00:02:00.000Z", "2026-01-01T00:03:00.000Z"]);
    expect(found.map((each) => each.cursor)).toEqual(when(found));
    expect(missed(found)).toEqual([0, 0, 0]);
  });

  it("ticks by a cron expression", async () => {
    const t = time("2026-01-01T03:00:00Z");
    const found = await ticks(clock("nightly", { cron: "0 2 * * *" }, t), undefined, 2);
    expect(when(found)).toEqual(["2026-01-02T02:00:00.000Z", "2026-01-03T02:00:00.000Z"]);
  });

  it("owes nothing for the time before it first started", async () => {
    const t = time("2026-06-01T12:00:00Z");
    const [first] = await ticks(clock("nightly", { cron: "0 2 * * *" }, t), undefined, 1);
    expect((first!.event as Tick).scheduled).toBe("2026-06-02T02:00:00.000Z");
    expect((first!.event as Tick).missed).toBe(0);
  });

  it("stops when its signal aborts, without ticking again", async () => {
    const stop = new AbortController();
    const source = clock("pulse", { every: 3600 });
    const waiting = (async () => {
      const found: SourceEvent[] = [];
      for await (const event of source.subscribe(undefined, stop.signal)) found.push(event);
      return found;
    })();
    stop.abort();
    expect(await waiting).toEqual([]);
  });
});

describe("ticks that fell due while nothing was running", () => {
  // Stopped after the 02:00 tick on the 1st; looked at again at noon on the 4th.
  // Three ticks are owed: the 2nd, the 3rd and the 4th.
  const cursor = "2026-01-01T02:00:00.000Z";
  const back = "2026-01-04T12:00:00Z";

  it("by default run once, for the most recent, and say how many were skipped", async () => {
    const found = await ticks(clock("nightly", { cron: "0 2 * * *" }, time(back)), cursor, 2);
    expect(when(found)).toEqual(["2026-01-04T02:00:00.000Z", "2026-01-05T02:00:00.000Z"]);
    expect(missed(found)).toEqual([2, 0]);
  });

  it("run every one, oldest first, where the clock was asked to", async () => {
    const found = await ticks(clock("nightly", { cron: "0 2 * * *" }, { ...time(back), catchUp: "all" }), cursor, 4);
    expect(when(found)).toEqual([
      "2026-01-02T02:00:00.000Z",
      "2026-01-03T02:00:00.000Z",
      "2026-01-04T02:00:00.000Z",
      "2026-01-05T02:00:00.000Z",
    ]);
    expect(missed(found)).toEqual([0, 0, 0, 0]);
  });

  it("run not at all where it was asked to skip them, and the next tick carries the count", async () => {
    const found = await ticks(clock("nightly", { cron: "0 2 * * *" }, { ...time(back), catchUp: "none" }), cursor, 2);
    expect(when(found)).toEqual(["2026-01-05T02:00:00.000Z", "2026-01-06T02:00:00.000Z"]);
    expect(missed(found)).toEqual([3, 0]);
  });

  it("are not replayed one by one after an absence too long for that to mean anything", async () => {
    // Every second, away for a day: 86,400 owed.
    const t = { ...time("2026-01-02T00:00:00Z"), catchUp: "all" as const };
    const [first] = await ticks(clock("pulse", { every: 1 }, t), "2026-01-01T00:00:00.000Z", 1);
    expect((first!.event as Tick).scheduled).toBe("2026-01-02T00:00:00.000Z");
    expect((first!.event as Tick).missed).toBe(1000);
  });

  it("run once when a run outlasts the gap between two ticks", async () => {
    const t = time("2026-01-01T00:00:00Z");
    const stop = new AbortController();
    const found: SourceEvent[] = [];
    for await (const event of clock("pulse", { every: 60 }, t).subscribe(undefined, stop.signal)) {
      found.push(event);
      // The first tick's run takes three and a half minutes.
      if (found.length === 1) t.set("2026-01-01T00:04:30Z");
      if (found.length === 3) stop.abort();
    }
    expect(when(found)).toEqual(["2026-01-01T00:01:00.000Z", "2026-01-01T00:04:00.000Z", "2026-01-01T00:05:00.000Z"]);
    expect(missed(found)).toEqual([0, 2, 0]);
  });
});

describe("a workflow on a clock", () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map(cleanup)));

  it("starts a run per tick, and a restart neither repeats one nor skips one without saying", async () => {
    const root = await makeProject({
      "praecise.config.ts": `import { defineConfig } from "${FRAMEWORK}";
        export default defineConfig({ name: "acme", ${TEST_ENDPOINT} });`,
      "functions/note.ts": `import { fn } from "${FRAMEWORK}";
        export default fn({
          description: "Note a tick.",
          input: { due: "when it was due", missed: "how many were skipped" },
          run: ({ due, missed }) => { globalThis.__ticks = (globalThis.__ticks ?? []).concat(due + " missed " + missed); return due; },
        });`,
      "workflows/report.ts": `import { workflow } from "${FRAMEWORK}";
        export default workflow({
          description: "Report.",
          steps: [{ id: "note", use: "note", with: { due: "{{event.scheduled}}", missed: "{{event.missed}}" } }],
        });`,
    });
    roots.push(root);
    const seen = globalThis as { __ticks?: string[] };
    seen.__ticks = [];

    /** Follow the clock until it has started `count` runs, as one life of a process. */
    const life = async (t: ReturnType<typeof time>, count: number): Promise<string[]> => {
      const app = await App.load({ root, env: MODEL_ENV });
      const stop = new AbortController();
      const ids: string[] = [];
      await app.follow(clock("nightly", { cron: "0 2 * * *" }, t), "report", {
        signal: stop.signal,
        onRun: (run) => {
          ids.push(run.id);
          if (ids.length === count) stop.abort();
        },
      });
      await app.close();
      return ids;
    };

    const first = await life(time("2026-01-01T00:00:00Z"), 2);
    expect(seen.__ticks).toEqual(["2026-01-01T02:00:00.000Z missed 0", "2026-01-02T02:00:00.000Z missed 0"]);

    // Down for three days. The 3rd and the 4th are skipped, and the run for the 5th says so.
    const second = await life(time("2026-01-05T09:00:00Z"), 2);
    expect(seen.__ticks?.slice(2)).toEqual(["2026-01-05T02:00:00.000Z missed 2", "2026-01-06T02:00:00.000Z missed 0"]);
    expect(new Set([...first, ...second]).size).toBe(4);

    // A tick handed over again, as when the process died before its cursor was stored,
    // finds the run it already started.
    const app = await App.load({ root, env: MODEL_ENV });
    const again: string[] = [];
    const replay = {
      name: "nightly",
      async *subscribe() {
        yield { cursor: "2026-01-06T02:00:00.000Z", event: { scheduled: "2026-01-06T02:00:00.000Z", missed: 0 } };
      },
    };
    await app.follow(replay, "report", { signal: new AbortController().signal, onRun: (run) => again.push(run.id) });
    await app.close();
    expect(again).toEqual([second[1]]);
    expect(seen.__ticks).toHaveLength(4);
  });
});
