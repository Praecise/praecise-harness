import { describe, expect, it } from "vitest";

import { resolveService, splitToolName, toolName } from "../src/harness/mcp.js";

describe("the name a model is given for a service's tool", () => {
  it("is callable even when the service is named for people", () => {
    // The bug: "risk model" went to the model as `risk model__forecast`, which no
    // tool-calling grammar admits. The model wrote something call-shaped, nothing
    // recognised it, and the run ended with prose instead of a forecast.
    const name = toolName("risk model", "forecast");
    expect(name).toBe("risk-model__forecast");
    expect(name).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("leaves a name that was already callable exactly as it was", () => {
    expect(toolName("performance-attribution", "brinson")).toBe(
      "performance-attribution__brinson",
    );
  });

  it("does not turn one service into two", () => {
    // Collapsing runs matters: a stray double space would otherwise name a
    // different tool than the same service written normally.
    expect(toolName("risk  model", "forecast")).toBe(toolName("risk model", "forecast"));
  });

  it("never produces a name that starts or ends with a separator", () => {
    expect(toolName("  risk model  ", "forecast")).toBe("risk-model__forecast");
  });

  it("does not sanitise the tool half, which the server is answerable for", () => {
    // A server misdeclaring its own tool should be visible, not quietly repaired.
    expect(toolName("risk model", "odd name")).toBe("risk-model__odd name");
  });

  it("splits back into the name the model used", () => {
    expect(splitToolName("risk-model__forecast")).toEqual({
      service: "risk-model",
      tool: "forecast",
    });
  });
});

describe("resolving the service a model named", () => {
  it("finds an entry keyed by the author's spelling", () => {
    const entries = new Map([["risk model", "client"]]);
    expect(resolveService(entries, "risk-model")).toBe("client");
  });

  it("prefers an exact key over a sanitised match", () => {
    // Both could match; the one the author wrote wins, so adding sanitisation
    // cannot change where an already-working call lands.
    const entries = new Map([
      ["risk-model", "exact"],
      ["risk model", "sanitised"],
    ]);
    expect(resolveService(entries, "risk-model")).toBe("exact");
  });

  it("refuses rather than guessing when two services collide", () => {
    const entries = new Map([
      ["risk model", "one"],
      ["risk/model", "two"],
    ]);
    expect(resolveService(entries, "risk-model")).toBeUndefined();
  });

  it("is undefined for a service nobody declared", () => {
    expect(resolveService(new Map([["risk model", "one"]]), "nothing")).toBeUndefined();
  });
});
