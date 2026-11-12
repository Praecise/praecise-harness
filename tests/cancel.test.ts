/**
 * A run that is under way can be stopped.
 *
 * Stopping is only worth having if three things hold. The call in flight is really
 * interrupted, so nothing more is paid for. The record says `cancelled` and not
 * `failed`, whatever the interrupted call threw on its way out, and keeps what had
 * finished. And a tool that ignores the request cannot hold the run open.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/app.js";
import type { AgentPlan } from "../src/compile/plan.js";
import { workflow } from "../src/define.js";
import type { CloudEvent } from "../src/events.js";
import type { Answer, Harness } from "../src/harness/types.js";
import { serve, type DevServer } from "../src/server/index.js";
import { cancelRun, recoverRun, resumeRun, startRun, type WorkflowDeps } from "../src/workflow/run.js";
import { RunStore } from "../src/workflow/store.js";
import { FRAMEWORK, MODEL_ENV, TEST_ENDPOINT, TEST_TOKEN, authed, cleanup, makeProject, stubModel } from "./helpers.js";

const plan: AgentPlan = {
  name: "test",
  description: "test",
  quality: "fast",
  instructions: "",
  rungs: [],
  services: [],
  locals: [],
  memory: false,
  problems: [],
};

const answer = (text: string): Answer => ({
  text,
  path: ["stub"],
  usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, decidingTokens: 0 },
  toolCalls: [],
  harness: "stub",
});

let dir: string;
let store: RunStore;
let asked: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "praecise-cancel-"));
  store = new RunStore(dir);
  asked = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * A model that answers at once, except to a question containing "slow", which it
 * holds until its signal aborts — as a real request does.
 */
function deps(callTool: WorkflowDeps["callTool"] = async () => "ok"): WorkflowDeps {
  const harness: Harness = {
    name: "stub",
    async ask(_plan, input, options) {
      asked.push(input);
      if (!input.includes("slow")) return answer(`answered: ${input}`);
      return new Promise<Answer>((_, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("the request was aborted")), { once: true });
      });
    },
  };
  return { harness, store, planFor: async () => plan, callTool };
}

const until = (check: () => void) => vi.waitFor(check, { timeout: 5000, interval: 5 });

const THREE = workflow({
  name: "three",
  steps: [
    { id: "first", ask: "quick one" },
    { id: "second", ask: "a slow one" },
    { id: "third", ask: "never reached" },
  ],
});

describe("cancelling a run in flight", () => {
  it("interrupts the call under way, starts nothing more, and records the run as cancelled", async () => {
    const running = startRun(THREE, {}, deps(), { id: "r1" });
    await until(() => expect(asked).toContain("a slow one"));

    const cancelled = await cancelRun("r1", { store }, { reason: "the customer withdrew", by: "ada" });

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelled).toMatchObject({ reason: "the customer withdrew", by: "ada" });
    // What had finished is kept, and the step that was interrupted has no output.
    expect(cancelled.outputs).toEqual({ first: "answered: quick one" });
    expect(cancelled.error).toBeUndefined();
    expect(cancelled.events.at(-1)).toMatchObject({ kind: "cancelled", detail: "cancelled by ada: the customer withdrew" });
    expect(asked).not.toContain("never reached");

    // The caller that started it is told the same thing, and so is the file.
    expect((await running).status).toBe("cancelled");
    expect((await store.load("r1"))?.status).toBe("cancelled");
  });

  it("is cancelled by the signal it was started with", async () => {
    const stop = new AbortController();
    const running = startRun(THREE, {}, deps(), { id: "r2", signal: stop.signal });
    await until(() => expect(asked).toContain("a slow one"));
    stop.abort();

    const run = await running;
    expect(run.status).toBe("cancelled");
    expect(run.outputs).toEqual({ first: "answered: quick one" });
  });

  it("hands a tool the signal, and does not wait for a tool that ignores it", async () => {
    let heard: AbortSignal | undefined;
    const spec = workflow({ name: "effect", steps: [{ id: "charge", use: "billing.charge", with: { amount: 5 } }] });
    const running = startRun(
      spec,
      {},
      deps((_ref, _args, opts) => {
        heard = opts?.signal;
        // Never settles, whatever it is told.
        return new Promise(() => undefined);
      }),
      { id: "r3" },
    );
    await until(() => expect(heard).toBeDefined());

    const cancelled = await cancelRun("r3", { store });
    expect(cancelled.status).toBe("cancelled");
    expect(heard?.aborted).toBe(true);
    // Whether the charge happened is exactly what nobody can say, so the marker stays.
    expect(Object.keys(cancelled.inflight ?? {})).toEqual(["charge"]);
    await running;
  });

  it("stops every branch of a graph, not only the one that was asked first", async () => {
    const spec = workflow({
      name: "fan",
      steps: [
        { id: "a", ask: "slow a" },
        { id: "b", ask: "slow b" },
        { id: "join", ask: "after both", after: ["a", "b"] },
      ],
    });
    const running = startRun(spec, {}, deps(), { id: "r4" });
    await until(() => expect(asked).toEqual(expect.arrayContaining(["slow a", "slow b"])));

    expect((await cancelRun("r4", { store })).status).toBe("cancelled");
    expect((await running).outputs).toEqual({});
    expect(asked).not.toContain("after both");
  });

  it("honours a request left beside the run by a process that is not driving it", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const spec = workflow({
      name: "two",
      steps: [
        { id: "work", use: "slow.tool" },
        { id: "next", ask: "never reached" },
      ],
    });
    const running = startRun(
      spec,
      {},
      deps(async () => {
        await held;
        return "finished";
      }),
      { id: "r5" },
    );
    await until(async () => expect(await store.load("r5")).toBeDefined());

    // What another process does: it cannot reach this one's memory, only the store.
    await store.requestCancel("r5", { reason: "asked from elsewhere" });
    release();

    const run = await running;
    expect(run.status).toBe("cancelled");
    expect(run.cancelled?.reason).toBe("asked from elsewhere");
    // The step that was already running finished and is kept; the next never began.
    expect(run.outputs).toEqual({ work: "finished" });
    expect(asked).toEqual([]);
    expect(await store.cancelRequested("r5")).toBeUndefined();
  });
});

