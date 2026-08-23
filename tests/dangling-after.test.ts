/**
 * A nested step naming an outer one is usually correct, and saying otherwise is noise.
 *
 * The distinction these test is the whole point: a dependency the enclosing block already waits
 * for is satisfied before the block begins, so dropping it changes nothing. A dependency nobody
 * waits for is a race, and that one must still be said out loud.
 */

import { describe, expect, it } from "vitest";

import { danglingAfterIn } from "../src/workflow/defects.js";
import type { WorkflowSpec } from "../src/define.js";

const ask = (id: string, after?: string[]) =>
  ({ id, ask: "do the thing", ...(after ? { after } : {}) }) as never;

const loop = (id: string, after: string[], inner: unknown[]) =>
  ({ id, after, repeat: inner, until: "done", max: 3 }) as never;

function wf(steps: unknown[]): WorkflowSpec {
  return { kind: "workflow", name: "w", steps } as WorkflowSpec;
}

describe("waits that name something outside the block", () => {
  it("says nothing when the block already waits for it", () => {
    // `probe` runs, then `close` runs because it waits for `probe`; by the time the body runs,
    // `probe` has finished. The inner wait is redundant, not lost.
    const spec = wf([
      ask("probe"),
      loop("close", ["probe"], [ask("propose"), ask("verify", ["propose", "probe"])]),
    ]);
    expect(danglingAfterIn(spec)).toEqual([]);
  });

  it("still reports it when nothing waits for it — that drop is a real race", () => {
    const spec = wf([
      ask("probe"),
      loop("close", [], [ask("propose"), ask("verify", ["propose", "probe"])]),
    ]);
    const found = danglingAfterIn(spec);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/"verify" waits for "probe"/);
  });

  it("follows the chain, because `after` is transitive", () => {
    // close waits for b, b waits for a — so a has run before the body does.
    const spec = wf([
      ask("a"),
      ask("b", ["a"]),
      loop("close", ["b"], [ask("verify", ["a"])]),
    ]);
    expect(danglingAfterIn(spec)).toEqual([]);
  });

  it("reports a name no step anywhere carries", () => {
    const spec = wf([ask("a"), ask("b", ["typo"])]);
    const found = danglingAfterIn(spec);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/waits for "typo"/);
  });

  it("says nothing about ordinary sibling waits", () => {
    expect(danglingAfterIn(wf([ask("a"), ask("b", ["a"])]))).toEqual([]);
  });

  it("carries satisfaction down through two levels of nesting", () => {
    const spec = wf([
      ask("probe"),
      loop("outer", ["probe"], [loop("inner", [], [ask("deep", ["probe"])])]),
    ]);
    expect(danglingAfterIn(spec)).toEqual([]);
  });
});
