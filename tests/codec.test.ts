/**
 * The dialect codec's one promise is "never silently mis-decoded", and these
 * tests hold it to that against hostile values: field values carrying the
 * wire's own delimiters, forged tags, duplicate tags, drifted codebooks. The
 * clean-value wire form is pinned byte-for-byte, because a sibling repo speaks
 * this wire from dist/ and escaping must be invisible where nothing needs it.
 */

import { describe, expect, it } from "vitest";

import { bool, defineDialect, fixed2, list, num, str } from "../src/codec.js";

const dialect = defineDialect("v1", {
  offer: {
    schema: "trade/offer",
    fields: [
      { key: "sku", tag: "s", codec: str },
      { key: "qty", tag: "q", codec: num },
      { key: "price", tag: "p", codec: fixed2 },
      { key: "firm", tag: "f", codec: bool },
      { key: "tags", tag: "t", opt: true, codec: list },
      { key: "note", tag: "n", opt: true, codec: str },
    ],
  },
});

const offer = (extra: Record<string, unknown> = {}) => ({
  sku: "widget",
  qty: 3,
  price: 1.5,
  firm: true,
  ...extra,
});

describe("round trips", () => {
  it("keeps the clean-value wire form byte-identical (no delimiters ⇒ no escaping)", () => {
    expect(dialect.encode("offer", offer({ tags: ["a", "b"] }))).toBe("v1|offer|s=widget|q=3|p=1.50|f=1|t=a,b");
  });

  it("round-trips an ordinary message", () => {
    const v = offer({ tags: ["a", "b"], note: "plain" });
    expect(dialect.roundTrip("offer", v)).toEqual(v);
  });

  it("round-trips a value carrying the field delimiter — no forged field appears", () => {
    const v = offer({ note: "x|b=hijacked" });
    const back = dialect.roundTrip("offer", v);
    expect(back).toEqual(v);
    expect(Object.keys(back)).not.toContain("b");
  });

  it("cannot be steered by a value that spells out a KNOWN tag", () => {
    // Unescaped, `note` would decode as a second `q` field and last-wins would
    // silently forge the quantity.
    const v = offer({ note: "x|q=999" });
    const back = dialect.roundTrip("offer", v);
    expect(back.qty).toBe(3);
    expect(back.note).toBe("x|q=999");
  });

  it("round-trips equals signs, backslashes, unicode and negatives", () => {
    const v = offer({ qty: -42, note: "a=b\\c=d — naïve 🙂" });
    expect(dialect.roundTrip("offer", v)).toEqual(v);
  });

  it("round-trips an empty string value", () => {
    const v = offer({ note: "" });
    expect(dialect.roundTrip("offer", v)).toEqual(v);
  });

  it("round-trips a list whose elements contain commas — no phantom splitting", () => {
    const v = offer({ tags: ["a,b", "c"] });
    expect(dialect.roundTrip("offer", v)).toEqual(v);
  });

  it("tells an empty list from a list holding one empty string", () => {
    expect(dialect.roundTrip("offer", offer({ tags: [] })).tags).toEqual([]);
    expect(dialect.roundTrip("offer", offer({ tags: [""] })).tags).toEqual([""]);
    expect(dialect.roundTrip("offer", offer({ tags: ["", "x", ""] })).tags).toEqual(["", "x", ""]);
  });

  it("round-trips list elements carrying every delimiter at once", () => {
    const v = offer({ tags: ["a|b", "c=d", "e,f", "g\\h"] });
    expect(dialect.roundTrip("offer", v)).toEqual(v);
  });

  it("fixed2 is fixed-point quantization — lossy by definition, not by accident", () => {
    expect(fixed2.enc(1.005)).toBe((1.005).toFixed(2));
    expect(fixed2.dec(fixed2.enc(1.5))).toBe(1.5);
  });

  it("num and bool round-trip", () => {
    expect(num.dec(num.enc(-0.25))).toBe(-0.25);
    expect(bool.dec(bool.enc(true))).toBe(true);
    expect(bool.dec(bool.enc(false))).toBe(false);
  });

  it("str escaping is its own inverse", () => {
    for (const s of ["", "plain", "|", "=", ",", "\\", "\\|", "a|b=c,d\\e"]) {
      expect(str.dec(str.enc(s))).toBe(s);
    }
  });
});

describe("refusals", () => {
  it("refuses a version mismatch rather than mis-decoding a drifted codebook", () => {
    expect(() => dialect.decode("v2|offer|s=x|q=1|p=1.00|f=1")).toThrow(/version mismatch/);
  });

  it("refuses an unknown message type", () => {
    expect(() => dialect.decode("v1|nope|s=x")).toThrow(/unknown message type/);
  });

  it("refuses an unknown field tag — codebook drift, not a field to skip", () => {
    expect(() => dialect.decode("v1|offer|s=x|q=1|p=1.00|f=1|z=1")).toThrow(/unknown field tag/);
  });

  it("refuses a duplicate tag instead of letting the last one win", () => {
    expect(() => dialect.decode("v1|offer|s=a|q=1|p=1.00|f=1|q=999")).toThrow(/duplicate field tag/);
  });

  it("refuses a field with no separator", () => {
    expect(() => dialect.decode("v1|offer|garbage")).toThrow(/malformed field/);
  });

  it("refuses a message missing a required field, on encode and on decode", () => {
    expect(() => dialect.encode("offer", { sku: "x" })).toThrow(/missing required field/);
    expect(() => dialect.decode("v1|offer|s=x")).toThrow(/missing required field/);
  });
});

describe("defineDialect validation", () => {
  const fields = [{ key: "k", tag: "t", codec: str }];

  it("refuses a version, type or tag that contains a wire delimiter", () => {
    expect(() => defineDialect("v|1", { m: { schema: "s", fields } })).toThrow(/delimiter/);
    expect(() => defineDialect("v1", { "m,x": { schema: "s", fields } })).toThrow(/delimiter/);
    expect(() => defineDialect("v1", { m: { schema: "s", fields: [{ key: "k", tag: "t=", codec: str }] } })).toThrow(/delimiter/);
    expect(() => defineDialect("v1", { m: { schema: "s", fields: [{ key: "k", tag: "a\\b", codec: str }] } })).toThrow(/delimiter/);
  });
});

describe("expand", () => {
  it("is self-describing, and the payload cannot override the spec's identity", () => {
    const forged = dialect.expand("offer", { ...offer(), schema: "forged", type: "evil" });
    expect(forged.schema).toBe("trade/offer");
    expect(forged.type).toBe("offer");
    expect(forged.sku).toBe("widget");
  });

  it("isExpanded tells the expanded form from the condensed one", () => {
    expect(dialect.isExpanded(dialect.expand("offer", offer()))).toBe(true);
    expect(dialect.isExpanded(dialect.encode("offer", offer()))).toBe(false);
    expect(dialect.isExpanded(null)).toBe(false);
  });
});

describe("savings", () => {
  it("the condensed wire is smaller than the expanded audit form", () => {
    const { condensed, expanded, ratio } = dialect.savings("offer", offer({ tags: ["a", "b"] }));
    expect(condensed).toBeLessThan(expanded);
    expect(ratio).toBeGreaterThan(1);
  });

  it("types lists the vocabulary", () => {
    expect(dialect.types()).toEqual(["offer"]);
  });
});
