/**
 * A loop's condition is evaluated after its body, so it can see what the body produced.
 *
 * `until: "{{panel.passed}}"` over a body containing `panel` is the ordinary way to write "go
 * round again until the panel agrees". Judging that against the scope outside the loop reports the
 * commonest correct loop as a mistake — and a warning that fires on the normal case is one nobody
 * reads, which costs the warnings that matter.
 */

import { describe, expect, it } from "vitest";

import { looseReferencesIn } from "../src/workflow/defects.js";
import type { WorkflowSpec } from "../src/define.js";

function loopWith(until: string): WorkflowSpec {
  return {
    kind: "workflow",
    name: "w",
    input: { brief: "what to do" },
    steps: [
      {
        id: "close",
        repeat: [{ id: "panel", ask: "judge {{brief}}" }],
        until,
        max: 3,
      },
    ],
  } as unknown as WorkflowSpec;
}

describe("a loop condition may name its own body", () => {
  it("says nothing about `until` referring to a step inside the loop", () => {
    expect(looseReferencesIn(loopWith("{{panel.passed}}"))).toEqual([]);
  });

  it("still reports a name that is nowhere at all", () => {
    const found = looseReferencesIn(loopWith("{{nobody.passed}}"));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/nobody/);
  });

  it("still sees the declared input from inside the loop", () => {
    expect(looseReferencesIn(loopWith("{{brief}}"))).toEqual([]);
  });
});
