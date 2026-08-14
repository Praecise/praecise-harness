import { describe, expect, it } from "vitest";

import { interpolate, resolvePath } from "../src/workflow/interpolate.js";

describe("resolvePath", () => {
  const scope = { a: { b: [{ c: 1 }] }, top: "x" };

  it("walks dotted paths", () => {
    expect(resolvePath(scope, "a.b.0.c")).toBe(1);
  });

  it("accepts bracket indexes", () => {
    expect(resolvePath(scope, "a.b[0].c")).toBe(1);
  });

  it("returns undefined instead of throwing on a missing path", () => {
    expect(resolvePath(scope, "a.nope.deep")).toBeUndefined();
  });

  it("prefers a literal dotted key, which is how nested steps are recorded", () => {
    const outputs = { "reply.draft": "the draft", sorted: { category: "refund" } };
    expect(resolvePath(outputs, "reply.draft")).toBe("the draft");
    expect(resolvePath(outputs, "sorted.category")).toBe("refund");
  });

  it("keeps walking past a literal key", () => {
    const outputs = { "loop#0.step": { title: "Hi" } };
    expect(resolvePath(outputs, "loop#0.step.title")).toBe("Hi");
  });
});

describe("interpolate", () => {
  const scope = { draft: { title: "Hi" }, name: "Ada", count: 3 };

  it("preserves the type when the whole string is one reference", () => {
    expect(interpolate("{{draft}}", scope)).toEqual({ title: "Hi" });
  });

  it("renders references inside surrounding text", () => {
    expect(interpolate("Hello {{name}}, you have {{count}}", scope)).toBe("Hello Ada, you have 3");
  });

  it("refuses a reference that names nothing, rather than rendering it away", () => {
    // The defect this replaces: `{{mesage}}` became "", went to the model as a
    // prompt with a hole in it, and the run reported done.
    expect(() => interpolate("Reply to: {{mesage}}", scope)).toThrow(
      /nothing in scope is called "mesage"/,
    );
  });

  it("says what was meant and what was there", () => {
    let message = "";
    try {
      interpolate("Reply to: {{mesage}}", { message: "hi", topic: "orders" }, 'step "draft"');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('step "draft"');
    expect(message).toContain("Did you mean `{{message}}`?");
    expect(message).toContain("message, topic");
  });

  it("refuses a whole-string reference too, where the type would have been undefined", () => {
    expect(() => interpolate("{{drft}}", scope)).toThrow(/nothing in scope is called "drft"/);
  });

  it("renders a name that exists but holds nothing as empty — that is data, not a typo", () => {
    // `{{prior.draft}}` on a loop's first attempt, and a field a tool did not
    // return. The name is real; refusing it would break repair loops.
    expect(interpolate("[{{blank}}]", { blank: undefined })).toBe("[]");
    expect(interpolate("[{{draft.subtitle}}]", scope)).toBe("[]");
  });

  it("does not mistake an inherited property for a name in scope", () => {
    expect(() => interpolate("{{constructor}}", scope)).toThrow(/nothing in scope/);
  });

  it("recurses through objects and arrays, keeping whole-reference types", () => {
    expect(interpolate({ to: "{{name}}", items: ["{{count}}", "n={{count}}"] }, scope)).toEqual({
      to: "Ada",
      items: [3, "n=3"],
    });
  });

  it("leaves non-string leaves alone", () => {
    expect(interpolate({ n: 5, ok: true }, scope)).toEqual({ n: 5, ok: true });
  });
});
