/**
 * Recorded exchanges, and the eval cases made from them.
 *
 * A case somebody wrote says what they expected to be asked. A recording says what was
 * asked, which is a different list, and the second one is where an agent that passes
 * its evals still lets people down. So an exchange can be kept as it happened — the
 * question, what every tool returned, the answer — and turned into a case that asks the
 * same question against the same tool results and compares what comes back with what
 * was said the first time.
 *
 * The tool results are what make that a replay rather than a second run. A tool is the
 * part of an agent that changes between Tuesday and Wednesday: the order shipped, the
 * price moved, the refund already went out. Answering each call from the recording
 * holds the world still, so a difference in the answer is a difference in the agent,
 * and nothing with a side effect is done twice.
 *
 * Everything here is redacted on the way in and again on the way out. A recording is a
 * file under the state directory and a captured case is a file in the repository, and
 * neither is a place for a credential a tool happened to print.
 */

import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { EvalCase, RecordedTool } from "../define.js";
import type { ToolTape } from "../harness/types.js";
import { canonicalJson } from "../journal.js";
import { redact } from "../redact.js";
import type { Run } from "../workflow/store.js";

/** One exchange with an agent, as it happened. */
export interface Recording {
  id: string;
  at: number;
  agent: string;
  input: string;
  answer: string;
  /** The structured result, where the agent declared one. */
  data?: unknown;
  /** Every tool call, in the order the results came back. */
  tools: RecordedTool[];
  /**
   * Why asking the same question again would not be the same exchange, when it would
   * not: it was a turn of a conversation, or something was sent with it. Such a
   * recording is kept and is not made into a case.
   */
  partial?: string;
  /** The trace the exchange was part of, when it arrived inside one. */
  traceId?: string;
}

/** Where recordings go. The app calls it after the answer has been returned. */
export type Recorder = (recording: Recording) => void | Promise<void>;

/** A recording past this is kept without its tool results, and says so. */
const RECORDING_MAX = 1_000_000;

/** A copy with every string in it redacted. Keys are left as they are. */
export function redacted<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((item) => redacted(item)) as T;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = redacted(item);
    return out as T;
  }
  return value;
}

/** A new recording's id: short enough to type, long enough not to collide in a folder. */
export const newRecordingId = (): string => randomBytes(6).toString("hex");

/** A tape that writes down what each tool call returned. */
export function recordingTape(): { tape: ToolTape; tools: RecordedTool[] } {
  const tools: RecordedTool[] = [];
  return {
    tools,
    tape: {
      record: (call, result) =>
        void tools.push({
          name: call.name,
          args: call.args,
          result: result.text,
          ...(result.failed ? { failed: true as const } : {}),
        }),
    },
  };
}

const keyOf = (name: string, args: unknown): string => `${name}\n${canonicalJson(args ?? {})}`;

/**
 * A tape that answers tool calls from a recording.
 *
 * A call is matched by its name and its arguments, and the same call made twice is
 * given the first result and then the second; made a third time, it is given the last
 * one again, since a tool asked the same thing would most likely have said the same.
 * A call the recording does not hold is NOT passed through to the tool — that would run
 * something for real in the middle of a replay — and is answered with an error the
 * model can read. Each one is listed in `misses`.
 */
export function replayTape(recorded: readonly RecordedTool[]): { tape: ToolTape; misses: string[] } {
  const held = new Map<string, RecordedTool[]>();
  for (const tool of recorded) {
    const key = keyOf(tool.name, tool.args);
    held.set(key, [...(held.get(key) ?? []), tool]);
  }
  const misses: string[] = [];
  return {
    misses,
    tape: {
      play: (call) => {
        const queue = held.get(keyOf(call.name, call.args));
        if (!queue) {
          misses.push(`replay: ${call.name} was called with arguments the recorded run never used`);
          return {
            text:
              `Error: this is a replay of a recorded run, and that run made no call to ${call.name} with these ` +
              "arguments, so there is no result to give. Tools are not run during a replay.",
            failed: true,
          };
        }
        const next = queue.length > 1 ? queue.shift()! : queue[0]!;
        return { text: next.result, failed: next.failed === true };
      },
    },
  };
}

/**
 * Recordings kept as files: one per agent, a line per exchange.
 *
 * Appended to and never rewritten, so two requests finishing together cannot lose each
 * other's line, and a recording is on disk before anything is done with it.
 */
export class Recordings {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private fileOf(agent: string): string {
    return join(this.dir, `${encodeURIComponent(agent)}.jsonl`);
  }

  /** The recorder to hand an app. */
  get recorder(): Recorder {
    return (recording) => this.write(recording);
  }

  async write(recording: Recording): Promise<void> {
    let safe = redacted(recording);
    let line = JSON.stringify(safe);
    if (line.length > RECORDING_MAX) {
      safe = { ...safe, tools: [], partial: "its tool results were too large to keep" };
      line = JSON.stringify(safe);
      if (line.length > RECORDING_MAX) return;
    }
    // Owner-only, like the run records beside them: these are what people asked.
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await appendFile(this.fileOf(recording.agent), `${line}\n`, { encoding: "utf8", mode: 0o600 });
  }

