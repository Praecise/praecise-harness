/**
 * Deciding whether one answer met one expectation.
 *
 * Everything here reads the answer and nothing reads the route to it: the text,
 * the structured result, and which tools were reached for — as a set, never as
 * a sequence. An eval that pinned the order of the steps would fail an agent
 * for finding a shorter way.
 */

import type { EvalCase, Grader } from "../define.js";
import type { Answer } from "../harness/types.js";
import type { Verdict } from "../workflow/judge.js";
import { graderKinds } from "./defects.js";

/**
 * Grade a rubric against some material. `agent` names whose models to judge on.
 *
 * The app supplies the judge the workflows already use, told it may answer
 * "unknown". Taken as a function so that grading can be tested without a model.
 */
export type EvalJudge = (rubric: string, material: string, agent?: string) => Promise<Verdict>;

export interface Graded {
  /** `unknown` is a judge that could not tell: neither a pass nor a failure. */
  status: "passed" | "failed" | "unknown";
  /** Why, when it did not pass. */
  reason?: string;
  /** What grading itself cost — only a judge spends anything. */
  tokens?: number;
}

const PASSED: Graded = { status: "passed" };
const failed = (reason: string): Graded => ({ status: "failed", reason });
const listOf = (value: string | string[]): string[] => (Array.isArray(value) ? value : [value]);
const shown = (value: unknown): string => {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
};

/** Structural equality. Key order is not a difference; a missing key and `undefined` are the same. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    return a.length === other.length && a.every((item, at) => deepEqual(item, other[at]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) if (!deepEqual(left[key], right[key])) return false;
  return true;
}

/**
 * The first place `actual` fails to carry what `wanted` asks for, as a path.
 *
 * Objects are matched as subsets all the way down, so `{ order: { status: "paid" } }`
 * holds of an order with twenty other fields. A list is compared whole: "these
 * items, and others" is not something a list can say without also saying where.
 */
export function missingField(wanted: unknown, actual: unknown, path = ""): string | undefined {
  const plain = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (!plain(wanted)) return deepEqual(wanted, actual) ? undefined : path || "(the result)";
  if (!plain(actual)) return path || "(the result)";
  for (const [key, value] of Object.entries(wanted)) {
    const at = missingField(value, actual[key], path ? `${path}.${key}` : key);
    if (at) return at;
  }
  return undefined;
}

/**
 * Whether a call the model made is the tool an author named.
 *
 * A function is called by its own name. A service's tool reaches the model as
 * `service__tool`, and an author writes it as `service.tool` or just `tool`, so
 * all three spellings name the same call.
 */
function names(called: string, wanted: string): boolean {
  if (called === wanted) return true;
  const at = called.indexOf("__");
  if (at <= 0) return false;
  const tool = called.slice(at + 2);
  return tool === wanted || `${called.slice(0, at)}.${tool}` === wanted;
}

/** What the judge is shown: the answer, and never how it was reached. */
const MATERIAL = 20_000;
function materialOf(answer: Answer): string {
  const text = answer.text.trim() || (answer.data === undefined ? "" : JSON.stringify(answer.data, null, 2));
  return text.slice(0, MATERIAL);
}

/**
 * What a regression is, said to a judge.
 *
 * Wording is free to change and the content is not: a new answer that says the same
 * thing in other words has not regressed, and one that drops or contradicts something
 * the recorded answer said has.
 */
const SAME_AS_RECORDED =
  "The NEW ANSWER says the same thing as the RECORDED ANSWER: every fact, figure and decision in the " +
  "recorded answer is in the new one, and nothing in the new one contradicts it. Different wording, " +
  "order or length is not a difference.";

/** Both answers, each given half the room, so a long one cannot push the other out. */
function sideBySide(recorded: string, current: string): string {
  const half = MATERIAL / 2;
  return `RECORDED ANSWER:\n${recorded.slice(0, half)}\n\nNEW ANSWER:\n${current.slice(0, half)}`;
}

