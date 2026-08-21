/**
 * Which kind of step this is, and what happens when the answer is not one thing.
 *
 * Seven predicates decide what every step in every workflow does. They are the only
 * thing standing between an authored object and the runner's dispatch chain, and they
 * are consulted by three components that used not to agree about what to do with the
 * answer: `runStep` took the first match and ran it, `childrenOf` took a different first
 * match and walked into it, and the loader's defect check walked whatever `childrenOf`
 * handed it. A step the family classified twice was therefore not a curiosity — it was a
 * step validated as one kind and executed as another, with the nested body dead and
 * every signal saying otherwise. Such a step is now refused when the workflow loads.
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

describe("what these predicates test is a key the step OWNS, carrying a value", () => {
  // `"ask" in s` was true for a key that is present and explicitly `undefined`, so an
  // author writing a conditional action —
  //
  //     { id: "step", ask: draft ? "revise it" : undefined, use: "svc.fallback" }
  //
  // — got a step the runner dispatched as an `ask`. It asked the empty string, because
  // `runStep` interpolates `step.ask` and `String(undefined ?? "")` is "", and the
  // fallback `use` never ran. The predicates now ask whether the key carries a value.
  it("a key present but undefined does not classify the step", () => {
    const conditional = { id: "s", ask: undefined, use: "svc.fallback" } as unknown as Step;
    expect(isAsk(conditional)).toBe(false);
    expect(isUse(conditional)).toBe(true);
    // And so it is a step of exactly one kind, which is the only thing that runs.
    expect(claimedBy(conditional)).toEqual(["use"]);
  });

  // `in` also walked the prototype chain, so a step rebuilt by something that puts
  // defaults on a prototype — a class instance, `Object.create`, a config layer that
  // inherits rather than merges — was classified by keys that are not its own and that
  // `Object.keys` would not show. Ownership is the question, so it is asked directly.
  it("a key inherited from a prototype does not classify the step", () => {
    const inherited = Object.create({ ask: "from the prototype" }) as Record<string, unknown>;
    inherited.id = "s";
    inherited.use = "svc.tool";
    expect(isAsk(inherited as unknown as Step)).toBe(false);
    expect(Object.keys(inherited)).not.toContain("ask");
    expect(claimedBy(inherited as unknown as Step)).toEqual(["use"]);
  });

  it("a null-prototype object is classified by what it holds, like any other", () => {
    // The other end of the same question: `Object.hasOwn` is a static call rather than a
    // method on the object, so a step from `JSON.parse` with `__proto__: null`, or from a
    // `Object.create(null)` bag, does not have to carry `hasOwnProperty` to be readable.
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, {
      id: "s",
      each: "{{items}}",
      do: [],
    });
    expect(claimedBy(bare as unknown as Step)).toEqual(["each"]);
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

describe("a step that is two kinds at once is refused rather than resolved", () => {
  // The two components that read the family used to resolve an ambiguous step
  // DIFFERENTLY:
  //
  //   runStep      checked isAsk first, so the step ran as an ask and `do` never executed
  //   childrenOf   checked isEach first, so the loader descended into `do` and checked it
  //
  // A nested body that is type-checked, defect-checked, drawn in the dashboard, and dead.
  // Every one of those signals said the loop was there.
  //
  // The fix is a refusal at load rather than an alignment of the two orders, because
  // aligning them still picks a winner and still picks it silently: the same workflow
  // would go on running, doing a different thing, with nothing said. Nothing here can
  // know whether `{ ask, each, do }` was meant to delegate once or to run a body per
  // item, so the one honest answer is to stop and name both keys.
  const ambiguous = {
    id: "twice",
    ask: "summarise them",
    each: "{{items}}",
    do: [{ id: "inner", ask: "look at {{item}}" }],
  } as unknown as Step;

  it("is claimed by both predicates — which is the fact the refusal is built on", () => {
    expect(claimedBy(ambiguous)).toEqual(["ask", "each"]);
  });

  it("is reported as a defect naming every discriminant it carries", () => {
    const found = defectsIn({ kind: "workflow", name: "w", steps: [ambiguous] });
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('step "twice"');
    expect(found[0]).toContain("`ask`");
    expect(found[0]).toContain("`each`");
  });

  it("so the runner never reaches the question of which branch to dispatch", () => {
    // `startRun` throws on any defect, which is what makes the refusal the whole answer:
    // the disagreement between `runStep` and `childrenOf` is now unreachable rather than
    // merely resolved one way.
    expect(defectsIn({ kind: "workflow", name: "w", steps: [ambiguous] })).not.toEqual([]);
  });

  it("the loader still walks the body, so what is wrong INSIDE it is reported too", () => {
    // A refusal that reported one defect and stopped would make an author fix the same
    // workflow twice. `childrenOf` descends as it always did.
    expect(childrenOf(ambiguous)).toEqual([[{ id: "inner", ask: "look at {{item}}" }]]);

    const nested = {
      ...(ambiguous as unknown as Record<string, unknown>),
      do: [{ id: "inner", repeat: [{ id: "x", ask: "again" }], until: { asks: "?" } }],
    } as unknown as Step;
    const found = defectsIn({ kind: "workflow", name: "w", steps: [nested] });
    expect(found.join(" ")).toContain("carries `ask` and `each`");
    expect(found.join(" ")).toMatch(/needs a positive `max`/);
  });

  it("two loop kinds on one step are refused for the same reason", () => {
    // This is the pair that made the two walk orders observable. It no longer matters
    // which one `childrenOf` picks, because the step does not get to run.
    const loops = {
      id: "both",
      each: "{{items}}",
      do: [{ id: "d", ask: "a" }],
      repeat: [{ id: "r", ask: "b" }],
      until: { asks: "?" },
      max: 2,
    } as unknown as Step;
    expect(claimedBy(loops)).toEqual(["each", "repeat"]);
    expect(defectsIn({ kind: "workflow", name: "w", steps: [loops] }).join(" ")).toContain(
      "carries `each` and `repeat`",
    );
  });

  it("a conditional action is NOT ambiguous, because the unset key carries nothing", () => {
    // The two fixes meet here. `{ ask: undefined, use }` would have been claimed twice
    // under `in` and refused by the check above — a workflow that is fine being told it
    // is broken. It is a `use`, it has one kind, and it loads.
    const conditional = { id: "s", ask: undefined, use: "svc.fallback" } as unknown as Step;
    expect(defectsIn({ kind: "workflow", name: "w", steps: [conditional] })).toEqual([]);
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

  // The type said `readonly Quality[]` and the value was a plain array. `readonly` is
  // erased at build time, so a consumer of the published package could `push` onto the
  // framework's own enumeration and every later reader — the quality picker, the router's
  // ladder, the model planner — saw the mutation. It is frozen now. What that breaks is a
  // consumer who was mutating it: their write becomes a silent no-op, or a TypeError under
  // strict mode, which is the loudest of the three places this could have gone wrong.
  it("is frozen, so no consumer can mutate the framework's own enumeration", () => {
    expect(Object.isFrozen(QUALITIES)).toBe(true);
    expect(Object.isExtensible(QUALITIES)).toBe(false);
    expect(Object.getOwnPropertyDescriptor(QUALITIES, "0")?.writable).toBe(false);

    // Demonstrated rather than only inspected, now that demonstrating it is safe: this
    // is the exact call that used to damage every other test file sharing the module.
    expect(() => (QUALITIES as Quality[]).push("fast")).toThrow(TypeError);
    expect(QUALITIES).toEqual(["fast", "balanced", "best"]);

    // A copy is what a consumer needing a mutable ladder takes, and it still works.
    const mine: Quality[] = [...QUALITIES];
    mine.push("best");
    expect(mine).toHaveLength(4);
    expect(QUALITIES).toEqual(["fast", "balanced", "best"]);
  });
});
