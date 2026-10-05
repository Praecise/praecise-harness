/**
 * The sealed journal: one hash-chained, signed entry per acting step, delivered
 * to a sink at least once and in order, and verifiable afterwards.
 */

import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { App } from "../src/app.js";
import { canonicalJson, digestOf, verifyJournal, type SealedEntry, type Signer } from "../src/journal.js";
import { MODEL_ENV, TEST_ENDPOINT, cleanup, FRAMEWORK, makeProject } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(cleanup)));

const FILES = {
  "praecise.config.ts": `import { defineConfig } from "${FRAMEWORK}";
    export default defineConfig({ name: "acme", ${TEST_ENDPOINT} });`,
  "functions/pay.ts": `import { fn } from "${FRAMEWORK}";
    export default fn({
      description: "Pay someone.",
      input: { to: "who", amount: "how much" },
      effect: "write",
      action: ({ to, amount }) => ({ operation: "pay", counterparty: String(to), amount: String(amount) }),
      run: ({ to }) => ({ paid: String(to) }),
    });`,
  "workflows/twice.ts": `import { workflow } from "${FRAMEWORK}";
    export default workflow({
      description: "Pay two people.",
      steps: [
        { id: "a", use: "pay", with: { to: "bob", amount: "1" } },
        { id: "b", use: "pay", with: { to: "eve", amount: "2" } },
      ],
    });`,
};

/** A keyed signer standing in for a hardware one. */
const signer: Signer = {
  async sign(bytes) {
    return { signature: createHmac("sha256", "k").update(bytes).digest("hex"), keyRef: "k1" };
  },
  async verify(bytes, signature, keyRef) {
    return keyRef === "k1" && createHmac("sha256", "k").update(bytes).digest("hex") === signature;
  },
};

describe("a sealed journal", () => {
  it("canonicalises key order before hashing", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe('{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}');
    expect(digestOf({ x: 1, y: 2 })).toBe(digestOf({ y: 2, x: 1 }));
  });

  it("seals each acting step, chained and signed, and delivers them in order", async () => {
    const root = await makeProject(FILES);
    roots.push(root);
    const got: SealedEntry[] = [];
    const app = await App.load({
      root,
      env: MODEL_ENV,
      journal: { signer, sink: { append: async (e) => (got.push(e), { anchor: `anchor-${e.entry.seq}` }) } },
    });
    const run = await app.startWorkflow("twice", {});
    expect(run.status).toBe("done");
    expect(got.map((e) => e.entry.step)).toEqual(["a", "b"]);
    expect(got[0]!.entry.prev).toBeNull();
    expect(got[1]!.entry.prev).toBe(got[0]!.hash);
    expect(got[1]!.entry.action).toEqual({ operation: "pay", counterparty: "eve", amount: "2" });
    expect(got[0]!.entry.output).toBe(digestOf({ paid: "bob" }));
    expect(run.journal?.delivered).toBe(2);
    expect(run.journal?.anchors).toEqual({ 0: "anchor-0", 1: "anchor-1" });
    expect(await verifyJournal(got, signer)).toBeUndefined();
    await app.close();
  });

  it("detects an edited, dropped or unsigned entry", async () => {
    const root = await makeProject(FILES);
    roots.push(root);
    const got: SealedEntry[] = [];
    const app = await App.load({ root, env: MODEL_ENV, journal: { signer, sink: { append: async (e) => void got.push(e) } } });
    await app.startWorkflow("twice", {});
    await app.close();

    const edited = structuredClone(got);
    edited[1]!.entry.output = digestOf({ paid: "mallory" });
    expect(await verifyJournal(edited, signer)).toMatch(/does not match its hash/);
    expect(await verifyJournal([got[1]!], signer)).toMatch(/numbered 1/);
    const unsigned = got.map(({ entry, hash }) => ({ entry, hash }));
    expect(await verifyJournal(unsigned, signer)).toMatch(/not signed/);
    expect(await verifyJournal(unsigned)).toBeUndefined();
  });

  it("fails the run when the sink refuses, and re-delivers on recovery", async () => {
    const root = await makeProject(FILES);
    roots.push(root);
    let down = true;
    const got: SealedEntry[] = [];
    const sink = {
      append: async (e: SealedEntry) => {
        if (down) throw new Error("sink offline");
        got.push(e);
      },
    };
    const app = await App.load({ root, env: MODEL_ENV, journal: { sink } });
    const failed = await app.startWorkflow("twice", {});
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/journal sink did not take entry 0/);
    // The step's effect is recorded with its entry, so nothing runs twice.
    expect(failed.outputs.a).toEqual({ paid: "bob" });
    expect(failed.journal?.delivered).toBe(0);

    down = false;
    const stored = (await app.runs.load(failed.id))!;
    stored.status = "running";
    delete stored.error;
    await app.runs.save(stored);
    const done = await app.recoverWorkflow(failed.id);
    expect(done.status).toBe("done");
    expect(got.map((e) => e.entry.seq)).toEqual([0, 1]);
    expect(await verifyJournal(got)).toBeUndefined();
    await app.close();
  });
});

describe("a sandbox under the journal", () => {
  it("names a snapshot on every entry and restores the latest before recovery", async () => {
    const root = await makeProject(FILES);
    roots.push(root);
    let n = 0;
    const restored: string[] = [];
    const sandbox = {
      snapshot: async ({ step }: { run: string; step: string }) => `snap-${step}-${n++}`,
      restore: async (ref: string) => void restored.push(ref),
    };
    const got: SealedEntry[] = [];
    let down = false;
    const sink = {
      append: async (e: SealedEntry) => {
        if (down) throw new Error("offline");
        got.push(e);
      },
    };
    const app = await App.load({ root, env: MODEL_ENV, sandbox, journal: { sink } });
    const done = await app.startWorkflow("twice", {});
    expect(got.map((e) => e.entry.sandbox)).toEqual(["snap-a-0", "snap-b-1"]);

    // A crashed run is recovered from the snapshot its last journalled step left.
    down = true;
    const failed = await app.startWorkflow("twice", {});
    expect(failed.status).toBe("failed");
    down = false;
    const stored = (await app.runs.load(failed.id))!;
    stored.status = "running";
    await app.runs.save(stored);
    await app.recoverWorkflow(failed.id);
    expect(restored).toEqual(["snap-a-2"]);
    expect(done.status).toBe("done");
    await app.close();
  });
});
