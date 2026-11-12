/**
 * The app's events, described for a machine.
 *
 * The description is generated from what the app declares, so the things to hold
 * still are that it says only what is true of the app, that every reference in it
 * lands, and that it advertises nothing to a caller who could not reach it.
 */
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../src/app.js";
import { CLOUDEVENTS_JSON } from "../src/events.js";
import { ASYNCAPI_PATH, ASYNCAPI_VERSION, asyncApi } from "../src/server/asyncapi.js";
import { serve, type DevServer } from "../src/server/index.js";
import { FRAMEWORK, MODEL_ENV, TEST_ENDPOINT, TEST_TOKEN, authed, cleanup, makeProject, stubModel, type Reply } from "./helpers.js";

const FILES = {
  "praecise.config.ts": `import { defineConfig } from "${FRAMEWORK}";
    export default defineConfig({ name: "acme", version: "2.0.0", quality: "fast", ${TEST_ENDPOINT} });`,
  "functions/note.ts": `import { fn } from "${FRAMEWORK}";
    export default fn({ description: "Write something down.", input: { what: "what to note" }, run: ({ what }) => String(what) });`,
  "workflows/checkout.ts": `import { workflow } from "${FRAMEWORK}";
    export default workflow({
      description: "Take an order.",
      input: { order: "the order id" },
      steps: [{ id: "tell", use: "note", with: { what: "{{order}}" } }],
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
      description: "Internal, and so not described to anyone.",
      access: "internal",
      on: "com.acme.ping",
      steps: [{ id: "again", use: "note", with: { what: "ping" } }],
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

async function start(replies: Reply[] = [], options: Parameters<typeof App.load>[0] = {}): Promise<App> {
  root = await makeProject(FILES);
  app = await App.load({ root, env: MODEL_ENV, fetch: stubModel(replies).fetch, ...options });
  return app;
}

describe("the AsyncAPI description of an app's events", () => {
  type Doc = {
    asyncapi: string;
    info: { title: string; version: string };
    defaultContentType: string;
    servers?: Record<string, { host: string; protocol: string; security: unknown[] }>;
    channels: Record<string, { address: string | null; messages: Record<string, { $ref: string }>; parameters?: Record<string, { enum: string[] }> }>;
    operations: Record<string, { action: string; channel: { $ref: string }; messages: { $ref: string }[] }>;
    components: {
      messages: Record<string, { name: string; summary: string; contentType: string; payload: unknown }>;
      schemas: Record<string, unknown>;
      securitySchemes?: Record<string, unknown>;
    };
  };

  /** Follow a `#/a/b/c` reference inside the document. */
  const follow = (doc: unknown, ref: string): unknown =>
    ref
      .replace(/^#\//, "")
      .split("/")
      .reduce<unknown>((at, key) => (at as Record<string, unknown> | undefined)?.[key], doc);

  it("is version 3.1.0, and names the app, where it listens and how a request is authorised", async () => {
    const doc = asyncApi(await start(), { identified: true }, "https://acme.example") as Doc;

    expect(ASYNCAPI_VERSION).toBe("3.1.0");
    expect(doc.asyncapi).toBe("3.1.0");
    expect(doc.info).toMatchObject({ title: "acme", version: "2.0.0" });
    expect(doc.defaultContentType).toBe(CLOUDEVENTS_JSON);
    expect(doc.servers?.app).toMatchObject({
      host: "acme.example",
      protocol: "https",
      security: [{ $ref: "#/components/securitySchemes/bearer" }],
    });
    expect(doc.components.securitySchemes).toEqual({ bearer: { type: "http", scheme: "bearer" } });
  });

  it("lists the events workflows subscribe to and wait for, and what each does", async () => {
    const doc = asyncApi(await start(), { identified: true }, "https://acme.example") as Doc;

    expect(doc.channels.bus!.address).toBe("/api/events");
    const types = Object.values(doc.channels.bus!.messages).map(
      (message) => (follow(doc, message.$ref) as { name: string }).name,
    );
    expect(types.sort()).toEqual(["com.acme.order.packed", "com.acme.order.placed", "com.acme.order.refunded"]);

    const about = doc.components.messages["com.acme.order.placed"]!;
    expect(about.summary).toContain('starts a run of "fulfil"');
    expect(about.summary).toContain('starts a run of "ledger"');
    expect(doc.components.messages["com.acme.order.packed"]!.summary).toContain(
      'continues a run of "courier" waiting at step "packed"',
    );
    expect(about.contentType).toBe(CLOUDEVENTS_JSON);
    expect(about.payload).toEqual({
      allOf: [
        { $ref: "#/components/schemas/CloudEvent" },
        { type: "object", properties: { type: { const: "com.acme.order.placed" } } },
      ],
    });

    expect(doc.channels.workflow!.address).toBe("/api/events/{workflow}");
    expect(doc.channels.workflow!.parameters!.workflow!.enum).toEqual(["checkout", "courier", "fulfil", "ledger"]);
  });

  it("has operations whose every reference lands on something in the document", async () => {
    const doc = asyncApi(await start(), { identified: true }, "https://acme.example") as Doc;

    expect(Object.keys(doc.operations).sort()).toEqual(["deliverEvent", "publishEvent"]);
    for (const operation of Object.values(doc.operations)) {
      expect(operation.action).toBe("receive");
      expect(follow(doc, operation.channel.$ref)).toBeDefined();
      expect(operation.messages.length).toBeGreaterThan(0);
      for (const message of operation.messages) {
        // An operation's message is a reference into its own channel, which refers on.
        expect(message.$ref.startsWith(`${operation.channel.$ref}/messages/`)).toBe(true);
        const inChannel = follow(doc, message.$ref) as { $ref: string };
        expect(follow(doc, inChannel.$ref)).toBeDefined();
      }
    }
    for (const key of Object.keys(doc.components.messages)) expect(key).toMatch(/^[a-zA-Z0-9.\-_]+$/);
  });

  it("lists nothing a caller could not reach", async () => {
    const running = await start();
    const anonymous = JSON.stringify(asyncApi(running, {}, "https://acme.example"));

    // `courier` is gated and `loop` is internal: neither their names nor their events.
    expect(anonymous).not.toContain("courier");
    expect(anonymous).not.toContain("com.acme.order.packed");
    expect(JSON.stringify(asyncApi(running, { identified: true }))).not.toContain("com.acme.ping");
  });

  it("describes the run events it sends only when it has somewhere to send them", async () => {
    const quiet = asyncApi(await start(), { identified: true }) as Doc;
    expect(quiet.channels.runs).toBeUndefined();
    expect(quiet.operations.reportRun).toBeUndefined();
    expect(quiet.servers).toBeUndefined();
    await app!.close();
    await cleanup(root!);

    const told = asyncApi(await start([], { notify: () => undefined }), { identified: true }) as Doc;
    // Where it reports to is the operator's to know.
    expect(told.channels.runs!.address).toBeNull();
    expect(told.operations.reportRun).toMatchObject({ action: "send", channel: { $ref: "#/channels/runs" } });
    expect(
      Object.values(told.channels.runs!.messages)
        .map((message) => (follow(told, message.$ref) as { name: string }).name)
        .sort(),
    ).toEqual([
      "com.praecise.run.cancelled",
      "com.praecise.run.done",
      "com.praecise.run.failed",
      "com.praecise.run.started",
      "com.praecise.run.waiting",
    ]);
    expect(told.components.schemas.RunNotice).toBeDefined();
  });

  it("is served beside the other discovery documents, and listed by them", async () => {
    root = await makeProject(FILES);
    server = await serve({ root, port: 0, watch: false, env: MODEL_ENV, fetch: stubModel([]).fetch, token: TEST_TOKEN });
    const at = `http://127.0.0.1:${server.port}`;

    const res = await fetch(`${at}${ASYNCAPI_PATH}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const doc = (await res.json()) as Doc;
    expect(doc.asyncapi).toBe("3.1.0");
    expect(doc.servers?.app?.host).toBe(`127.0.0.1:${server.port}`);
    expect(doc.channels.workflow!.parameters!.workflow!.enum).not.toContain("courier");

    const known = (await (await fetch(`${at}${ASYNCAPI_PATH}`, { headers: authed() })).json()) as Doc;
    expect(known.channels.workflow!.parameters!.workflow!.enum).toContain("courier");

    expect(await (await fetch(`${at}/llms.txt`)).text()).toContain(`(${at}${ASYNCAPI_PATH})`);
    const catalog = (await (await fetch(`${at}/.well-known/ai-catalog.json`)).json()) as { entries: { type: string; url: string }[] };
    expect(catalog.entries).toContainEqual(expect.objectContaining({ type: "asyncapi", url: `${at}${ASYNCAPI_PATH}` }));
  });
});
