/**
 * Which kind of step this is, and what happens when the answer is not one thing.
 *
 * Seven predicates decide what every step in every workflow does. They are the only
 * thing standing between an authored object and the runner's dispatch chain, and they
 * are consulted by three components that do NOT agree about what to do with the answer:
 * `runStep` takes the first match and runs it, `childrenOf` takes a different first
 * match and walks into it, and the loader's defect check walks whatever `childrenOf`
 * handed it. A step the family classifies twice is therefore not a curiosity — it is a
 * step that is validated as one kind and executed as another.
 *
 * So the tests below are about the BOUNDARIES rather than the happy path. Each predicate
 * recognising its own step is one line; what is worth the file is the set of inputs that
 * plausibly belong to more than one of them, because each of those is a place where the
 * three consumers can silently disagree.
 *
 * `QUALITIES` is here for the same reason: it is the published enumeration of the one
 * dial an author has, and its contract is not "contains three strings" but "is exactly
 * what the compiler will accept, in the order that widens".
 */

import { describe, expect, it } from "vitest";

import { planModels } from "../src/compile/models.js";
import {
  QUALITIES,
  isApprove,
  isAsk,
  isEach,
  isPlan,
  isRepeat,
  isUse,
  isWhen,
  type Quality,
  type Step,
} from "../src/define.js";
import { childrenOf, defectsIn } from "../src/workflow/defects.js";

/** The predicates, by the name of the kind each one claims. */
const FAMILY = {
  ask: isAsk,
  use: isUse,
  approve: isApprove,
  each: isEach,
  when: isWhen,
  repeat: isRepeat,
  plan: isPlan,
} as const;

type Kind = keyof typeof FAMILY;

/** One canonical, minimal, VALID step of each kind. */
const CANONICAL: Record<Kind, Step> = {
  ask: { id: "a", ask: "summarise {{input.text}}" },
  use: { id: "u", use: "billing.charge", with: { amount: 1 } },
  approve: { id: "p", approve: "ship it?" },
  each: { id: "e", each: "{{items}}", do: [{ id: "inner", ask: "look at {{item}}" }] },
  when: { id: "w", when: "{{verdict}}", is: { yes: [{ id: "y", ask: "go" }] } },
  repeat: { id: "r", repeat: [{ id: "try", ask: "again" }], until: { asks: "good?" }, max: 3 },
  plan: { id: "l", plan: "work out the rest" },
};

/** Which predicates say yes to a given object, in declaration order. */
const claimedBy = (step: Step): Kind[] =>
  (Object.keys(FAMILY) as Kind[]).filter((kind) => FAMILY[kind](step));

describe("each predicate claims its own kind and nothing else", () => {
  for (const kind of Object.keys(FAMILY) as Kind[]) {
    it(`a ${kind} step is claimed by is${kind[0]!.toUpperCase()}${kind.slice(1)} alone`, () => {
      expect(claimedBy(CANONICAL[kind])).toEqual([kind]);
    });
  }

  it("covers the whole union — a step no predicate claims has no action to run", () => {
    // `runStep`'s final `else` throws "has no recognised action". That branch is
    // reachable only for an object outside the union, and this asserts the union
    // itself never lands there: an eighth step kind added to `define.ts` without a
    // predicate would fail here rather than at someone's run time.
    for (const step of Object.values(CANONICAL)) expect(claimedBy(step).length).toBe(1);

    const stranger = { id: "x", conjure: "something" } as unknown as Step;
    expect(claimedBy(stranger)).toEqual([]);
  });
});

