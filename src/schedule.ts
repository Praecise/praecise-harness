/**
 * A clock, as a source: runs that start because it is time.
 *
 * Nothing about a schedule needs a mechanism of its own. A tick is an event, the
 * moment it was due is its cursor, and `App.follow` already does the rest: it
 * stores the cursor of the last tick handled, names each run from the source and
 * the cursor, and so a tick delivered twice finds the run it already started.
 *
 *     await app.follow(clock("nightly", { cron: "0 2 * * *", zone: "Europe/Lisbon" }), "report", { signal });
 *
 * ── What happens to ticks nobody was there for ───────────────────────────────
 *
 * The process was down, or a run took longer than the gap between two ticks. When
 * the clock is next looked at, some number of ticks are already due. The rule is
 * `catchUp`, and the default is `"latest"`:
 *
 *   `"latest"`  one run, for the most recent tick that was due. The ticks before
 *               it are not run, and the event says how many (`missed`), so they
 *               are skipped out loud. This is right for work that brings
 *               something up to date: running it once is the same as running it
 *               five times.
 *   `"all"`     a run for every tick that was due, oldest first. For work where
 *               each tick stands for its own slice of time. Past a thousand owed
 *               the clock was away too long for a replay to mean anything: the
 *               most recent one runs, and `missed` says a thousand.
 *   `"none"`    no run for any tick that fell due while the clock was not
 *               running. The next tick to fall due carries the count in `missed`.
 *               Once running it behaves as `"latest"`: a tick that falls due
 *               while a run is still going is a tick the clock was there for.
 *
 * A clock started for the first time owes nothing: its first tick is the next one
 * to fall due after it starts. Nothing fires for the time before a clock existed.
 *
 * The cursor is the due time, not the time the run started, so a restart neither
 * repeats a tick (its run is found by name) nor loses one (everything after the
 * cursor is still owed, and the rule above says what is done about it).
 */

import type { Source, SourceEvent } from "./sources.js";

/** When a clock ticks: every so many seconds, or by a cron expression. */
export type Schedule =
  | { every: number }
  | {
      /**
       * Five fields: minute, hour, day of month, month, day of week. Each is `*`,
       * a number, a range (`1-5`), a list (`1,15`), or a range or `*` with a step
       * after a slash (`0-59/15`, `9-17/2`). Months and days of the week may be named (`jan`, `mon`),
       * and Sunday is 0 or 7. When both day fields are restricted a day matches if
       * either does, as cron has always had it.
       */
      cron: string;
      /**
       * The IANA time zone the fields are read in. Default UTC. Where a zone skips an
       * hour, a time inside the skipped hour does not occur that day and does not
       * fire; where it repeats one, a time inside it fires once.
       */
      zone?: string;
    };

/** What a run started by a clock receives as its `event`. */
export interface Tick {
  /** When this tick was due, RFC 3339. Also the cursor. */
  scheduled: string;
  /** How many earlier ticks fell due and were given no run. */
  missed: number;
}

