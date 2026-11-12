/**
 * A step that waits for something to happen outside.
 *
 * An approval is one thing a run can stop for; the other is an event — a payment
 * landing, a build finishing, a reply arriving. The run is persisted the same way,
 * and what has to hold is what makes any event safe to act on: the one that matches
 * continues the run, once, however many times it is delivered, and nothing else does.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/app.js";
import { workflow } from "../src/define.js";
import { CLOUDEVENTS_JSON, type CloudEvent } from "../src/events.js";
import { serve, type DevServer } from "../src/server/index.js";
import { outcomeOf } from "../src/server/mcp.js";
import { defectsIn } from "../src/workflow/defects.js";
import { FRAMEWORK, MODEL_ENV, TEST_ENDPOINT, TEST_TOKEN, authed, cleanup, makeProject, stubModel } from "./helpers.js";

const FILES = {
  "praecise.config.ts": `import { defineConfig } from "${FRAMEWORK}";
    export default defineConfig({ name: "acme", quality: "fast", ${TEST_ENDPOINT} });`,
  "functions/note.ts": `import { fn } from "${FRAMEWORK}";
    export default fn({
      description: "Write something down.",
      input: { what: "what to note" },
      run: ({ what }) => { globalThis.__noted = (globalThis.__noted ?? []).concat(String(what)); return { noted: String(what) }; },
    });`,
  "workflows/order.ts": `import { workflow } from "${FRAMEWORK}";
    export default workflow({
      description: "Ship an order once it is paid for.",
      input: { order: "the order id" },
      steps: [
        { id: "placed", use: "note", with: { what: "placed {{order}}" } },
        { id: "paid", wait: "com.acme.payment.received", subject: "{{order}}" },
        { id: "ship", use: "note", with: { what: "ship {{order}} for {{paid.data.amount}}" } },
      ],
    });`,
  "workflows/pair.ts": `import { workflow } from "${FRAMEWORK}";
    export default workflow({
      description: "Two readings, one after the other.",
      steps: [
        { id: "first", wait: "reading.taken" },
        { id: "second", wait: "reading.taken" },
        { id: "both", use: "note", with: { what: "{{first.data}} then {{second.data}}" } },
      ],
    });`,
  "workflows/quote.ts": `import { workflow } from "${FRAMEWORK}";
    export default workflow({
      description: "Wait a short while for a reply.",
      steps: [
        { id: "reply", wait: "reply.received", timeout: 0.05 },
        { id: "thank", use: "note", with: { what: "thanked" } },
      ],
    });`,
  "workflows/nudge.ts": `import { workflow } from "${FRAMEWORK}";
    export default workflow({
      description: "Wait a short while for a reply, and chase if there is none.",
      steps: [
        { id: "reply", wait: "reply.received", timeout: 0.05, onTimeout: "continue" },
        { id: "chase", use: "note", with: { what: "silence: {{reply.timedOut}}" } },
      ],
    });`,
};

const noted = (): string[] => (globalThis as { __noted?: string[] }).__noted ?? [];
const until = (check: () => void | Promise<void>) => vi.waitFor(check, { timeout: 5000, interval: 10 });

const paid = (id: string, order: string, amount = 40): CloudEvent => ({
  specversion: "1.0",
  id,
  source: "/billing",
  type: "com.acme.payment.received",
  subject: order,
  data: { amount },
});

let root: string | undefined;
let app: App | undefined;
let server: DevServer | undefined;

afterEach(async () => {
  await server?.close();
  await app?.close();
  if (root) await cleanup(root);
  root = app = server = undefined;
});

async function start(): Promise<App> {
  (globalThis as { __noted?: string[] }).__noted = [];
  root = await makeProject(FILES);
  app = await App.load({ root, env: MODEL_ENV, fetch: stubModel([]).fetch });
  return app;
}

describe("a step that waits for an event", () => {
  it("stops the run, on disk, saying what it waits for", async () => {
    const running = await start();
    const run = await running.startWorkflow("order", { order: "A-17" });

    expect(run.status).toBe("waiting");
    expect(run.waitingFor).toMatchObject({
      step: "paid",
      event: { type: "com.acme.payment.received", subject: "A-17" },
    });
    expect(noted()).toEqual(["placed A-17"]);
    expect(await running.runs.waiting()).toEqual([{ run: run.id, type: "com.acme.payment.received" }]);
    expect(outcomeOf(run).text).toContain("waiting at step \"paid\" for the event com.acme.payment.received");
  });

  it("is not answered by an approval", async () => {
    const running = await start();
    const run = await running.startWorkflow("order", { order: "A-17" });

    await expect(running.resumeWorkflow(run.id, { approved: true })).rejects.toThrow(
      "waiting at step \"paid\" for the event com.acme.payment.received, not for approval",
    );
    expect((await running.runs.load(run.id))?.status).toBe("waiting");
    expect(noted()).toEqual(["placed A-17"]);
  });

  it("is continued by the event it named, with the event as the step's output", async () => {
    const running = await start();
    const run = await running.startWorkflow("order", { order: "A-17" });

    const after = await running.deliver("order", paid("pay-1", "A-17", 55));

    expect(after.id).toBe(run.id);
    expect(after.status).toBe("done");
    expect(after.outputs.paid).toEqual({
      type: "com.acme.payment.received",
      source: "/billing",
      id: "pay-1",
      subject: "A-17",
      data: { amount: 55 },
      timedOut: false,
    });
    expect(noted()).toEqual(["placed A-17", "ship A-17 for 55"]);
    expect(await running.runs.waiting()).toEqual([]);
  });

  it("is left waiting by an event about something else, which is not kept", async () => {
    const running = await start();
    const run = await running.startWorkflow("order", { order: "A-17" });

    expect(await running.signal(paid("pay-9", "B-02"))).toEqual([]);
    expect(await running.signal({ ...paid("pay-10", "A-17"), type: "com.acme.payment.refunded" })).toEqual([]);
    expect((await running.runs.load(run.id))?.status).toBe("waiting");
    expect(noted()).toEqual(["placed A-17"]);
  });

  it("continues once however many times the event is delivered", async () => {
    const running = await start();
    const run = await running.startWorkflow("order", { order: "A-17" });
    const event = paid("pay-1", "A-17");

    // Twice at the same instant, as a sender that timed out and retried would.
    const [one, two] = await Promise.all([running.deliver("order", event), running.deliver("order", event)]);
    // And again later, long after the run finished.
    const three = await running.deliver("order", event);

    expect([one.id, two.id, three.id]).toEqual([run.id, run.id, run.id]);
    expect(noted()).toEqual(["placed A-17", "ship A-17 for 40"]);
    // The retry did not start a run of its own.
    expect(await running.runs.list()).toHaveLength(1);
    expect((await running.runs.load(run.id))?.signals).toHaveLength(1);
  });

  it("does not take a second delivery of one event for the second of two it waits for", async () => {
    const running = await start();
    const run = await running.startWorkflow("pair", {});
    const reading = (id: string, data: string): CloudEvent => ({
      specversion: "1.0",
      id,
      source: "/sensors",
      type: "reading.taken",
      data,
    });

    const first = await running.deliver("pair", reading("r-1", "cold"));
    expect(first.waitingFor?.step).toBe("second");

    const again = await running.deliver("pair", reading("r-1", "cold"));
    expect(again.id).toBe(run.id);
    expect((await running.runs.load(run.id))?.waitingFor?.step).toBe("second");

    const done = await running.deliver("pair", reading("r-2", "warm"));
    expect(done.status).toBe("done");
    expect(noted()).toEqual(["cold then warm"]);
  });

  it("continues every run that is waiting for the event, each once", async () => {
    const running = await start();
    const a = await running.startWorkflow("pair", {});
    const b = await running.startWorkflow("pair", {});

    const went = await running.signal({ specversion: "1.0", id: "r-1", source: "/sensors", type: "reading.taken", data: "x" });

    expect(went.map((run) => run.id).sort()).toEqual([a.id, b.id].sort());
    expect(went.every((run) => run.waitingFor?.step === "second")).toBe(true);
  });

  it("is reached over HTTP by the route events already arrive on", async () => {
    (globalThis as { __noted?: string[] }).__noted = [];
    root = await makeProject(FILES);
    server = await serve({ root, port: 0, watch: false, env: MODEL_ENV, fetch: stubModel([]).fetch, token: TEST_TOKEN });
    const run = await server.app().startWorkflow("order", { order: "A-17" });

    const res = await fetch(`http://127.0.0.1:${server.port}/api/events/order`, {
      method: "POST",
      headers: authed({ "content-type": CLOUDEVENTS_JSON }),
      body: JSON.stringify(paid("pay-1", "A-17")),
    });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ runs: [{ id: run.id, status: "done" }] });
    expect(noted()).toEqual(["placed A-17", "ship A-17 for 40"]);
  });
});

describe("a wait that runs out of time", () => {
  it("fails the run by itself while the app is held, and says what it waited for", async () => {
    const running = await start();
    const run = await running.startWorkflow("quote", {});
    expect(run.waitingFor?.event?.until).toBeGreaterThan(Date.now());

    await until(async () => expect((await running.runs.load(run.id))?.status).toBe("failed"));
    const after = await running.runs.load(run.id);
    expect(after?.error).toBe('step "reply" waited for the event reply.received and none arrived in time');
    expect(noted()).toEqual([]);
    expect(await running.runs.waiting()).toEqual([]);
  });

  it("carries on instead, where the step said to, with the silence as its output", async () => {
    const running = await start();
    const run = await running.startWorkflow("nudge", {});

    await until(async () => expect((await running.runs.load(run.id))?.status).toBe("done"));
    expect((await running.runs.load(run.id))?.outputs.reply).toEqual({ timedOut: true });
    expect(noted()).toEqual(["silence: true"]);
  });

  it("is ended when the app is next held, for a deadline that passed while nothing ran", async () => {
    const first = await start();
    const run = await first.startWorkflow("quote", {});
    // The process goes away before the deadline, taking its timer with it.
    await first.close();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect((await first.runs.load(run.id))?.status).toBe("waiting");

    app = await App.load({ root: root!, env: MODEL_ENV, fetch: stubModel([]).fetch });
    const ended = await app.expire();

    expect(ended.map((each) => [each.id, each.status])).toEqual([[run.id, "failed"]]);
  });

  it("is not answered by an event that arrives after the deadline", async () => {
    const running = await start();
    const run = await running.startWorkflow("quote", {});
    await running.close();
    await new Promise((resolve) => setTimeout(resolve, 80));

    app = await App.load({ root: root!, env: MODEL_ENV, fetch: stubModel([]).fetch });
    const went = await app.signal({ specversion: "1.0", id: "late", source: "/mail", type: "reply.received" });

    expect(went).toEqual([]);
    expect((await app.runs.load(run.id))?.status).toBe("failed");
    expect(noted()).toEqual([]);
  });

  it("keeps the deadline it first set when the run is driven again", async () => {
    const running = await start();
    const run = await running.startWorkflow("quote", {});
    const loaded = await running.runs.load(run.id);
    expect(loaded?.deadlines).toEqual({ reply: run.waitingFor?.event?.until });
  });

  it("refuses a timeout that is not a positive number of seconds, before anything runs", () => {
    const spec = workflow({ name: "bad", steps: [{ id: "reply", wait: "reply.received", timeout: 0 }] });
    expect(defectsIn(spec).join("\n")).toContain('step "reply" has a `timeout` of 0');
  });
});
