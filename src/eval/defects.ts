/**
 * What is wrong with an eval suite, as sentences.
 *
 * One function, read twice: the loader reports these when the folder is read,
 * and the runner refuses on them before anything is asked. The failure this
 * exists for is a suite that passes because it checks nothing — a case with no
 * graders, a suite with no cases — which is a green result that says only that
 * the file parsed.
 */

import { GRADER_KINDS, type EvaluationSpec, type Grader, type GraderKind } from "../define.js";

/** Which discriminants a grader carries. Exactly one is a grader. */
export function graderKinds(grader: Grader): GraderKind[] {
  if (!grader || typeof grader !== "object") return [];
  const held = grader as Record<string, unknown>;
  return GRADER_KINDS.filter((kind) => Object.hasOwn(held, kind) && held[kind] !== undefined);
}

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isTextOrList = (value: unknown): boolean =>
  isText(value) || (Array.isArray(value) && value.length > 0 && value.every(isText));
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What a grader's value has to be, and how to say so when it is not. */
function graderFault(grader: Grader, kind: GraderKind, agents?: string[]): string | undefined {
  const value = (grader as Record<string, unknown>)[kind];
  switch (kind) {
    case "contains":
    case "excludes":
    case "calls":
    case "avoids":
      return isTextOrList(value) ? undefined : `\`${kind}\` takes a string or a list of strings`;
    case "matches":
      if (!isText(value)) return "`matches` takes a regular expression source, as a string";
      try {
        // Compiled only to find out whether it can be.
        RegExp(value);
        return undefined;
      } catch (err) {
        return `\`matches\` is not a regular expression: ${(err as Error).message}`;
      }
    case "fields":
      return isRecord(value) && Object.keys(value).length
        ? undefined
        : "`fields` takes an object naming at least one field";
    case "judge": {
      if (!isText(value) || !value.trim()) return "`judge` takes the rubric to grade against, as a sentence";
      const lender = (grader as { agent?: unknown }).agent;
      if (lender === undefined) return undefined;
      if (!isText(lender)) return "`judge.agent` takes an agent's name";
      return agents && !agents.includes(lender) ? `\`judge\` names unknown agent "${lender}"` : undefined;
    }
    case "check":
      return typeof value === "function" ? undefined : "`check` takes a function of the answer";
    case "equals":
      return undefined;
  }
}

/**
 * Every reason this suite cannot be run as written.
 *
 * `known` is the app's agents and workflows. Left out, the target's existence
 * is not checked — the runner is handed something to ask and cannot see what
 * else the app holds.
 */
export function evaluationFaults(
  name: string,
  spec: EvaluationSpec,
  known?: { agents: string[]; workflows: string[] },
): string[] {
  const faults: string[] = [];
  const say = (text: string): void => void faults.push(`eval "${name}": ${text}`);

  const targets = [spec.agent, spec.workflow].filter((target) => target !== undefined);
  if (targets.length !== 1) {
    say(
      targets.length
        ? "names both an `agent` and a `workflow`; a suite tests one thing, so split it in two"
        : "names nothing to test; set `agent` or `workflow`",
    );
  } else if (known && spec.agent !== undefined && !known.agents.includes(spec.agent)) {
    say(`tests unknown agent "${spec.agent}" (known: ${known.agents.join(", ") || "none"})`);
  } else if (known && spec.workflow !== undefined && !known.workflows.includes(spec.workflow)) {
    say(`tests unknown workflow "${spec.workflow}" (known: ${known.workflows.join(", ") || "none"})`);
  }

  if (spec.trials !== undefined && !(Number.isInteger(spec.trials) && spec.trials >= 1)) {
    say(`\`trials\` is ${String(spec.trials)}; it has to be a whole number, 1 or more`);
  }
  if (spec.bar !== undefined && spec.bar !== "any" && spec.bar !== "all") {
    say(`\`bar\` is "${String(spec.bar)}"; it is "all" (every trial passes) or "any" (at least one does)`);
  }

  if (!Array.isArray(spec.cases) || !spec.cases.length) {
    say("has no cases, so it would pass without testing anything; add one to `cases`");
    return faults;
  }

  const seen = new Set<string>();
  spec.cases.forEach((test, at) => {
    const label = isText(test?.name) ? `case "${test.name}"` : `case ${at + 1}`;
    if (!isRecord(test)) return say(`${label} is not an object with \`name\`, \`input\` and \`expect\``);
    if (!isText(test.name) || !test.name.trim()) say(`${label} needs a \`name\`, which is how a failure is reported`);
    else if (seen.has(test.name)) say(`${label} appears twice; a report could not tell them apart`);
    else seen.add(test.name);

    if (spec.agent !== undefined && spec.workflow === undefined && !(isText(test.input) && test.input.trim())) {
      say(`${label}: \`input\` is what the agent is asked, so it has to be a non-empty string`);
    }
    if (spec.workflow !== undefined && spec.agent === undefined && !isRecord(test.input)) {
      say(`${label}: \`input\` is the workflow's inputs, so it has to be an object`);
    }

    const tokens = test.budget?.tokens;
    if (test.budget !== undefined && !isRecord(test.budget)) say(`${label}: \`budget\` takes an object, as \`{ tokens: 2000 }\``);
    else if (tokens !== undefined && !(typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0)) {
      say(`${label}: \`budget.tokens\` is ${String(tokens)}; it has to be a number above zero`);
    }
    const cap = isRecord(test.budget) ? (test.budget as { spend?: unknown }).spend : undefined;
    if (cap !== undefined) {
      const amount = isRecord(cap) ? cap.amount : undefined;
      const currency = isRecord(cap) ? cap.currency : undefined;
      if (!(typeof amount === "number" && Number.isFinite(amount) && amount > 0) || typeof currency !== "string" || !currency.trim()) {
        say(`${label}: \`budget.spend\` takes an amount above zero and a currency, as \`{ amount: 0.05, currency: "USD" }\``);
      }
    }

    if (!Array.isArray(test.expect) || !test.expect.length) {
      return say(`${label} has no graders, so every answer would pass; say what has to be true in \`expect\``);
    }
    test.expect.forEach((grader, index) => {
      const kinds = graderKinds(grader);
      const which = `${label}: grader ${index + 1}`;
      if (kinds.length === 0) return say(`${which} is none of ${GRADER_KINDS.join(", ")}`);
      if (kinds.length > 1) return say(`${which} is ${kinds.join(" and ")} at once; write one grader for each`);
      const fault = graderFault(grader, kinds[0]!, known?.agents);
      if (fault) say(`${which}: ${fault}`);
    });
  });

  return faults;
}