export interface ClockOptions {
  /** What to do about ticks that fell due with nobody there. Default `"latest"`. */
  catchUp?: "latest" | "all" | "none";
  /** The time, for a test that cannot wait for it. */
  now?: () => number;
  /** How to wait, for the same test. Resolves early when `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** The most ticks counted or replayed in one catch-up. Past it, `missed` says this many. */
const MOST_OWED = 1000;

/** The longest one timer is set for; a longer wait is several. */
const LONGEST_TIMER = 2 ** 31 - 1;

const MINUTE = 60_000;

/**
 * A source that yields a tick each time the schedule falls due.
 *
 * `name` names the stored cursor, so two clocks need two names, and renaming one
 * starts it afresh.
 */
export function clock(name: string, schedule: Schedule, options: ClockOptions = {}): Source {
  const next = nextOf(schedule);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? wait;
  const rule = options.catchUp ?? "latest";

  return {
    name,
    async *subscribe(cursor, signal): AsyncGenerator<SourceEvent> {
      const stored = cursor === undefined ? NaN : Date.parse(cursor);
      // No cursor, or one that is not a time: a clock that has not ticked yet.
      let last = Number.isNaN(stored) ? now() : stored;
      let missed = 0;
      const tick = (at: number): SourceEvent => {
        const scheduled = new Date(at).toISOString();
        const event: Tick = { scheduled, missed };
        missed = 0;
        last = at;
        return { cursor: scheduled, event };
      };

      // Ticks that are due the first time the clock is looked at fell due before
      // it was running. After that, a tick that is due is one it was there for.
      let starting = true;
      while (!signal.aborted) {
        const owed = dueBetween(next, last, now());
        if (!owed.times.length) {
          starting = false;
          await sleep(Math.min(Math.max(0, next(last) - now()), LONGEST_TIMER), signal);
          continue;
        }
        const latest = owed.times[owed.times.length - 1]!;
        if (rule === "none" && starting) {
          missed += owed.dropped + owed.times.length;
          last = latest;
        } else if (rule === "all") {
          missed += owed.dropped;
          for (const at of owed.times) {
            if (signal.aborted) return;
            yield tick(at);
          }
        } else {
          missed += owed.dropped + owed.times.length - 1;
          yield tick(latest);
        }
        starting = false;
      }
    },
  };
}

/**
 * The ticks due after `after` and no later than `until`, oldest first.
 *
 * Bounded: a clock that ticks every second and was down for a month owes more
 * than is worth listing, or counting. Past the bound only the most recent tick
 * is answered with, and `dropped` is the bound: that many or more.
 */
function dueBetween(
  next: (after: number) => number,
  after: number,
  until: number,
): { times: number[]; dropped: number } {
  const times: number[] = [];
  for (let at = next(after); at <= until; at = next(at)) {
    times.push(at);
    if (times.length > MOST_OWED) return { times: [latestBefore(next, at, until)], dropped: MOST_OWED };
  }
  return { times, dropped: 0 };
}

/**
 * The last tick at or before `until`, given one (`known`) that is.
 *
 * Found by looking back a widening way and not by walking forward from `known`,
 * which for a clock that was away a year is every tick of the year.
 */
function latestBefore(next: (after: number) => number, known: number, until: number): number {
  for (const back of [MINUTE, 60 * MINUTE, 24 * 60 * MINUTE, 32 * 24 * 60 * MINUTE]) {
    if (until - back <= known) break;
    let latest: number | undefined;
    for (let at = next(until - back); at <= until; at = next(at)) latest = at;
    if (latest !== undefined) return latest;
  }
  let latest = known;
  for (let at = next(known); at <= until; at = next(at)) latest = at;
  return latest;
}

/** Resolves after `ms`, or as soon as `signal` aborts. Never rejects. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done) => {
    if (signal.aborted) return done();
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      done();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** The function from one tick to the next, for a schedule. Throws on one that cannot be read. */
function nextOf(schedule: Schedule): (after: number) => number {
  if ("every" in schedule) {
    const gap = schedule.every * 1000;
    if (!(gap >= 1)) {
      throw new Error(
        `a clock's \`every\` is a number of seconds greater than zero; got ${JSON.stringify(schedule.every)}`,
      );
    }
    return (after) => after + gap;
  }
  const fields = parseCron(schedule.cron);
  const zone = schedule.zone;
  // Asked once now, so a zone nobody knows or a date that never comes (the 31st
  // of February) is refused where the clock is made and not on its first tick.
  nextCronTime(fields, Date.now(), zone);
  return (after) => nextCronTime(fields, after, zone);
}

/** The next time a cron expression falls due after `after`, in milliseconds since the epoch. */
export function cronNext(expression: string, after: number | Date, zone?: string): number {
  return nextCronTime(parseCron(expression), typeof after === "number" ? after : after.getTime(), zone);
}

interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  /** Whether the day of month and day of week were restricted. Both ⇒ either matches. */
  dayGiven: boolean;
  weekdayGiven: boolean;
  source: string;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function parseCron(expression: string): CronFields {
  const parts = String(expression ?? "").trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `a cron expression has five fields — minute, hour, day of month, month, day of week — and ${JSON.stringify(expression)} has ${parts.length}. ` +
        `"0 2 * * *" is two in the morning every day.`,
    );
  }
  const field = (text: string, low: number, high: number, what: string, names?: string[]): Set<number> => {
    const found = new Set<number>();
    const bad = (): never => {
      throw new Error(
        `the ${what} field of the cron expression ${JSON.stringify(expression)} is ${JSON.stringify(text)}, which is not a number from ${low} to ${high}, a range, a list or a step of those`,
      );
    };
    const number = (word: string): number => {
      const named = names?.indexOf(word.toLowerCase()) ?? -1;
      if (named >= 0) return named + (what === "month" ? 1 : 0);
      if (!/^\d+$/.test(word)) bad();
      return Number(word);
    };
    for (const item of text.split(",")) {
      const [range, stepText] = item.split("/") as [string, string | undefined];
      const step = stepText === undefined ? 1 : /^\d+$/.test(stepText) ? Number(stepText) : bad();
      if (step < 1 || item.split("/").length > 2) bad();
      let from: number;
      let to: number;
      if (range === "*") [from, to] = [low, high];
      else if (range.includes("-")) {
        const ends = range.split("-");
        if (ends.length !== 2) bad();
        [from, to] = [number(ends[0]!), number(ends[1]!)];
      } else {
        from = number(range);
        // `5/15` means from five onward, as cron reads it.
        to = stepText === undefined ? from : high;
      }
      if (from < low || to > high || from > to) bad();
      for (let value = from; value <= to; value += step) found.add(value);
    }
    return found;
  };

  const weekdays = field(parts[4]!, 0, 7, "day of week", WEEKDAYS);
  if (weekdays.delete(7)) weekdays.add(0);
  return {
    minutes: field(parts[0]!, 0, 59, "minute"),
    hours: field(parts[1]!, 0, 23, "hour"),
    days: field(parts[2]!, 1, 31, "day of month"),
    months: field(parts[3]!, 1, 12, "month", MONTHS),
    weekdays,
    dayGiven: !parts[2]!.startsWith("*"),
    weekdayGiven: !parts[4]!.startsWith("*"),
    source: expression,
  };
}

