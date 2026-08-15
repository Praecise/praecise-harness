/**
 * How much a person has to write, and how much of it the compiler checks.
 *
 * These are type-level assertions as much as runtime ones. `@ts-expect-error` is the
 * assertion: it FAILS the typecheck if the line it guards starts compiling, so a
 * regression in inference breaks the build rather than quietly returning `undefined`
 * at runtime the way it used to.
 */
import { describe, expect, it } from "vitest";

import { fn } from "../src/define.js";

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
