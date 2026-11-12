/**
 * What a run does, told to whoever asked to be told.
 *
 * A run that waits days on an approval outlives every caller that was watching it, so
 * the app reports each change of status itself. Three things have to hold for that to be
 * safe to switch on: each change is reported once, whichever path made it; the report
 * says nothing the run keeps private; and a receiver that is down, slow or broken
 * costs the run nothing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { App, type AppOptions } from "../src/app.js";
import { cloudEvent, CLOUDEVENTS_JSON, type CloudEvent } from "../src/events.js";
import { verifyWebhook } from "../src/webhooks.js";
import { FRAMEWORK, MODEL_ENV, TEST_ENDPOINT, cleanup, makeProject, stubModel } from "./helpers.js";

const FILES = {
  "praecise.config.ts": `import { defineConfig } from "${FRAMEWORK}";
    export default defineConfig({ name: "acme", quality: "fast", ${TEST_ENDPOINT} });`,
  "workflows/greet.ts": `import { workflow } from "${FRAMEWORK}";
    export default workflow({
      description: "Greet someone.",
      input: { who: "who to greet" },
      steps: [{ id: "hello", ask: "Say hello to {{who}}" }],
    });`,
  "workflows/hail.ts": `import { workflow } from "${FRAMEWORK}";
    export default workflow({ description: "Greet whoever it is.", steps: [{ id: "hello", ask: "Say hello" }] });`,
  "workflows/ship.ts": `import { workflow } from "${FRAMEWORK}";
    export default workflow({
      description: "Ship something, once a person says so.",
      input: { what: "what to ship" },
      steps: [{ id: "gate", approve: "Ship {{what}}?" }, { id: "after", ask: "confirm the shipment" }],
    });`,
  "workflows/twice.ts": `import { workflow } from "${FRAMEWORK}";
    export default workflow({
      description: "Two people, one after the other.",
      steps: [{ id: "legal", approve: "Legal?" }, { id: "finance", approve: "Finance?" }],
    });`,
  "workflows/strict.ts": `import { workflow } from "${FRAMEWORK}";
    export default workflow({
      description: "Finishes, but not with what it promised.",
      steps: [{ id: "draft", ask: "write it" }],
      outcome: { equals: "{{draft}}", to: "something nobody wrote" },
    });`,
};

const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const MODEL_SAID = "the model's private words";

let root: string | undefined;
let app: App | undefined;

afterEach(async () => {
  await app?.close();
  if (root) await cleanup(root);
  app = undefined;
  root = undefined;
});

/** An app whose model is a stub, and whose other requests go to `receiver`. */
async function start(options: Partial<AppOptions>, receiver?: typeof fetch): Promise<App> {
  const model = stubModel(Array.from({ length: 10 }, () => ({ text: MODEL_SAID })));
  const both = ((input: RequestInfo | URL, init?: RequestInit) =>
    receiver && String(input).startsWith("https://hooks.test")
      ? receiver(input, init)
      : model.fetch(input, init)) as typeof fetch;
  root = await makeProject(FILES);
  app = await App.load({ root, env: MODEL_ENV, fetch: both, ...options });
  return app;
}

/** A function receiver that keeps what it was told. */
function listener() {
  const events: CloudEvent[] = [];
  return { events, notify: (event: CloudEvent) => void events.push(event) };
}

const kinds = (events: CloudEvent[]) => events.map((event) => event.type.replace("com.praecise.run.", ""));
const until = (check: () => void) => vi.waitFor(check, { timeout: 5000, interval: 10 });