describe("what these predicates test is presence, not meaning", () => {
  // HAZARD (pinned, not fixed). Every predicate is `"key" in s`, and `in` is true for a
  // key that is present and explicitly `undefined`. An author who writes a step whose
  // action is conditional —
  //
  //     { id: "step", ask: draft ? "revise it" : undefined, use: "svc.fallback" }
  //
  // — has written a step the runner dispatches as an `ask`, and it asks the empty string,
  // because `runStep` interpolates `step.ask` and `String(undefined ?? "")` is "". The
  // fallback `use` never runs and nothing anywhere says so.
  //
  // The fix is `s.ask !== undefined`, which is one character per predicate and changes
  // the classification of every step in every workflow in the wild — including any that
  // is today relying on this. That is a decision about the authoring contract, not a
  // coverage commit, so this test pins the behaviour instead of correcting it.
  it("a key present but undefined still classifies the step (hazard)", () => {
    const conditional = { id: "s", ask: undefined, use: "svc.fallback" } as unknown as Step;
    expect(isAsk(conditional)).toBe(true);
    expect(isUse(conditional)).toBe(true);
  });

  // HAZARD (pinned, not fixed). `in` walks the prototype chain. A step rebuilt by
  // something that puts defaults on a prototype — a class instance, `Object.create`, a
  // config layer that inherits rather than merges — is classified by keys that are not
  // its own and that `Object.keys` would not show. Same fix, same reason for not making
  // it here.
  it("a key inherited from a prototype still classifies the step (hazard)", () => {
    const inherited = Object.create({ ask: "from the prototype" }) as Record<string, unknown>;
    inherited.id = "s";
    inherited.use = "svc.tool";
    expect(isAsk(inherited as unknown as Step)).toBe(true);
    expect(Object.keys(inherited)).not.toContain("ask");
  });

  it("an empty action is still an action — falsiness is not what is being asked", () => {
    // `ask: ""` is a step that asks nothing, which is a different fault from a step
    // that is not an ask. Keeping them apart is what lets the runner report the first
    // as an empty prompt rather than as an unrecognised step.
    expect(isAsk({ id: "s", ask: "" } as Step)).toBe(true);
    expect(isEach({ id: "s", each: "", do: [] } as Step)).toBe(true);
    expect(isRepeat({ id: "s", repeat: [], until: { asks: "?" }, max: 0 } as Step)).toBe(true);
  });
});

describe("a step that is two kinds at once", () => {
  // HAZARD (pinned, not fixed). Nothing refuses a step carrying two discriminants, and
  // the two components that read the family resolve the ambiguity DIFFERENTLY:
  //
  //   runStep      checks isAsk first, so the step runs as an ask and `do` never executes
  //   childrenOf   checks isEach first, so the loader descends into `do` and validates it
  //
  // The result is a nested body that is type-checked, defect-checked, reported in the
  // dashboard, and dead. Every one of those signals says the loop exists.
  //
  // Fixing it means either refusing such a step in `defectsIn` (which turns working-if-
  // accidental workflows into load failures) or making the two orders agree (which changes
  // what an existing ambiguous step does). Both are semantic decisions about the authoring
  // surface and both belong in their own change.
  const ambiguous = {
    id: "twice",
    ask: "summarise them",
    each: "{{items}}",
    do: [{ id: "inner", ask: "look at {{item}}" }],
  } as unknown as Step;

  it("is claimed by both predicates rather than resolved by either", () => {
    expect(claimedBy(ambiguous)).toEqual(["ask", "each"]);
  });

  it("the runner would dispatch it as the earlier branch of its chain (hazard)", () => {
    // Standing in for `runStep`'s if/else-if order, which is the thing that decides.
    const dispatched = isAsk(ambiguous) ? "ask" : isEach(ambiguous) ? "each" : "none";
    expect(dispatched).toBe("ask");
  });

  it("the loader walks into the body the runner will never reach (hazard)", () => {
    expect(childrenOf(ambiguous)).toEqual([[{ id: "inner", ask: "look at {{item}}" }]]);
  });

  it("and nothing reports the ambiguity as a defect (hazard)", () => {
    expect(defectsIn({ kind: "workflow", name: "w", steps: [ambiguous] })).toEqual([]);
  });

  it("childrenOf resolves each/repeat/when in its own order, which is not the runner's", () => {
    // Pinned so that a future edit to either order has to touch a test that names the
    // other one. The two orders being different is exactly what the hazard above is.
    const loops = {
      id: "both",
      each: "{{items}}",
      do: [{ id: "d", ask: "a" }],
      repeat: [{ id: "r", ask: "b" }],
      until: { asks: "?" },
      max: 2,
    } as unknown as Step;
    expect(claimedBy(loops)).toEqual(["each", "repeat"]);
    expect(childrenOf(loops)).toEqual([[{ id: "d", ask: "a" }]]);
  });
});

