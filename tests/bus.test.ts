/**
 * An event bus inside the app, and a description of the app's events.
 *
 * The bus is not a second way in. An event published from a step or a tool goes
 * through the same door as one posted from outside, so what holds there holds here:
 * `source` and `id` name the run, and an event published twice does its work once.
 * What is new is who decides where it goes — a workflow says which events start it,
 * and nothing has to know the name of anything else.
 */
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../src/app.js";
import { CLOUDEVENTS_JSON, cloudEvent, type CloudEvent } from "../src/events.js";
import { serve, type DevServer } from "../src/server/index.js";
import { FRAMEWORK, MODEL_ENV, TEST_ENDPOINT, TEST_TOKEN, authed, cleanup, makeProject, stubModel, type Reply } from "./helpers.js";

const FILES = {
  "praecise.config.ts": `import { defineConfig } from "${FRAMEWORK}";
    export default defineConfig({ name: "acme", version: "2.0.0", quality: "fast", ${TEST_ENDPOINT} });`,
  "functions/note.ts": `import { fn } from "${FRAMEWORK}";
    export default fn({
      description: "Write something down.",
      input: { what: "what to note" },
      run: ({ what }) => { globalThis.__noted = (globalThis.__noted ?? []).concat(String(what)); return { noted: String(what) }; },
    });`,
  "functions/announce.ts": `import { fn } from "${FRAMEWORK}";
    export default fn({
      description: "Tell whoever cares that an order was placed.",
      input: { order: "the order id" },
      run: async ({ order }, { publish }) => {
        const runs = await publish("com.acme.order.placed", { order }, { subject: String(order) });
        return { told: runs.map((run) => run.workflow).sort() };
      },
    });`,
  "functions/echo.ts": `import { fn } from "${FRAMEWORK}";
    export default fn({
      description: "Publish the event that started this.",
      run: async (_args, { publish }) => {
        globalThis.__echoed = (globalThis.__echoed ?? 0) + 1;
        await publish("com.acme.ping", {});
        return "sent";
      },
    });`,
  "agents/clerk.ts": `import { agent } from "${FRAMEWORK}";
    export default agent({ role: "Take orders.", description: "Takes an order.", tools: ["announce"] });`,
  "workflows/checkout.ts": `import { workflow } from "${FRAMEWORK}";
    export default workflow({
      description: "Take an order and say so.",
      input: { order: "the order id" },
      steps: [{ id: "tell", use: "announce", with: { order: "{{order}}" } }],
    });`,
  "workflows/fulfil.ts": `import { workflow } from "${FRAMEWORK}";
    export default workflow({
      description: "Pack an order that was placed.",
      on: "com.acme.order.placed",
      steps: [{ id: "pack", use: "note", with: { what: "pack {{event.order}}" } }],
    });`,
  "workflows/ledger.ts": `import { workflow } from "${FRAMEWORK}";
    export default workflow({
      description: "Book an order that was placed or refunded.",
      on: ["com.acme.order.placed", "com.acme.order.refunded"],
      steps: [{ id: "book", use: "note", with: { what: "book {{type}} {{subject}}" } }],
    });`,
  "workflows/courier.ts": `import { workflow } from "${FRAMEWORK}";
    export default workflow({
      description: "Hand an order over once it is packed.",
      access: "gated",
      input: { order: "the order id" },
      steps: [
        { id: "packed", wait: "com.acme.order.packed", subject: "{{order}}" },
        { id: "hand", use: "note", with: { what: "hand over {{order}}" } },
      ],
    });`,
  "workflows/loop.ts": `import { workflow } from "${FRAMEWORK}";
    export default workflow({
      description: "Publishes what it is started by.",
      access: "internal",
      on: "com.acme.ping",
      steps: [{ id: "again", use: "echo" }],
    });`,
};

const noted = (): string[] => (globalThis as { __noted?: string[] }).__noted ?? [];
const placed = (id: string, order: string): CloudEvent =>
  cloudEvent("com.acme.order.placed", "/shop", { order }, { id, subject: order });

let root: string | undefined;
let app: App | undefined;
let server: DevServer | undefined;

afterEach(async () => {
  await server?.close();
  await app?.close();
  if (root) await cleanup(root);
  root = app = server = undefined;
});

async function start(replies: Reply[] = [], options: Parameters<typeof App.load>[0] = {}): Promise<App> {
  (globalThis as { __noted?: string[]; __echoed?: number }).__noted = [];
  (globalThis as { __echoed?: number }).__echoed = 0;
  root = await makeProject(FILES);
  app = await App.load({ root, env: MODEL_ENV, fetch: stubModel(replies).fetch, ...options });
  return app;
}

