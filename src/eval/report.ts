/**
 * An eval report as lines a person reads in a terminal.
 *
 * Plain text, so it reads the same in a CI log as on a screen. Reasons sit
 * under the case they belong to, because a table that says a case failed and a
 * separate list that says why is two things to line up by eye.
 */

import type { CaseReport, EvalReport, SuiteReport } from "./run.js";

const MARK: Record<CaseReport["status"], string> = { passed: "✓", failed: "✗", undecided: "?", skipped: "-" };

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
const number = (value: number): string => value.toLocaleString("en");
const yesNo = (value: boolean): string => (value ? "yes" : "no");

function suiteLines(suite: SuiteReport): string[] {
  const target = "agent" in suite.target ? `agent ${suite.target.agent}` : `workflow ${suite.target.workflow}`;
  const lines = [
    `${suite.suite} · ${target} · ${suite.trials} trial${suite.trials === 1 ? "" : "s"} · bar: ${suite.bar}`,
  ];

  const width = Math.max(4, ...suite.cases.map((c) => c.name.length));
  const row = (cells: string[]): string =>
    `  ${cells[0]!.padEnd(width + 2)}  ${cells[1]!.padEnd(8)}${cells[2]!.padEnd(8)}${cells[3]!.padEnd(8)}${cells[4]!.padStart(9)}${cells[5]!.padStart(9)}`;

  lines.push(row(["  case", "passed", "pass@k", "pass^k", "tokens", "time"]));
  for (const test of suite.cases) {
    if (test.status === "skipped") {
      lines.push(row([`${MARK.skipped} ${test.name}`, "not run", "", "", "", ""]));
      continue;
    }
    lines.push(
      row([
        `${MARK[test.status]} ${test.name}`,
        `${test.passed}/${test.trials.length}`,
        yesNo(test.passAny),
        yesNo(test.passAll),
        number(test.tokens),
        seconds(test.durationMs),
      ]),
    );
    if (test.status === "passed" && !test.unknown) continue;
    if (test.unknown) lines.push(`      ${test.unknown} of ${test.trials.length} could not be judged, and count as neither`);
    for (const { reason, trials } of test.reasons) {
      lines.push(`      ${trials}× ${reason.replace(/\s+/g, " ")}`);
    }
  }
  return lines;
}

/** The whole report: a table per suite, then one line saying how it went. */
export function renderReport(report: EvalReport): string[] {
  const lines: string[] = [];
  for (const suite of report.suites) lines.push(...suiteLines(suite), "");

  const sum = (pick: (s: SuiteReport) => number): number => report.suites.reduce((total, s) => total + pick(s), 0);
  const parts = [`${report.passed} of ${report.cases} case${report.cases === 1 ? "" : "s"} met the bar`];
  if (sum((s) => s.failed)) parts.push(`${sum((s) => s.failed)} failed`);
  if (sum((s) => s.undecided)) parts.push(`${sum((s) => s.undecided)} undecided`);
  if (sum((s) => s.skipped)) parts.push(`${sum((s) => s.skipped)} not run`);
  parts.push(`${number(report.tokens)} tokens${report.judgeTokens ? ` + ${number(report.judgeTokens)} judging` : ""}`);
  parts.push(seconds(report.durationMs));
  lines.push(parts.join(" · "));
  if (report.bailed) lines.push("stopped at the first case that missed its bar (--bail); the rest was not run");
  return lines;
}