describe("the predicates the runner relies on to bound a loop", () => {
  it("a repeat without a positive max is a defect, and isRepeat is what finds it", () => {
    const unbounded = { id: "r", repeat: [{ id: "x", ask: "again" }], until: { asks: "?" } };
    const found = defectsIn({
      kind: "workflow",
      name: "spin",
      steps: [unbounded as unknown as Step],
    });
    expect(found.join(" ")).toMatch(/needs a positive `max`/);
  });

  it("the same body under a kind isRepeat does not claim is not checked for a max", () => {
    // Not a complaint about the check — it is the right check. It is a note that the
    // bound is enforced BY the predicate, so anything that changes what `isRepeat`
    // claims changes which loops are allowed to be unbounded.
    const disguised = { id: "r", each: "{{items}}", do: [{ id: "x", ask: "again" }] };
    expect(defectsIn({ kind: "workflow", name: "spin", steps: [disguised as Step] })).toEqual([]);
  });
});

describe("QUALITIES is the enumeration the compiler is willing to take", () => {
  it("is exactly the Quality union, cheapest first", () => {
    expect(QUALITIES).toEqual(["fast", "balanced", "best"]);

    // Structural, and it is the half a runtime assertion cannot make: adding a fourth
    // member to `Quality` without adding it here leaves this line unassignable.
    const exhaustive: Record<Quality, true> = { fast: true, balanced: true, best: true };
    expect(Object.keys(exhaustive).sort()).toEqual([...QUALITIES].sort());
  });

  it("every member is a quality the model planner will actually plan for", () => {
    const providers = {
      house: {
        url: "https://models.test/v1",
        credential: "HOUSE_KEY",
        fast: "small",
        balanced: "mid",
        best: "large",
      },
    };
    for (const quality of QUALITIES) {
      const rungs = planModels({ env: { HOUSE_KEY: "k" }, quality, providers });
      expect(rungs.length, `${quality} planned no rungs`).toBeGreaterThan(0);
    }
  });

  it("the order is the order that widens — more quality is never less room", () => {
    // This is the whole meaning of the array being ordered rather than a set. Anything
    // that reads QUALITIES as a ladder (a dashboard offering an upgrade, a router
    // escalating) is entitled to this.
    const providers = {
      house: {
        url: "https://models.test/v1",
        credential: "HOUSE_KEY",
        fast: "small",
        balanced: "mid",
        best: "large",
      },
    };
    const widths = QUALITIES.map(
      (quality) => planModels({ env: { HOUSE_KEY: "k" }, quality, providers }).length,
    );
    expect(widths).toEqual([...widths].sort((a, b) => a - b));
    expect(new Set(widths).size).toBe(widths.length);
  });

  // HAZARD (pinned, not fixed). The type says `readonly Quality[]`; the value is a plain
  // array. `readonly` is erased at build time, so any consumer of the published package —
  // and this is a published export — can `push` onto the framework's enumeration and every
  // later reader sees the mutation. `Object.freeze` would close it, and would also turn a
  // consumer's existing mutation from working into a TypeError in strict mode. Small, but
  // it is a behaviour change in someone else's process, so it is not riding in here.
  it("is not frozen, so a consumer can mutate the framework's own enumeration (hazard)", () => {
    // Asserted by inspection rather than by demonstration on purpose: a test that
    // proved the point by pushing onto the real array would be doing the damage it
    // is describing, to every other test file sharing this module.
    expect(Object.isFrozen(QUALITIES)).toBe(false);
    expect(Object.isExtensible(QUALITIES)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(QUALITIES, "0")?.writable).toBe(true);

    // A copy is what a consumer needing a mutable ladder should take, and it is
    // unaffected either way — the point is only that nothing forces them to.
    const mine: Quality[] = [...QUALITIES];
    mine.push("best");
    expect(QUALITIES).toEqual(["fast", "balanced", "best"]);
  });
});