describe("reporting what a run does", () => {
  it("reports a run starting and finishing, once each, as CloudEvents about that run", async () => {
    const heard = listener();
    const running = await start({ notify: heard.notify });
    const run = await running.startWorkflow("greet", { who: "Ada" });
    await until(() => expect(heard.events).toHaveLength(2));

    expect(kinds(heard.events)).toEqual(["started", "done"]);
    for (const event of heard.events) {
      expect(event).toMatchObject({
        specversion: "1.0",
        source: "/apps/acme",
        subject: run.id,
        datacontenttype: "application/json",
      });
      expect(event.id).toBeTruthy();
      expect(Date.parse(event.time!)).not.toBeNaN();
    }
    expect(heard.events[0]!.data).toEqual({ run: run.id, workflow: "greet", status: "running" });
    expect(heard.events[1]!.data).toEqual({ run: run.id, workflow: "greet", status: "done" });
    expect(heard.events[0]!.id).not.toBe(heard.events[1]!.id);
  });

  it("reports a run stopping at a gate with what is being asked, and what it came to once answered", async () => {
    const heard = listener();
    const running = await start({ notify: heard.notify });
    const run = await running.startWorkflow("ship", { what: "the release" });
    await until(() => expect(heard.events).toHaveLength(2));

    expect(kinds(heard.events)).toEqual(["started", "waiting"]);
    expect(heard.events[1]!.data).toEqual({
      run: run.id,
      workflow: "ship",
      status: "waiting",
      step: { id: "gate", prompt: "Ship the release?" },
    });

    await running.resumeWorkflow(run.id, { approved: true, approver: "cfo@acme" });
    await until(() => expect(heard.events).toHaveLength(3));
    // Going back to work after a gate is not the run starting again.
    expect(kinds(heard.events)).toEqual(["started", "waiting", "done"]);
    expect(heard.events[2]!.data).toEqual({ run: run.id, workflow: "ship", status: "done" });
  });

  it("reports a refusal at the gate as the run being done", async () => {
    const heard = listener();
    const running = await start({ notify: heard.notify });
    const run = await running.startWorkflow("ship", { what: "the release" });
    await running.resumeWorkflow(run.id, { approved: false, note: "not today" });
    await until(() => expect(heard.events).toHaveLength(3));

    expect(kinds(heard.events)).toEqual(["started", "waiting", "done"]);
    expect(JSON.stringify(heard.events)).not.toContain("not today");
  });

  it("reports the second gate of a run that goes straight from one to the next", async () => {
    const heard = listener();
    const running = await start({ notify: heard.notify });
    const run = await running.startWorkflow("twice", {});
    await running.resumeWorkflow(run.id, { approved: true });
    await running.resumeWorkflow(run.id, { approved: true });
    await until(() => expect(heard.events).toHaveLength(4));

    expect(kinds(heard.events)).toEqual(["started", "waiting", "waiting", "done"]);
    expect(heard.events.map((event) => (event.data as { step?: { id: string } }).step?.id)).toEqual([
      undefined,
      "legal",
      "finance",
      undefined,
    ]);
  });

  it("reports a failed run, and whether its outcome held, without saying why", async () => {
    const heard = listener();
    const running = await start({ notify: heard.notify });
    const run = await running.startWorkflow("strict", {});
    expect(run.status).toBe("failed");
    await until(() => expect(heard.events).toHaveLength(2));

    expect(kinds(heard.events)).toEqual(["started", "failed"]);
    expect(heard.events[1]!.data).toEqual({
      run: run.id,
      workflow: "strict",
      status: "failed",
      outcome: { held: false },
    });
  });

  it("reports a run an inbound event started once, however often the event is delivered", async () => {
    const heard = listener();
    const running = await start({ notify: heard.notify });
    const inbound = cloudEvent("greeting.asked", "/crm", { who: "Ada" }, { id: "evt-1" });
    const first = await running.deliver("hail", inbound);
    const again = await running.deliver("hail", inbound);
    expect(again.id).toBe(first.id);
    await until(() => expect(heard.events).toHaveLength(2));
    // Long enough for a third report to have arrived, had one been made.
    await new Promise((done) => setTimeout(done, 50));

    expect(kinds(heard.events)).toEqual(["started", "done"]);
    expect(heard.events.every((event) => event.subject === first.id)).toBe(true);
  });

  it("reports a recovered run finishing, not starting a second time", async () => {
    // What a crash leaves behind: a record that says running, and nobody driving it.
    const crashed = await start({});
    const run = await crashed.startWorkflow("greet", { who: "Ada" });
    const record = (await crashed.runs.load(run.id))!;
    record.status = "running";
    await crashed.runs.save(record);
    await crashed.close();

    // The process that comes back for it has never seen the run before.
    const heard = listener();
    const model = stubModel([{ text: MODEL_SAID }]);
    app = await App.load({ root, env: MODEL_ENV, fetch: model.fetch, notify: heard.notify });
    const recovered = await app.recoverWorkflow(run.id);
    expect(recovered.status).toBe("done");
    await until(() => expect(heard.events).toHaveLength(1));
    await new Promise((done) => setTimeout(done, 50));
    expect(kinds(heard.events)).toEqual(["done"]);
  });

  it("carries nothing the run keeps private: no input, no output, no model text, no error", async () => {
    const heard = listener();
    const running = await start({ notify: heard.notify });
    const greeted = await running.startWorkflow("greet", { who: "a-private-name" });
    const failed = await running.startWorkflow("strict", {});
    await until(() => expect(heard.events).toHaveLength(4));

    // The record does hold these, which is what makes their absence here mean something.
    expect(JSON.stringify(greeted)).toContain(MODEL_SAID);
    expect(JSON.stringify(greeted)).toContain("a-private-name");
    expect(failed.error).toContain("something nobody wrote");

    const sent = JSON.stringify(heard.events);
    expect(sent).not.toContain(MODEL_SAID);
    expect(sent).not.toContain("a-private-name");
    expect(sent).not.toContain("something nobody wrote");
    expect(sent).not.toContain("Say hello");
    const allowed = new Set(["run", "workflow", "status", "step", "outcome"]);
    for (const event of heard.events) {
      expect(Object.keys(event.data as object).every((key) => allowed.has(key))).toBe(true);
    }
  });

  it("says nothing at all when nobody asked to be told", async () => {
    const running = await start({});
    const run = await running.startWorkflow("greet", { who: "Ada" });
    expect(run.status).toBe("done");
    expect(running.problems.filter((problem) => problem.startsWith("notify"))).toEqual([]);
  });
});