describe("cancelling a run nobody is driving", () => {
  const GATED = workflow({
    name: "gated",
    steps: [
      { id: "gate", approve: "Go ahead?" },
      { id: "after", ask: "carry on" },
    ],
  });

  it("ends a run waiting at a gate, which can then not be approved", async () => {
    const waiting = await startRun(GATED, {}, deps(), { id: "g1" });
    expect(waiting.status).toBe("waiting");

    const cancelled = await cancelRun("g1", { store }, { reason: "no longer needed" });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.waitingFor).toBeUndefined();
    expect(cancelled.events.at(-1)).toMatchObject({ step: "gate", kind: "cancelled" });

    await expect(resumeRun("g1", { approved: true }, GATED, deps())).rejects.toThrow("is cancelled, not waiting");
    await expect(recoverRun("g1", GATED, deps())).rejects.toThrow("is cancelled");
    expect(asked).toEqual([]);
  });

  it("leaves a run that had finished as it finished", async () => {
    const done = await startRun(workflow({ name: "one", steps: [{ id: "only", ask: "quick" }] }), {}, deps(), { id: "d1" });
    expect(done.status).toBe("done");

    const after = await cancelRun("d1", { store });
    expect(after.status).toBe("done");
    expect(after.cancelled).toBeUndefined();
    expect(after.result).toBe("answered: quick");
  });

  it("says so when there is no such run", async () => {
    await expect(cancelRun("nope", { store })).rejects.toThrow("no such run: nope");
  });
});

describe("cancelling through an app", () => {
  const FILES = {
    "praecise.config.ts": `import { defineConfig } from "${FRAMEWORK}";
      export default defineConfig({ name: "acme", quality: "fast", ${TEST_ENDPOINT} });`,
    "workflows/ship.ts": `import { workflow } from "${FRAMEWORK}";
      export default workflow({
        description: "Ship something, once a person says so.",
        input: { what: "what to ship" },
        steps: [{ id: "gate", approve: "Ship {{what}}?" }, { id: "after", ask: "confirm the shipment" }],
      });`,
  };

  let root: string | undefined;
  let app: App | undefined;
  let server: DevServer | undefined;

  afterEach(async () => {
    await server?.close();
    await app?.close();
    if (root) await cleanup(root);
    root = app = server = undefined;
  });

  it("reports the cancellation as a run event, which says nothing the run keeps private", async () => {
    const events: CloudEvent[] = [];
    root = await makeProject(FILES);
    app = await App.load({
      root,
      env: MODEL_ENV,
      fetch: stubModel([]).fetch,
      notify: (event) => void events.push(event),
    });
    const run = await app.startWorkflow("ship", { what: "the release" });

    await app.cancelWorkflow(run.id, { reason: "a private reason" });
    await until(() => expect(events).toHaveLength(3));

    expect(events.map((event) => event.type)).toEqual([
      "com.praecise.run.started",
      "com.praecise.run.waiting",
      "com.praecise.run.cancelled",
    ]);
    expect(events[2]!.subject).toBe(run.id);
    expect(events[2]!.data).toEqual({ run: run.id, workflow: "ship", status: "cancelled" });
    expect(JSON.stringify(events[2])).not.toContain("a private reason");
  });

  it("is a route beside the one that approves: POST /api/runs/<id>/cancel", async () => {
    root = await makeProject(FILES);
    server = await serve({ root, port: 0, watch: false, env: MODEL_ENV, fetch: stubModel([]).fetch, token: TEST_TOKEN });
    const at = `http://127.0.0.1:${server.port}`;
    const post = (path: string, body: unknown) =>
      fetch(`${at}${path}`, {
        method: "POST",
        headers: authed({ "content-type": "application/json" }),
        body: JSON.stringify(body),
      });

    const started = (await (await post("/api/workflows/ship", { input: { what: "it" } })).json()) as { id: string };
    const cancelled = await post(`/api/runs/${started.id}/cancel`, { reason: "changed our minds", by: "grace" });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({
      id: started.id,
      status: "cancelled",
      cancelled: { reason: "changed our minds", by: "grace" },
    });

    // It needs the token like everything else under /api, and a run that is not there is a 404.
    const anonymous = await fetch(`${at}/api/runs/${started.id}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(anonymous.status).toBe(401);
    expect((await post("/api/runs/nope/cancel", {})).status).toBe(404);

    // And the gate it was waiting at no longer answers.
    const approved = await post(`/api/runs/${started.id}`, { approved: true });
    expect(approved.status).toBe(400);
    expect(((await approved.json()) as { error: string }).error).toContain("is cancelled");
  });
});