/** Grade one answer against one grader. Never throws: a grader that breaks is a failure with a reason. */
export async function grade(
  grader: Grader,
  answer: Answer,
  test: EvalCase,
  judge: EvalJudge,
): Promise<Graded> {
  const [kind] = graderKinds(grader);
  const called = answer.toolCalls.map((call) => call.name);

  if ("contains" in grader && kind === "contains") {
    const absent = listOf(grader.contains).filter((part) => !answer.text.includes(part));
    return absent.length ? failed(`the answer does not contain ${absent.map(shown).join(", ")}`) : PASSED;
  }
  if ("excludes" in grader && kind === "excludes") {
    const present = listOf(grader.excludes).filter((part) => answer.text.includes(part));
    return present.length ? failed(`the answer contains ${present.map(shown).join(", ")}`) : PASSED;
  }
  if ("matches" in grader && kind === "matches") {
    return new RegExp(grader.matches).test(answer.text)
      ? PASSED
      : failed(`the answer does not match /${grader.matches}/`);
  }
  if ("equals" in grader && kind === "equals") {
    return deepEqual(grader.equals, answer.data)
      ? PASSED
      : failed(`the result is ${shown(answer.data)}, not ${shown(grader.equals)}`);
  }
  if ("fields" in grader && kind === "fields") {
    const at = missingField(grader.fields, answer.data);
    return at ? failed(`the result's ${at} is not what was expected (got ${shown(answer.data)})`) : PASSED;
  }
  if ("calls" in grader && kind === "calls") {
    const uncalled = listOf(grader.calls).filter((wanted) => !called.some((name) => names(name, wanted)));
    return uncalled.length
      ? failed(`${uncalled.join(", ")} was not called (called: ${called.join(", ") || "nothing"})`)
      : PASSED;
  }
  if ("avoids" in grader && kind === "avoids") {
    const reached = listOf(grader.avoids).filter((unwanted) => called.some((name) => names(name, unwanted)));
    return reached.length ? failed(`${reached.join(", ")} was called, and should not have been`) : PASSED;
  }
  if ("judge" in grader && kind === "judge") {
    const verdict = await judge(grader.judge, materialOf(answer), grader.agent);
    const why = verdict.why.slice(0, 500);
    if (verdict.unknown) {
      return { status: "unknown", reason: `the judge could not tell: ${why || "it gave no reason"}`, tokens: verdict.tokens };
    }
    return verdict.holds
      ? { status: "passed", tokens: verdict.tokens }
      : { status: "failed", reason: `judged not to hold: ${why || grader.judge}`, tokens: verdict.tokens };
  }
  if ("reference" in grader && kind === "reference") {
    const recorded = test.recorded;
    if (!recorded) return failed("there is no recorded answer on this case to compare with");
    // A structured result has a right answer field for field, and no model is asked.
    if (recorded.data !== undefined) {
      return deepEqual(recorded.data, answer.data)
        ? PASSED
        : failed(`the result is ${shown(answer.data)}, where the recorded run gave ${shown(recorded.data)}`);
    }
    const now = answer.text.trim();
    const then = recorded.answer.trim();
    if (now === then) return PASSED;
    if (grader.reference === "exact") return failed(`the answer is not the recorded one (recorded: ${shown(then)})`);
    const verdict = await judge(SAME_AS_RECORDED, sideBySide(then, materialOf(answer)), grader.agent);
    const why = verdict.why.slice(0, 500);
    if (verdict.unknown) {
      return { status: "unknown", reason: `the judge could not tell: ${why || "it gave no reason"}`, tokens: verdict.tokens };
    }
    return verdict.holds
      ? { status: "passed", tokens: verdict.tokens }
      : { status: "failed", reason: `differs from the recorded answer: ${why || "the judge gave no reason"}`, tokens: verdict.tokens };
  }
  if ("check" in grader && kind === "check") {
    try {
      const said = await grader.check(answer, test);
      if (said === true) return PASSED;
      return failed(typeof said === "string" && said ? said : "the `check` returned false");
    } catch (err) {
      return failed(`the \`check\` threw: ${(err as Error).message}`);
    }
  }
  return failed("this grader is not one the runner knows");
}