describe("publishing an event on the app's bus", () => {
  it("starts a run of every workflow that subscribed to its type, and of no other", async () => {
    const running = await start();

    const runs = await running.publish(placed("evt-1", "A-17"));

    expect(runs.map((run) => [run.workflow, run.status]).sort()).toEqual([
      ["fulfil", "done"],
      ["ledger", "done"],
    ]);
    expect(noted().sort()).toEqual(["book com.acme.order.placed A-17", "pack A-17"]);
  });

  it("does its work once when the same event is published twice", async () => {
    const running = await start();

    const first = await running.publish(placed("evt-1", "A-17"));
    const again = await running.publish(placed("evt-1", "A-17"));

    expect(again.map((run) => run.id).sort()).toEqual(first.map((run) => run.id).sort());
    expect(noted()).toHaveLength(2);
    expect(await running.runs.list()).toHaveLength(2);
  });

  it("goes nowhere when nobody subscribed and nothing is waiting", async () => {
    const running = await start();
    expect(await running.publish(cloudEvent("com.acme.nobody.cares", "/shop", {}))).toEqual([]);
    expect(await running.runs.list()).toEqual([]);
  });

  it("continues a run that is waiting for it, without that workflow having subscribed", async () => {
    const running = await start();
    const waiting = await running.startWorkflow("courier", { order: "A-17" });
    expect(waiting.status).toBe("waiting");

    const runs = await running.publish(cloudEvent("com.acme.order.packed", "/warehouse", {}, { id: "p-1", subject: "A-17" }));

    expect(runs.map((run) => [run.id, run.status])).toEqual([[waiting.id, "done"]]);
    expect(noted()).toEqual(["hand over A-17"]);
  });

  it("is what a function called by a workflow step is handed, and a retried step publishes the same event", async () => {
    const running = await start();

    const run = await running.startWorkflow("checkout", { order: "A-17" });

    expect(run.status).toBe("done");
    expect(run.outputs.tell).toEqual({ told: ["fulfil", "ledger"] });
    expect(noted().sort()).toEqual(["book com.acme.order.placed A-17", "pack A-17"]);
    const fulfilled = (await running.runs.list()).find((each) => each.workflow === "fulfil");
    expect(fulfilled?.input).toMatchObject({
      type: "com.acme.order.placed",
      subject: "A-17",
      event: { order: "A-17" },
      source: { name: "/apps/acme" },
    });

    // The same call again under the step's idempotency key, as a retry after a crash
    // makes it: the event has the id it had, so the runs it started are found.
    const key = "idem-of-the-step";
    await running.callTool("announce", { order: "B-02" }, { idempotencyKey: key });
    await running.callTool("announce", { order: "B-02" }, { idempotencyKey: key });
    expect(noted().filter((line) => line === "pack B-02")).toHaveLength(1);
  });

  it("is what a function called by an agent is handed too", async () => {
    const running = await start([{ text: "", tool: { name: "announce", args: { order: "C-33" } } }, { text: "Ordered." }]);

    const answer = await running.ask("clerk", "Order C-33 please.");

    expect(answer.text).toBe("Ordered.");
    expect(noted().sort()).toEqual(["book com.acme.order.placed C-33", "pack C-33"]);
  });

  it("refuses a workflow that publishes what it subscribes to, sixteen events deep", async () => {
    const running = await start();

    const [first] = await running.publish(cloudEvent("com.acme.ping", "/outside", {}));

    // The first fifteen each published and were told what came of it; the sixteenth
    // was refused, and its run failed with the reason.
    expect((globalThis as { __echoed?: number }).__echoed).toBe(16);
    const runs = await running.runs.list();
    expect(runs).toHaveLength(16);
    const failed = runs.filter((run) => run.status === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.error).toContain("which is a loop and not a chain");
    expect(first?.status).toBe("done");
  });

  it("is reached over HTTP at /api/events, with no workflow named", async () => {
    (globalThis as { __noted?: string[] }).__noted = [];
    root = await makeProject(FILES);
    server = await serve({ root, port: 0, watch: false, env: MODEL_ENV, fetch: stubModel([]).fetch, token: TEST_TOKEN });
    const at = `http://127.0.0.1:${server.port}`;
    const post = (event: CloudEvent, headers = authed({ "content-type": CLOUDEVENTS_JSON })) =>
      fetch(`${at}/api/events`, { method: "POST", headers, body: JSON.stringify(event) });

    const res = await post(placed("evt-1", "A-17"));
    expect(res.status).toBe(202);
    const { runs } = (await res.json()) as { runs: { id: string; status: string }[] };
    expect(runs.map((run) => run.status)).toEqual(["done", "done"]);
    expect(noted().sort()).toEqual(["book com.acme.order.placed A-17", "pack A-17"]);

    const nobody = await post(cloudEvent("com.acme.nobody.cares", "/shop", {}));
    expect(nobody.status).toBe(202);
    expect(await nobody.json()).toEqual({ runs: [] });

    expect((await post(placed("evt-2", "B-02"), { "content-type": CLOUDEVENTS_JSON })).status).toBe(401);
  });
});
