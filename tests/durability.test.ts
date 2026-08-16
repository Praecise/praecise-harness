/**
 * A workflow that survives the process that started it.
 *
 * The existing crash-recovery tests are good and they share one shape: two sets of
 * dependency objects over one in-memory store, inside one process. That proves the
 * journal logic. It does not prove DURABILITY, which is the claim that matters when a
 * workflow spans hours and a deploy lands in the middle — and the difference is exactly
 * where a checkpointer usually turns out to be a memo.
 *
 * So these spawn real Node processes. One starts a run and is killed mid-flight; another
 * starts cold, reads the directory, and finishes it. Nothing is shared but the filesystem.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const roots: string[] = [];

/**
 * These tests import the BUILT package from a cold process, because that is the thing under
 * test: a run surviving a boundary the source tree does not cross. So they need `dist`, and
 * `npm run check` does not build.
 *
 * That combination failed on a clean CI checkout while passing on every machine that had built
 * recently — and it failed as `ENOENT ... /runs`, which points at the store rather than at the
 * missing build. The assertion below turns that into the actual sentence.
 */
const HARNESS_PATH = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const HARNESS = new URL("../dist/index.js", import.meta.url).href;

if (!existsSync(HARNESS_PATH)) {
  throw new Error(
    `these tests exercise the BUILT package from a separate process and dist/index.js is absent. ` +
      `Run \`npm run build\` first — a bare \`npm run test\` cannot check what it has not built.`,
  );
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Run a script in its own Node process, as a deploy boundary would. */
async function inItsOwnProcess(source: string, cwd: string): Promise<string> {
  const { stdout } = await run(process.execPath, ["--input-type=module", "-e", source], {
    cwd,
    timeout: 30_000,
  });
  return stdout.trim();
}

const SPEC = `workflow({
  name: "onboard",
  steps: [
    { id: "one", ask: "first", agent: "worker" },
    { id: "two", ask: "second", agent: "worker", after: ["one"] },
  ],
})`;

describe("a run outlives the process that started it", () => {
  it("checkpoints to disk, and a cold process finishes it without redoing work", async () => {
    const root = await mkdtemp(join(tmpdir(), "praecise-durable-"));
    roots.push(root);
    const runs = join(root, "runs");

    // ── Process one: does the first step, then dies mid-second ────────────
    const first = `
      const { workflow, startRun, RunStore } = await import("${HARNESS}");
      const store = new RunStore(${JSON.stringify(runs)});
      const spec = ${SPEC};
      const deps = {
        harness: {
          name: "stub",
          ask: async (_plan, input) => {
            // The second step never returns: this process is about to be killed.
            if (input === "second") await new Promise(() => {});
            return { text: "did:" + input, usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 } };
          },
        },
        store,
        planFor: async () => ({ name: "worker", instructions: "", rungs: [], tools: [], services: [] }),
        callTool: async () => ({}),
      };
      void startRun(spec, {}, deps);
      // Give the first step time to land on disk, then leave abruptly.
      await new Promise((r) => setTimeout(r, 400));
      process.exit(1);
    `;
    await inItsOwnProcess(first, root).catch(() => undefined);

    // What survived is a FILE, written by a process that no longer exists.
    const files = await readdir(runs);
    expect(files.length).toBe(1);
    const parked = JSON.parse(await readFile(join(runs, files[0]!), "utf8")) as {
      id: string;
      status: string;
      outputs: Record<string, unknown>;
    };
    expect(parked.status).toBe("running");
    expect(parked.outputs.one).toBeTruthy();

    // ── Process two: knows nothing but the directory ──────────────────────
    const second = `
      const { workflow, recoverRun, RunStore } = await import("${HARNESS}");
      const store = new RunStore(${JSON.stringify(runs)});
      const spec = ${SPEC};
      const asked = [];
      const deps = {
        harness: {
          name: "stub",
          ask: async (_plan, input) => {
            asked.push(input);
            return { text: "did:" + input, usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 } };
          },
        },
        store,
        planFor: async () => ({ name: "worker", instructions: "", rungs: [], tools: [], services: [] }),
        callTool: async () => ({}),
      };
      const done = await recoverRun(${JSON.stringify(parked.id)}, spec, deps);
      console.log(JSON.stringify({ status: done.status, asked, one: done.outputs.one, two: done.outputs.two }));
    `;
    const finished = JSON.parse(await inItsOwnProcess(second, root)) as {
      status: string;
      asked: string[];
      one: unknown;
      two: unknown;
    };

    expect(finished.status).toBe("done");
    // The guarantee: the completed step came off disk and was NOT run again. If this
    // ever regresses, every workflow with a side effect repeats it after a deploy.
    expect(finished.asked).toEqual(["second"]);
    expect(finished.one).toBeTruthy();
    expect(finished.two).toBeTruthy();
  }, 60_000);

  it("keeps the event history across the boundary, so a finished run can be read back", async () => {
    const root = await mkdtemp(join(tmpdir(), "praecise-durable-"));
    roots.push(root);
    const runs = join(root, "runs");

    const source = `
      const { workflow, startRun, RunStore } = await import("${HARNESS}");
      const store = new RunStore(${JSON.stringify(runs)});
      const spec = ${SPEC};
      const deps = {
        harness: { name: "stub", ask: async (_p, input) => ({ text: "did:" + input, usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 } }) },
        store,
        planFor: async () => ({ name: "worker", instructions: "", rungs: [], tools: [], services: [] }),
        callTool: async () => ({}),
      };
      const done = await startRun(spec, {}, deps);
      console.log(done.id);
    `;
    const id = await inItsOwnProcess(source, root);

    // A different process reads the record: what ran, in what order, and when.
    const reader = `
      const { RunStore } = await import("${HARNESS}");
      const store = new RunStore(${JSON.stringify(runs)});
      const run = await store.load(${JSON.stringify(id)});
      console.log(JSON.stringify({
        status: run.status,
        steps: run.events.filter((e) => e.kind === "done").map((e) => e.step),
      }));
    `;
    const record = JSON.parse(await inItsOwnProcess(reader, root)) as {
      status: string;
      steps: string[];
    };

    expect(record.status).toBe("done");
    // Order is the dependency order, recovered from disk by a process that never ran it.
    expect(record.steps).toEqual(["one", "two"]);
  }, 60_000);
});
