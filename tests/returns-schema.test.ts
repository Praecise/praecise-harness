/**
 * A declared `returns` shape reaching the endpoint as a SCHEMA, not only as prose.
 *
 * The framework compiled `returns` into English and hoped. Three endpoints it speaks to
 * will constrain decoding to a schema instead, where a reply outside it is unreachable
 * rather than unlikely — so the shape is derived and sent.
 */
import { describe, expect, test } from "vitest";
import { schemaFromReturns } from "../src/compile/plan.js";

describe("a declared shape becomes a schema", () => {
  test("structure is constrained exactly: these keys, no others, all present", () => {
    const schema = schemaFromReturns({
      category: "one of: refund, shipping, account, other",
      urgency: "low, normal, or high",
    });
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["category", "urgency"]);
  });

  test("the hint survives as the field's description, where the model still reads it", () => {
    const schema = schemaFromReturns({ urgency: "low, normal, or high" });
    const properties = schema.properties as Record<string, { type: string; description: string }>;
    expect(properties.urgency).toEqual({ type: "string", description: "low, normal, or high" });
  });

  test("the honest limit: a hint is not a type, so values are not constrained", () => {
    // "one of: refund, shipping" cannot become an enum, because Returns maps a field to
    // a HINT rather than a type. Structure is exact; the value is still prose the model
    // may miss. Saying so here stops the next reader assuming more than is delivered.
    const properties = schemaFromReturns({ category: "one of: refund, shipping" }).properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(properties.category?.enum).toBeUndefined();
    expect(properties.category?.type).toBe("string");
  });

  test("an empty shape is still a valid object schema", () => {
    const schema = schemaFromReturns({});
    expect(schema.required).toEqual([]);
    expect(schema.properties).toEqual({});
  });
});
