/**
 * How much a person has to write, and how much of it the compiler checks.
 *
 * These are type-level assertions as much as runtime ones. `@ts-expect-error` is the
 * assertion: it FAILS the typecheck if the line it guards starts compiling, so a
 * regression in inference breaks the build rather than quietly returning `undefined`
 * at runtime the way it used to.
 */
import { describe, expect, it } from "vitest";

import { fn, prompt, workflow } from "../src/define.js";

describe("a function's arguments come from its declared input", () => {
  it("needs no annotation on `run`", async () => {
    // The ceremony this removes: `run: ({ value }: { value: unknown }) => ...` restates
    // in a type what the line above already said, and a reader has to check they agree.
    const spec = fn({
      description: "Band a number.",
      input: { value: "the number", unit: "the unit" },
      effect: "read",
      run: ({ value, unit }) => ({ band: Number(value) > 10 ? "high" : "low", unit }),
    });

    expect(await spec.run({ value: 14, unit: "kg" })).toEqual({ band: "high", unit: "kg" });
  });

  it("refuses a field that was never declared", () => {
    fn({
      description: "Band a number.",
      input: { value: "the number" },
      effect: "read",
      // @ts-expect-error `valeu` is not a declared field. Before inference this compiled,
      // arrived as `undefined`, and produced a confident wrong answer — which is exactly
      // how `praecise run band 14` came to compute a band from NaN.
      run: ({ valeu }) => ({ band: valeu }),
    });
    expect(true).toBe(true);
  });

  it("still allows a function that declares no input at all", async () => {
    const spec = fn({ description: "The time.", effect: "read", run: () => ({ now: 1 }) });
    expect(await spec.run({})).toEqual({ now: 1 });
  });

  it("still hands over the idempotency key a workflow supplies", async () => {
    const seen: string[] = [];
    const spec = fn({
      description: "Charge a card.",
      input: { amount: "how much" },
      effect: "write",
      run: ({ amount }, opts) => {
        if (opts?.idempotencyKey) seen.push(opts.idempotencyKey);
        return { charged: amount };
      },
    });

    await spec.run({ amount: 10 }, { idempotencyKey: "key-1" });
    expect(seen).toEqual(["key-1"]);
  });
});

describe("a workflow's edges name steps that exist", () => {
  it("accepts an `after` that names a sibling", () => {
    const spec = workflow({
      steps: [
        { id: "read", ask: "Read it", agent: "support" },
        { id: "reply", ask: "Reply", agent: "support", after: ["read"] },
      ],
    });
    expect(spec.steps).toHaveLength(2);
  });

  it("refuses an `after` that names a step which is not there", () => {
    workflow({
      steps: [
        { id: "read", ask: "Read it", agent: "support" },
        // @ts-expect-error "raed" is a typo; the valid ids are "read" | "reply". Before
        // this, the mistake produced a step that was never ready — a run that stalls or
        // silently reorders — and was caught only when the project next loaded.
        { id: "reply", ask: "Reply", agent: "support", after: ["raed"] },
      ],
    });
    expect(true).toBe(true);
  });

  it("keeps every step kind, not just the fields they share", () => {
    // The distributive-Omit case: a naive `Omit<Step, "after">` collapses the union to
    // `id` alone and `ask`, `use` and `each` all stop being allowed.
    const spec = workflow({
      input: { case: "what happened" },
      steps: [
        { id: "look", use: "lookup", with: { id: "{{case}}" } },
        { id: "say", ask: "Summarise", agent: "support", after: ["look"] },
      ],
    });
    expect(spec.steps.map((step) => step.id)).toEqual(["look", "say"]);
  });
});

describe("a prompt's template names fields it declared", () => {
  it("accepts placeholders that match, with or without spaces", () => {
    const spec = prompt({
      input: { customer: "who is asking", order: "the order id" },
      text: "Draft a reply to {{customer}} about {{ order }}.",
    });
    expect(spec.text).toContain("{{customer}}");
  });

  it("refuses a placeholder that was never declared", () => {
    prompt({
      input: { customer: "who is asking" },
      // @ts-expect-error `{{custmer}}` is a typo. It used to interpolate to nothing, so
      // what reached the model was a sentence with a hole in it — nothing thrown, the
      // answer merely worse, and the cause invisible in the output.
      text: "Draft a reply to {{custmer}}.",
    });
    expect(true).toBe(true);
  });

  it("leaves a template with no placeholders alone", () => {
    const spec = prompt({ text: "Summarise the last conversation." });
    expect(spec.text).toBe("Summarise the last conversation.");
  });
});