/**
 * The next wall-clock minute the fields match, strictly after `wall`.
 *
 * `wall` is a wall-clock time written as though it were UTC, which lets the
 * calendar arithmetic be `Date`'s without any zone getting in. Whole months,
 * days and hours that cannot match are stepped over, so a yearly schedule is a
 * few dozen steps and not half a million.
 */
function nextWall(fields: CronFields, wall: number): number | undefined {
  let at = Math.floor(wall / MINUTE) * MINUTE + MINUTE;
  // Eight years covers the longest gap a matchable expression has: 29 February
  // falling on one given day of the week.
  const limit = at + 8 * 366 * 24 * 60 * MINUTE;
  while (at <= limit) {
    const date = new Date(at);
    const [year, month, day] = [date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()];
    if (!fields.months.has(month + 1)) {
      at = Date.UTC(year, month + 1, 1);
      continue;
    }
    const onDay = fields.days.has(day);
    const onWeekday = fields.weekdays.has(date.getUTCDay());
    const matches = fields.dayGiven && fields.weekdayGiven ? onDay || onWeekday : onDay && onWeekday;
    if (!matches) {
      at = Date.UTC(year, month, day + 1);
      continue;
    }
    if (!fields.hours.has(date.getUTCHours())) {
      at = Date.UTC(year, month, day, date.getUTCHours() + 1);
      continue;
    }
    if (!fields.minutes.has(date.getUTCMinutes())) {
      at += MINUTE;
      continue;
    }
    return at;
  }
  return undefined;
}

function nextCronTime(fields: CronFields, after: number, zone: string | undefined): number {
  const never = (): never => {
    throw new Error(
      `the cron expression ${JSON.stringify(fields.source)} never falls due: no date matches it. Check the day and month fields.`,
    );
  };
  if (zone === undefined) return nextWall(fields, after) ?? never();

  // Start a minute back on the wall clock: where a zone repeats an hour, the
  // wall clock at `after` may already be past a time whose second occurrence is
  // still to come.
  let wall = after + offsetAt(after, zone) - MINUTE;
  for (let tries = 0; tries < 10_000; tries++) {
    const found = nextWall(fields, wall) ?? never();
    const instant = instantOf(found, zone);
    // Not a time that exists (the zone skipped it), or one already had: look on.
    if (instant !== undefined && instant > after) return instant;
    wall = found;
  }
  return never();
}

const formats = new Map<string, Intl.DateTimeFormat>();

/** How far a zone's wall clock is ahead of UTC at an instant, in milliseconds. */
function offsetAt(instant: number, zone: string): number {
  let format = formats.get(zone);
  if (!format) {
    try {
      format = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
      });
    } catch {
      throw new Error(
        `${JSON.stringify(zone)} is not a time zone this runtime knows. Use an IANA name such as "Europe/Lisbon" or "America/New_York", or leave \`zone\` out for UTC.`,
      );
    }
    formats.set(zone, format);
  }
  const part: Record<string, number> = {};
  for (const { type, value } of format.formatToParts(new Date(instant))) part[type] = Number(value);
  const wall = Date.UTC(part.year!, part.month! - 1, part.day!, part.hour!, part.minute!, part.second!);
  return wall - Math.floor(instant / 1000) * 1000;
}

/** The instant a wall-clock time in a zone is, or nothing where the zone skips that time. */
function instantOf(wall: number, zone: string): number | undefined {
  // Two guesses, because the offset to subtract is the one in force at the
  // answer, which is not known until there is an answer to ask about. The
  // earlier of the two is tried first, so a repeated hour gives its first pass.
  const first = wall - offsetAt(wall, zone);
  const second = wall - offsetAt(first, zone);
  for (const guess of first <= second ? [first, second] : [second, first]) {
    if (guess + offsetAt(guess, zone) === wall) return guess;
  }
  return undefined;
}
