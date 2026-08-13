/**
 * The latent transport mechanism, and the one audit seam the framework itself
 * enforces on it: an opaque vector never becomes judge evidence and never
 * enters the PROV graph as a value — only as a typed opaque reference.
 */

import { describe, expect, it } from "vitest";

import { createRefs, isLatent, latent, latentChannel, latentRef, probe } from "../src/transport.js";
import { provenanceOf } from "../src/workflow/provenance.js";
import { materialOf } from "../src/workflow/run.js";
import type { Run } from "../src/workflow/store.js";

describe("latentChannel", () => {
  it("delivers to the addressed recipient only, in send order", () => {
    const ch = latentChannel();
    ch.send("planner", "critic", latent([1]));
    ch.send("planner", "builder", latent([2]));
    ch.send("planner", "critic", latent([3]));
    expect(ch.depth()).toBe(3);
    expect(Array.from(ch.recv("critic")!.vector)).toEqual([1]);
    expect(Array.from(ch.recv("critic")!.vector)).toEqual([3]);
    expect(ch.recv("critic")).toBeNull();
    expect(Array.from(ch.recv("builder")!.vector)).toEqual([2]);
    expect(ch.depth()).toBe(0);
  });

  it("carries latent payloads only", () => {
    expect(() => latentChannel().send("a", "b", { kind: "text" } as never)).toThrow(/latent payloads only/);
  });
});

describe("probe", () => {
  it("monitors a payload partially and says so", () => {
    const p = probe(latent([3, 4]), "norm", (v) => Math.hypot(...Array.from(v as number[])));
    expect(p.value).toBe(5);
    expect(p.monitor).toBe("partial");
    expect(p.note).toContain("partial monitor");
  });

  it("refuses anything that is not a latent payload", () => {
    expect(() => probe({ vector: [1] } as never, "n", () => 0)).toThrow(/expects a latent payload/);
  });
});

describe("createRefs", () => {
  it("get-after-put returns the payload; identical content shares a handle", () => {
    const refs = createRefs();
    const id = refs.put({ a: 1 });
    expect(refs.has(id)).toBe(true);
    expect(refs.get(id)).toEqual({ a: 1 });
    expect(refs.put({ a: 1 })).toBe(id);
    expect(refs.put({ a: 2 })).not.toBe(id);
  });

  it("addresses content with a 64-bit hash", () => {
    expect(createRefs().put({ a: 1 })).toMatch(/^ref-[0-9a-f]{16}$/);
  });

  it("throws on a hash collision with different content instead of aliasing", () => {
    // The injected constant hash is the only way to force a 64-bit collision.
    const refs = createRefs({ hash: () => "deadbeef" });
    refs.put({ a: 1 });
    expect(() => refs.put({ a: 2 })).toThrow(/refusing to alias/);
    expect(refs.get("ref-deadbeef")).toEqual({ a: 1 }); // the original survived
  });
});

describe("isLatent and latentRef", () => {
  it("recognises a payload even after a JSON round trip", () => {
    expect(isLatent(latent([1]))).toBe(true);
    expect(isLatent(JSON.parse(JSON.stringify(latent([1]))))).toBe(true);
    expect(isLatent({ kind: "latent" })).toBe(false); // no vector, no payload
    expect(isLatent("latent")).toBe(false);
    expect(isLatent(null)).toBe(false);
  });

  it("latentRef carries shape and a content hash, never the vector", () => {
    const ref = latentRef(latent([0.125, 0.5], { source: "planner", depth: 3 }));
    expect(ref).toMatchObject({ kind: "latent", opaque: true, source: "planner", dims: 2, depth: 3 });
    expect(ref.hash).toMatch(/^[0-9a-f]{16}$/);
    expect("vector" in ref).toBe(false);
    // Deterministic: the same content addresses the same reference.
    expect(latentRef(latent([0.125, 0.5], { source: "planner", depth: 3 }))).toEqual(ref);
  });
});

describe("the audit seam", () => {
  it("materialOf refuses a latent payload as judge evidence", () => {
    expect(() => materialOf({ note: "fine", dense: latent([1, 2, 3], { source: "planner" }) })).toThrow(
      /never be judge evidence/,
    );
    expect(materialOf({ note: "fine" })).toContain("fine");
  });

  it("provenanceOf records a typed opaque reference for a latent output, never the vector", () => {
    const run: Run = {
      id: "r1",
      workflow: "wf",
      status: "done",
      input: {},
      outputs: { move: latent([0.1875, 0.25], { source: "planner", depth: 2 }), said: "hello" },
      plans: {},
      usage: { inputTokens: 0, outputTokens: 0 },
      events: [],
      startedAt: 0,
      updatedAt: 0,
    };
    const g = provenanceOf(run);
    const ent = g.entities.find((e) => e.id === "move#out");
    expect(ent?.value).toMatchObject({ kind: "latent", opaque: true, dims: 2, depth: 2 });
    expect(JSON.stringify(ent?.value)).not.toContain("0.1875");
    expect("vector" in (ent!.value as object)).toBe(false);
    // A legible output still enters as itself.
    expect(g.entities.find((e) => e.id === "said#out")?.value).toBe("hello");
  });
});