describe("a receiver that fails", () => {
  it("does not fail the run when the function throws, and says so where an operator looks", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const running = await start({
        notify: () => {
          throw new Error("the receiver fell over");
        },
      });
      const run = await running.startWorkflow("greet", { who: "Ada" });
      expect(run.status).toBe("done");
      expect((await running.runs.load(run.id))?.status).toBe("done");

      await until(() => expect(running.problems.join("\n")).toContain("com.praecise.run.done"));
      const problem = running.problems.find((line) => line.startsWith("notify:"))!;
      expect(problem).toContain(`run ${run.id}`);
      expect(problem).toContain("the receiver fell over");
      expect(problem).toContain("The run itself is unaffected");
    } finally {
      quiet.mockRestore();
    }
  });

  it("does not hold the run up while a slow receiver takes its time", async () => {
    let release!: () => void;
    const held = new Promise<void>((done) => (release = done));
    const heard: string[] = [];
    const running = await start({
      notify: async (event) => {
        await held;
        heard.push(event.type);
      },
    });
    const run = await running.startWorkflow("greet", { who: "Ada" });
    // The run finished with its first report still undelivered.
    expect(run.status).toBe("done");
    expect(heard).toEqual([]);

    release();
    await until(() => expect(heard).toHaveLength(2));
    // And one run's reports arrive in the order they happened.
    expect(heard).toEqual(["com.praecise.run.started", "com.praecise.run.done"]);
  });
});

