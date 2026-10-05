/**
 * Durable triggers and sealed run files: a source resumes after its stored
 * cursor without starting a run twice, and a store with a cipher never writes or
 * reads a run in the clear.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { App } from "../src/app.js";
import type { Source, SourceEvent } from "../src/sources.js";
import type { RunCipher } from "../src/workflow/store.js";
import { MODEL_ENV, TEST_ENDPOINT, cleanup, FRAMEWORK, makeProject } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(cleanup)));

async function project(): Promise<string> {
  const root = await makeProject({
    "praecise.config.ts": `import { defineConfig } from "${FRAMEWORK}";
      export default defineConfig({ name: "acme", ${TEST_ENDPOINT} });`,
    "functions/note.ts": `import { fn } from "${FRAMEWORK}";
      export default fn({
        description: "Note an event.",
        input: { id: "event id" },
        run: ({ id }) => { globalThis.__noted = (globalThis.__noted ?? []).concat(String(id)); return { noted: String(id) }; },
      });`,
    "workflows/on-event.ts": `import { workflow } from "${FRAMEWORK}";
      export default workflow({ description: "Note it.", steps: [{ id: "note", use: "note", with: { id: "{{id}}" } }] });`,
  });
  roots.push(root);
  return root;
}

/** A source over a fixed list, recording which cursor it was asked to continue after. */
function listSource(events: SourceEvent[], asked: (string | undefined)[]): Source {
  return {
    name: "list",
    async *subscribe(cursor) {
      asked.push(cursor);
      const from = cursor === undefined ? 0 : events.findIndex((e) => e.cursor === cursor) + 1;
      for (const e of events.slice(from)) yield e;
    },
  };
}

const EVENTS: SourceEvent[] = [
  { cursor: "c1", event: { id: "e1" } },
  { cursor: "c2", event: { id: "e2" } },
];

describe("a source", () => {
  it("starts one run per event and resumes after the stored cursor", async () => {
    const root = await project();
    (globalThis as { __noted?: string[] }).__noted = [];
    const asked: (string | undefined)[] = [];
    const app = await App.load({ root, env: MODEL_ENV });
    const ids: string[] = [];
    const input = (event: unknown) => event as Record<string, unknown>;
    await app.follow(listSource(EVENTS, asked), "on-event", { signal: new AbortController().signal, input, onRun: (r) => ids.push(r.id) });
    expect(ids).toHaveLength(2);
    // A restart continues after c2: nothing is run again.
    await app.follow(listSource([...EVENTS, { cursor: "c3", event: { id: "e3" } }], asked), "on-event", {
      signal: new AbortController().signal,
      input,
    });
    expect(asked).toEqual([undefined, "c2"]);
    expect((globalThis as { __noted?: string[] }).__noted).toEqual(["e1", "e2", "e3"]);
    await app.close();
  });

  it("finds the existing run when an event is delivered again", async () => {
    const root = await project();
    (globalThis as { __noted?: string[] }).__noted = [];
    const app = await App.load({ root, env: MODEL_ENV });
    const input = (event: unknown) => event as Record<string, unknown>;
    const first: string[] = [];
    const again: string[] = [];
    await app.follow(listSource(EVENTS.slice(0, 1), []), "on-event", { signal: new AbortController().signal, input, onRun: (r) => first.push(r.id) });
    // The same event, as if the cursor had not been stored before a crash.
    const replay: Source = { name: "list", async *subscribe() { yield EVENTS[0]!; } };
    await app.follow(replay, "on-event", { signal: new AbortController().signal, input, onRun: (r) => again.push(r.id) });
    expect(again).toEqual(first);
    expect((globalThis as { __noted?: string[] }).__noted).toEqual(["e1"]);
    await app.close();
  });
});

describe("sealed runs", () => {
  const key = randomBytes(32);
  const cipher: RunCipher = {
    async seal(plain) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([c.update(plain), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), body]);
    },
    async open(sealed) {
      const b = Buffer.from(sealed);
      const d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      return Buffer.concat([d.update(b.subarray(28)), d.final()]);
    },
  };

  it("writes nothing in the clear and reads its own runs back", async () => {
    const root = await project();
    const app = await App.load({ root, env: MODEL_ENV, runCipher: cipher });
    const run = await app.startWorkflow("on-event", { id: "secret-event" });
    const dir = join(app.stateDir, "runs");
    for (const name of await readdir(dir)) {
      expect((await readFile(join(dir, name))).toString("latin1")).not.toContain("secret-event");
    }
    expect((await app.runs.load(run.id))?.input).toEqual({ id: "secret-event" });
    expect((await app.runs.list()).map((r) => r.id)).toEqual([run.id]);
    await app.close();
  });

  it("refuses a run file it cannot open instead of calling it missing", async () => {
    const root = await project();
    const plain = await App.load({ root, env: MODEL_ENV });
    const run = await plain.startWorkflow("on-event", { id: "x" });
    await plain.close();
    const sealed = await App.load({ root, env: MODEL_ENV, runCipher: cipher });
    await expect(sealed.runs.load(run.id)).rejects.toThrow(/not sealed/);
    await sealed.close();
  });
});
