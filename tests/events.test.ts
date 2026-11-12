/**
 * An event from outside starts a run, once.
 *
 * Anything that pushes events retries, so the same event arrives twice sooner or later.
 * What makes that safe is the envelope: a CloudEvent's `source` and `id` are unique
 * together, the run is named from them, and a second delivery finds the first one's run.
 */
import { describe, expect, it } from "vitest";

import { CLOUDEVENTS_BATCH, CLOUDEVENTS_JSON, cloudEvent, readCloudEvents } from "../src/events.js";
import { serve, type DevServer } from "../src/server/index.js";
import { FRAMEWORK, MODEL_ENV, TEST_MODELS, TEST_TOKEN, authed, cleanup, makeProject, stubModel } from "./helpers.js";

const event = { specversion: "1.0", id: "evt-1", source: "/billing", type: "invoice.paid", data: { invoice: 4021 } };

describe("reading a CloudEvent off a request", () => {
  it("takes a structured event", () => {
    expect(readCloudEvents({ "content-type": CLOUDEVENTS_JSON }, event)).toEqual([event]);
  });

  it("takes a batch", () => {
    const second = { ...event, id: "evt-2" };
    expect(readCloudEvents({ "content-type": `${CLOUDEVENTS_BATCH}; charset=utf-8` }, [event, second])).toEqual([
      event,
      second,
    ]);
  });

  it("takes a binary one: attributes in ce- headers, the data as the body", () => {
    const read = readCloudEvents(
      {
        "content-type": "application/json",
        "ce-specversion": "1.0",
        "ce-id": "evt-9",
        "ce-source": "/sensors/line%202",
        "ce-type": "reading.taken",
        "ce-subject": "boiler",
      },
      { celsius: 71 },
    );
    expect(read).toEqual([
      {
        specversion: "1.0",
        id: "evt-9",
        source: "/sensors/line 2",
        type: "reading.taken",
        subject: "boiler",
        datacontenttype: "application/json",
        data: { celsius: 71 },
      },
    ]);
  });

  it("refuses plain JSON that only looks like an event, and says how to send one", () => {
    const refused = readCloudEvents({ "content-type": "application/json" }, event);
    expect(refused).toContain("not a CloudEvent");
    expect(refused).toContain("ce-id");
  });

  it("names what is missing", () => {
    expect(readCloudEvents({ "content-type": CLOUDEVENTS_JSON }, { ...event, id: "" })).toContain("`id` is required");
    expect(readCloudEvents({ "content-type": CLOUDEVENTS_JSON }, { ...event, specversion: "0.3" })).toContain(
      'specversion must be "1.0"',
    );
    expect(readCloudEvents({ "content-type": CLOUDEVENTS_BATCH }, [event, { ...event, type: 7 }])).toContain(
      "event 2: `type` is required",
    );
    expect(readCloudEvents({ "content-type": CLOUDEVENTS_BATCH }, [])).toBe("the batch is empty");
  });

  it("mints an event of its own with an id and a time", () => {
    const minted = cloudEvent("run.done", "/apps/acme", { run: "r1" }, { subject: "r1" });
    expect(minted).toMatchObject({ specversion: "1.0", type: "run.done", source: "/apps/acme", subject: "r1" });
    expect(minted.id).toBeTruthy();
    expect(Date.parse(minted.time!)).not.toBeNaN();
  });
});

const FILES = {
  ...TEST_MODELS,
  "workflows/paid.ts": `import { workflow } from "${FRAMEWORK}";
    export default workflow({
      input: { event: "what happened" },
      steps: [{ id: "note", ask: "An invoice was paid: {{event}}" }],
    });`,
};

async function withServer(body: (at: string, calls: () => number) => Promise<void>): Promise<void> {
  const root = await makeProject(FILES);
  const stub = stubModel(Array.from({ length: 8 }, () => ({ text: "noted" })));
  let server: DevServer | undefined;
  try {
    server = await serve({ root, port: 0, watch: false, env: MODEL_ENV, fetch: stub.fetch, token: TEST_TOKEN });
    await body(`http://127.0.0.1:${server.port}`, () => stub.calls.length);
  } finally {
    await server?.close();
    await cleanup(root);
  }
}

const post = (url: string, type: string, payload: unknown, extra: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: authed({ "content-type": type, ...extra }), body: JSON.stringify(payload) });

describe("delivering an event to a workflow", () => {
  it("starts a run for it, and a second delivery of the same event finds that run", async () => {
    await withServer(async (at, calls) => {
      const first = await post(`${at}/api/events/paid`, CLOUDEVENTS_JSON, event);
      expect(first.status).toBe(202);
      const started = (await first.json()) as { runs: { id: string; status: string }[] };
      expect(started.runs).toHaveLength(1);
      expect(started.runs[0]!.status).toBe("done");
      const asked = calls();

      const again = await post(`${at}/api/events/paid`, CLOUDEVENTS_JSON, event);
      const repeated = (await again.json()) as { runs: { id: string }[] };
      expect(repeated.runs[0]!.id).toBe(started.runs[0]!.id);
      // Nothing was asked a second time: the run already existed.
      expect(calls()).toBe(asked);

      // A different event from the same sender is a different run.
      const other = await post(`${at}/api/events/paid`, CLOUDEVENTS_JSON, { ...event, id: "evt-2" });
      expect(((await other.json()) as { runs: { id: string }[] }).runs[0]!.id).not.toBe(started.runs[0]!.id);
    });
  });

  it("takes the binary form, and refuses what is not an event or names no workflow", async () => {
    await withServer(async (at) => {
      const binary = await post(`${at}/api/events/paid`, "application/json", { invoice: 1 }, {
        "ce-specversion": "1.0",
        "ce-id": "b-1",
        "ce-source": "/billing",
        "ce-type": "invoice.paid",
      });
      expect(binary.status).toBe(202);

      expect((await post(`${at}/api/events/paid`, "application/json", event)).status).toBe(400);
      expect((await post(`${at}/api/events/nope`, CLOUDEVENTS_JSON, event)).status).toBe(404);
      // The token is needed here as everywhere else under /api.
      const anonymous = await fetch(`${at}/api/events/paid`, {
        method: "POST",
        headers: { "content-type": CLOUDEVENTS_JSON },
        body: JSON.stringify(event),
      });
      expect(anonymous.status).toBe(401);
    });
  });
});