describe("reporting to a webhook", () => {
  /** A receiver at hooks.test that answers from a script and keeps what it got. */
  const hook = (answers: number[] = []) => {
    const got: { url: string; headers: Record<string, string>; body: string }[] = [];
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      got.push({ url: String(input), headers: init?.headers as Record<string, string>, body: String(init?.body) });
      return new Response(null, { status: answers.shift() ?? 200 });
    }) as typeof fetch;
    return { fetch: impl, got };
  };

  it("posts each event signed, as structured CloudEvents JSON a receiver can verify", async () => {
    const to = hook();
    const running = await start({ notify: { url: "https://hooks.test/runs", secret: SECRET } }, to.fetch);
    const run = await running.startWorkflow("ship", { what: "the release" });
    await until(() => expect(to.got).toHaveLength(2));

    for (const sent of to.got) {
      expect(sent.url).toBe("https://hooks.test/runs");
      expect(sent.headers["content-type"]).toBe(CLOUDEVENTS_JSON);
      expect(verifyWebhook(SECRET, sent.headers, sent.body)).toBe(true);
      expect(verifyWebhook("whsec_b3RoZXItc2VjcmV0LW90aGVyLXNlY3JldA==", sent.headers, sent.body)).toBe(false);
      const event = JSON.parse(sent.body) as CloudEvent;
      expect(sent.headers["webhook-id"]).toBe(event.id);
      expect(event).toMatchObject({ specversion: "1.0", source: "/apps/acme", subject: run.id });
    }
    expect(to.got.map((sent) => (JSON.parse(sent.body) as CloudEvent).type)).toEqual([
      "com.praecise.run.started",
      "com.praecise.run.waiting",
    ]);
  });

  it("tries again when the receiver is briefly down, under the same id, and then gets through", async () => {
    const to = hook([503]);
    const running = await start(
      { notify: { url: "https://hooks.test/runs", secret: SECRET, events: ["done"] } },
      to.fetch,
    );
    const run = await running.startWorkflow("greet", { who: "Ada" });
    expect(run.status).toBe("done");
    await until(() => expect(to.got).toHaveLength(2));

    expect(to.got[0]!.headers["webhook-id"]).toBe(to.got[1]!.headers["webhook-id"]);
    expect(to.got[0]!.body).toBe(to.got[1]!.body);
    await running.close();
    expect(running.problems.filter((problem) => problem.startsWith("notify"))).toEqual([]);
  });

  it("does not fail the run when the receiver refuses, and names the failure without the url's secrets", async () => {
    const to = hook([401, 401]);
    const running = await start(
      { notify: { url: "https://hooks.test/runs?key=in-the-query", secret: SECRET } },
      to.fetch,
    );
    const run = await running.startWorkflow("greet", { who: "Ada" });
    expect(run.status).toBe("done");

    await until(() => expect(running.problems.join("\n")).toContain("com.praecise.run.done"));
    const problem = running.problems.find((line) => line.startsWith("notify:"))!;
    expect(problem).toContain("https://hooks.test/runs");
    expect(problem).toContain("the receiver answered 401, after 1 attempt");
    expect(problem).not.toContain("in-the-query");
    expect(problem).not.toContain(SECRET);
  });

  it("sends only the events that were asked for", async () => {
    const to = hook();
    const running = await start(
      { notify: { url: "https://hooks.test/runs", secret: SECRET, events: ["com.praecise.run.waiting", "failed"] } },
      to.fetch,
    );
    await running.startWorkflow("greet", { who: "Ada" });
    await running.startWorkflow("ship", { what: "the release" });
    await running.startWorkflow("strict", {});
    await until(() => expect(to.got).toHaveLength(2));
    await running.close();

    expect(to.got.map((sent) => (JSON.parse(sent.body) as CloudEvent).type).sort()).toEqual([
      "com.praecise.run.failed",
      "com.praecise.run.waiting",
    ]);
  });

  it("refuses a target it could not sign for or reach, when the app is loaded", async () => {
    await expect(start({ notify: { url: "https://hooks.test/runs", secret: "" } })).rejects.toThrow(
      /notify\.secret is required/,
    );
    await cleanup(root!);
    await expect(start({ notify: { url: "hooks.test/runs", secret: SECRET } })).rejects.toThrow(
      /notify\.url must be an http\(s\) URL/,
    );
    await cleanup(root!);
    await expect(
      start({ notify: { url: "https://hooks.test/runs", secret: SECRET, events: ["finished"] } }),
    ).rejects.toThrow(/"finished", which this app never sends/);
  });
});