  /** An agent's recordings, oldest first; the most recent `last` when given. */
  async read(agent: string, options: { last?: number } = {}): Promise<Recording[]> {
    const text = await readFile(this.fileOf(agent), "utf8").catch(() => "");
    const out: Recording[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as Recording;
        if (parsed && typeof parsed.input === "string" && typeof parsed.answer === "string") out.push(parsed);
      } catch {
        // A line cut short by a crash is one exchange lost, not a reason to lose the rest.
      }
    }
    return options.last !== undefined ? out.slice(-options.last) : out;
  }
}

/** How a captured case compares a new answer with the recorded one. */
export type ReferenceMode = "judge" | "exact";

const titleOf = (text: string, id: string): string => {
  const words = text.replace(/\s+/g, " ").trim();
  return `${words.length > 60 ? `${words.slice(0, 60)}…` : words} (${id})`;
};

/**
 * Turn recordings into cases, each replaying its own tool results and holding the new
 * answer to the recorded one.
 *
 * A recording that could not be asked again as it stands — a turn of a conversation, a
 * question sent with a file — is left out and named in `skipped`, because a case made
 * from half an exchange fails for reasons that have nothing to do with the agent.
 */
export function casesFromRecordings(
  recordings: readonly Recording[],
  mode: ReferenceMode = "judge",
): { cases: EvalCase<string>[]; skipped: { id: string; why: string }[] } {
  const cases: EvalCase<string>[] = [];
  const skipped: { id: string; why: string }[] = [];
  for (const recording of recordings) {
    if (recording.partial) {
      skipped.push({ id: recording.id, why: recording.partial });
      continue;
    }
    if (!recording.input.trim()) {
      skipped.push({ id: recording.id, why: "nothing was asked" });
      continue;
    }
    const safe = redacted(recording);
    cases.push({
      name: titleOf(safe.input, safe.id),
      input: safe.input,
      expect: [{ reference: mode }],
      recorded: {
        answer: safe.answer,
        ...(safe.data !== undefined ? { data: safe.data } : {}),
        tools: safe.tools ?? [],
        at: safe.at,
        id: safe.id,
      },
    });
  }
  return { cases, skipped };
}

/**
 * Turn finished workflow runs into cases that hold a new result to the recorded one.
 *
 * A workflow case is run as it stands: its steps call what they call. Only an agent's
 * tool calls are replayed, so capture a workflow whose effects are harmless to repeat.
 */
export function casesFromRuns(
  runs: readonly Run[],
  mode: ReferenceMode = "judge",
): { cases: EvalCase<Record<string, unknown>>[]; skipped: { id: string; why: string }[] } {
  const cases: EvalCase<Record<string, unknown>>[] = [];
  const skipped: { id: string; why: string }[] = [];
  for (const run of runs) {
    if (run.status !== "done") {
      skipped.push({ id: run.id, why: `the run ended as "${run.status}"` });
      continue;
    }
    const result = redacted(run.result);
    cases.push({
      name: titleOf(JSON.stringify(redacted(run.input)), run.id.slice(0, 12)),
      input: redacted(run.input),
      expect: [{ reference: mode }],
      recorded: {
        answer: typeof result === "string" ? result : JSON.stringify(result ?? null),
        // A text result is compared as text; anything else field for field.
        ...(typeof result === "string" || result === undefined ? {} : { data: result }),
        at: run.startedAt,
        id: run.id,
      },
    });
  }
  return { cases, skipped };
}

/**
 * A captured suite, as the file that goes in `evals/`.
 *
 * Written as an ordinary suite so it is read, edited and reviewed like one: a case that
 * should not be there is deleted, and a grader that says more than "same as last time"
 * is added beside the one that is.
 */
export function renderCapturedSuite(
  target: { agent: string } | { workflow: string },
  cases: readonly EvalCase[],
  options: { from?: string; capturedAt?: number } = {},
): string {
  const on = "agent" in target ? `agent: ${JSON.stringify(target.agent)}` : `workflow: ${JSON.stringify(target.workflow)}`;
  const body = JSON.stringify(cases, null, 2)
    .split("\n")
    .map((line, at) => (at === 0 ? line : `  ${line}`))
    .join("\n");
  return [
    `import { evaluation } from ${JSON.stringify(options.from ?? "@praecise/harness")};`,
    "",
    `// Captured from recorded runs on ${new Date(options.capturedAt ?? Date.now()).toISOString().slice(0, 10)}.`,
    "// Each case asks what was asked then and compares the new answer with the recorded one.",
    "agent" in target
      ? "// Tool calls are answered from `recorded.tools` and no tool is run."
      : "// The workflow is run as it stands: its steps call what they call.",
    "// Read these before committing them: they are what people really sent.",
    "export default evaluation({",
    `  ${on},`,
    `  cases: ${body},`,
    "});",
    "",
  ].join("\n");
}
