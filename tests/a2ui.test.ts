/**
 * A2UI 1.0: the message set, the validator, the tool, and the two ways it travels.
 *
 * There is no renderer here to look at, so what is held is everything short of pixels:
 * that a message the specification's schema would refuse is refused, with a pointer a
 * model can act on; that a surface the agent sends reaches the caller in the encoding
 * its transport defines; that it is not sent to a caller whose renderer offered nothing;
 * and that what a person does on a surface comes back as input to the run.
 */

import { afterEach, describe, expect, it } from "vitest";

import { App } from "../src/app.js";
import { TaskStore, agentCard, handleA2A, streamA2A, type Task } from "../src/server/a2a.js";
import {
  A2UI_EXTENSION_URI,
  A2UI_MEDIA_TYPE,
  SURFACE_TOOL,
  a2uiTurn,
  eventsText,
  rendererCatalogs,
  surfaceTool,
  validateA2ui,
  validateA2uiEvents,
  type A2uiMessage,
} from "../src/server/a2ui.js";
import { AguiStream } from "../src/server/agui.js";
import { serve, type DevServer } from "../src/server/index.js";
import { MODEL_ENV, TEST_MODELS, TEST_TOKEN, authed, cleanup, FRAMEWORK, makeProject, stubModel, type Reply } from "./helpers.js";

const roots: string[] = [];
const servers: DevServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map(cleanup));
});

const CATALOG = "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json";
const CAPABLE = { "1.0": { supportedCatalogIds: [CATALOG] } };

const create: A2uiMessage = { version: "1.0", createSurface: { surfaceId: "form", catalogId: CATALOG } };
const update: A2uiMessage = {
  version: "1.0",
  updateComponents: {
    surfaceId: "form",
    components: [
      { id: "root", component: "Column", children: ["title", "send"] },
      { id: "title", component: "Text", text: "Contact us" },
      { id: "send", component: "Button", child: "label", action: { event: { name: "submit", context: { email: { "@path": "/email" } } } } },
      { id: "label", component: "Text", text: "Send" },
    ],
  },
};
const SURFACE = [create, update];

describe("the validator", () => {
  it("accepts the message set as the specification writes it", () => {
    const messages = [
      create,
      update,
      { version: "1.0", updateDataModel: { surfaceId: "form", path: "/email", value: "a@b.example" } },
      // null is a value here: it deletes what is at the path.
      { version: "1.0", updateDataModel: { surfaceId: "form", path: "/email", value: null } },
      { version: "1.0", callRendererFunction: { surfaceId: "form", functionCallId: "c1", callFunction: { "@call": "getScreenResolution", catalogId: CATALOG, args: {} } } },
      { version: "1.0", agentFunctionResponse: { functionCallId: "c2", value: 42 } },
      { version: "1.0", agentFunctionResponse: { functionCallId: "c3", error: { code: "NOPE", message: "no" } } },
      { version: "1.0", deleteSurface: { surfaceId: "form" } },
    ];
    expect(validateA2ui(messages)).toEqual([]);
  });

  it("says what is wrong, where, in the form a model is shown", () => {
    const faults = validateA2ui([
      { version: "0.9", createSurface: { surfaceId: "a" } },
      { version: "1.0", createSurface: { surfaceId: "b" }, updateComponents: { surfaceId: "b", components: [] } },
      { version: "1.0", createSurface: { catalogId: CATALOG } },
      { version: "1.0", createSurface: { surfaceId: "c", theme: "dark" } },
      { version: "1.0", updateComponents: { surfaceId: "nowhere", components: [{ id: "root", component: "Text" }] } },
      { version: "1.0", updateDataModel: { surfaceId: "nowhere" } },
      { version: "1.0", callRendererFunction: { functionCallId: "c1", callFunction: { "@call": "f" } } },
      { version: "1.0", agentFunctionResponse: { functionCallId: "c1", value: 1, error: { code: "X", message: "y" } } },
      "not a message",
    ]);
    const at = (index: number) => faults.filter((fault) => fault.index === index).map((fault) => `${fault.path} ${fault.message}`);

    expect(at(0).join()).toContain("/version");
    expect(at(1).join()).toContain("exactly one of");
    expect(at(2).join()).toContain("/createSurface/surfaceId");
    expect(at(3).join()).toContain("/createSurface/theme");
    expect(at(4).join()).toContain("no surface called");
    expect(at(5).join()).toContain("/updateDataModel/value");
    // A renderer function call must say which catalog defines the function.
    expect(at(6).join()).toContain("/callRendererFunction/callFunction/catalogId");
    expect(at(7).join()).toContain("exactly one of value and error");
    expect(at(8)).toHaveLength(1);
    for (const fault of faults) expect(fault.code).toBe("VALIDATION_FAILED");
    expect(validateA2ui({ not: "a list" })).toHaveLength(1);
  });

  it("checks components as far as an envelope can: ids, kinds, and never the reserved Surface", () => {
    const withComponents = (components: unknown) => [create, { version: "1.0", updateComponents: { surfaceId: "form", components } }];
    expect(validateA2ui(withComponents([]))).toHaveLength(1);
    expect(validateA2ui(withComponents([{ component: "Text" }]))[0]!.path).toBe("/updateComponents/components/0/id");
    expect(validateA2ui(withComponents([{ id: "root" }]))[0]!.path).toBe("/updateComponents/components/0/component");
    expect(validateA2ui(withComponents([{ id: "root", component: "Surface" }]))[0]!.message).toContain("Surface");
    expect(validateA2ui(withComponents([{ id: "a", component: "Text" }, { id: "a", component: "Text" }]))[0]!.message).toContain("more than one");
    // What a component may hold is the catalog's to say, and is not second-guessed here.
    expect(validateA2ui(withComponents([{ id: "root", component: "Anything", whatever: { nested: true } }]))).toEqual([]);
  });

  it("follows surfaces across calls, so a later update finds what an earlier one created", () => {
    const surfaces = new Set<string>();
    expect(validateA2ui([create], { surfaces })).toEqual([]);
    expect(validateA2ui([update], { surfaces })).toEqual([]);
    // Created twice without deleting it first.
    expect(validateA2ui([create], { surfaces })[0]!.message).toContain("already exists");
    expect(validateA2ui([{ version: "1.0", deleteSurface: { surfaceId: "form" } }, create], { surfaces })).toEqual([]);
    // A catalog the renderer did not offer.
    expect(validateA2ui([{ version: "1.0", createSurface: { surfaceId: "x", catalogId: "another" } }], { catalogs: [CATALOG] })[0]!.path).toBe(
      "/createSurface/catalogId",
    );
  });

  it("checks what a renderer sends back", () => {
    const action = { version: "1.0", action: { name: "submit", surfaceId: "form", sourceComponentId: "send", timestamp: "2026-01-15T12:00:00Z", context: {} } };
    expect(
      validateA2uiEvents([
        action,
        { version: "1.0", callAgentFunction: { surfaceId: "form", functionCallId: "c1", callFunction: { "@call": "lookup" } } },
        { version: "1.0", rendererFunctionResponse: { functionCallId: "c1", value: null } },
        { version: "1.0", error: { code: "VALIDATION_FAILED", surfaceId: "form", path: "/components/0/text", message: "bad" } },
        { version: "1.0", error: { code: "EXECUTION_ERROR", message: "bad", functionCallId: "c1" } },
      ]),
    ).toEqual([]);

    const faults = validateA2uiEvents([
      { version: "1.0", action: { name: "submit", surfaceId: "form" } },
      { version: "1.0", action: action.action, error: { code: "X", message: "y", surfaceId: "form" } },
      { version: "1.0", error: { code: "EXECUTION_ERROR", message: "bad", surfaceId: "form", functionCallId: "c1" } },
    ]);
    expect(faults.filter((fault) => fault.index === 0).length).toBeGreaterThanOrEqual(3);
    expect(faults.some((fault) => fault.index === 1)).toBe(true);
    expect(faults.some((fault) => fault.index === 2)).toBe(true);
  });
});

describe("the surface tool", () => {
  it("sends valid messages on, and hands back what was wrong with the rest for the model to correct", () => {
    const sent: A2uiMessage[][] = [];
    const tool = surfaceTool({ catalogs: [CATALOG], emit: (messages) => void sent.push(messages) });
    expect(tool.name).toBe(SURFACE_TOOL);
    expect(tool.description).toContain(CATALOG);

    expect(String(tool.run({ messages: SURFACE }))).toContain("Shown: 2 messages");
    expect(sent).toEqual([SURFACE]);

    // One good, one bad: the good one goes, and the bad one comes back as the standard error.
    const mixed = String(
      tool.run({
        messages: [
          { version: "1.0", updateDataModel: { surfaceId: "form", value: { email: "" } } },
          { version: "1.0", updateComponents: { surfaceId: "missing", components: [{ id: "root", component: "Text" }] } },
        ],
      }),
    );
    expect(sent).toHaveLength(2);
    expect(sent[1]).toHaveLength(1);
    expect(mixed).toContain("1 of 2 messages were sent");
    const line = JSON.parse(mixed.split("\n").at(-1)!) as { error: { code: string; path: string; surfaceId: string } };
    expect(line.error).toMatchObject({ code: "VALIDATION_FAILED", surfaceId: "missing", path: "/1/updateComponents/surfaceId" });

    expect(String(tool.run({ messages: "nope" }))).toContain("Nothing was shown");
    expect(sent).toHaveLength(2);
  });
});

describe("what comes back from a surface", () => {
  it("reads the catalogs a renderer offers for this version, and none for another", () => {
    expect(rendererCatalogs(CAPABLE)).toEqual([CATALOG]);
    expect(rendererCatalogs({ "0.9": { supportedCatalogIds: [CATALOG] } })).toBeUndefined();
    expect(rendererCatalogs({ "1.0": { supportedCatalogIds: [] } })).toBeUndefined();
    expect(rendererCatalogs(undefined)).toBeUndefined();
  });

  it("turns an action into input the agent can read", () => {
    const text = eventsText(
      [{ version: "1.0", action: { name: "submit", surfaceId: "form", sourceComponentId: "send", timestamp: "2026-01-15T12:00:00Z", userMessage: "Sent the form", context: { email: "a@b.example" } } }],
      { version: "1.0", surfaces: { form: { email: "a@b.example", subscribe: true } } },
    );
    expect(text).toContain('action "submit"');
    expect(text).toContain('"form"');
    expect(text).toContain("Sent the form");
    expect(text).toContain("a@b.example");
    expect(text).toContain('"subscribe":true');
  });

  it("keeps the valid events of a turn and names the rest", () => {
    const turn = a2uiTurn({
      capabilities: CAPABLE,
      events: [
        { version: "1.0", error: { code: "VALIDATION_FAILED", surfaceId: "form", path: "/components/0/text", message: "Expected a string" } },
        { version: "1.0", action: { name: "broken" } },
      ],
    });
    expect(turn.catalogs).toEqual([CATALOG]);
    expect(turn.text).toContain("Expected a string");
    expect(turn.text).not.toContain("broken");
    expect(turn.faults.every((fault) => fault.index === 1)).toBe(true);
  });
});

describe("over AG-UI", () => {
  it("is an activity of its own each time, closing an open message first", () => {
    const stream = new AguiStream("run-1");
    stream.take({ kind: "text", text: "Here is a form." });
    const out = stream.surface(SURFACE);
    expect(out.map((event) => event.type)).toEqual(["TEXT_MESSAGE_END", "ACTIVITY_SNAPSHOT"]);
    expect(out[1]).toMatchObject({ activityType: "a2ui", messageId: "a2ui-1", replace: true, content: { mimeType: A2UI_MEDIA_TYPE, messages: SURFACE } });
    // A later list is applied after the earlier one, so it must not replace it.
    expect(stream.surface([update])[0]!.messageId).toBe("a2ui-2");
    expect(stream.surface([])).toEqual([]);
    // Not for a caller that asked only for tools.
    expect(new AguiStream("run-2", ["tools"]).surface(SURFACE)).toEqual([]);
  });

  async function server(replies: Reply[]) {
    const root = await makeProject({
      ...TEST_MODELS,
      "agents/helper.ts": `import { agent } from "${FRAMEWORK}"; export default agent({ role: "Help." });`,
    });
    roots.push(root);
    const stub = stubModel(replies);
    const made = await serve({ root, port: 0, watch: false, token: TEST_TOKEN, env: MODEL_ENV, fetch: stub.fetch });
    servers.push(made);
    return { at: `http://localhost:${made.port}/api/agents/helper`, stub };
  }
  const showing: Reply[] = [{ text: "", tool: { name: SURFACE_TOOL, args: { messages: SURFACE } } }, { text: "Fill that in." }];

  it("streams a surface after the call that sent it, to a front end that offered a catalog", async () => {
    const { at, stub } = await server(showing);
    const response = await fetch(`${at}?protocol=ag-ui`, {
      method: "POST",
      headers: authed({ "content-type": "application/json", accept: "text/event-stream" }),
      body: JSON.stringify({ input: "ask me for my email", a2uiRendererCapabilities: CAPABLE }),
    });
    const events = (await response.text())
      .split("\n\n")
      .filter(Boolean)
      .map((frame) => JSON.parse(frame.split("\n").find((line) => line.startsWith("data: "))!.slice(6)) as Record<string, any>);
    const types = events.map((event) => event.type);

    const shown = types.indexOf("ACTIVITY_SNAPSHOT");
    expect(shown).toBeGreaterThan(types.indexOf("TOOL_CALL_RESULT"));
    expect(shown).toBeLessThan(types.indexOf("RUN_FINISHED"));
    expect(events[shown]).toMatchObject({ activityType: "a2ui", content: { mimeType: A2UI_MEDIA_TYPE, messages: SURFACE } });
    expect((stub.calls[0]!.body.tools as { name: string }[]).map((tool) => tool.name)).toContain(SURFACE_TOOL);
  });

  it("puts the surface beside the answer where the caller is not streaming", async () => {
    const { at } = await server(showing);
    const response = await fetch(at, {
      method: "POST",
      headers: authed({ "content-type": "application/json" }),
      body: JSON.stringify({ input: "ask me for my email", a2uiRendererCapabilities: CAPABLE }),
    });
    const answer = (await response.json()) as { text: string; a2ui: unknown };
    expect(answer.text).toBe("Fill that in.");
    expect(answer.a2ui).toEqual(SURFACE);
  });

  it("does not give the tool to an agent whose caller offered no catalog", async () => {
    const { at, stub } = await server([{ text: "plain" }]);
    await fetch(at, { method: "POST", headers: authed({ "content-type": "application/json" }), body: JSON.stringify({ input: "hello" }) });
    expect(stub.calls[0]!.body.tools).toBeUndefined();
  });

  it("takes an action on a surface as the input of the next turn", async () => {
    const { at, stub } = await server([{ text: "Thanks." }]);
    const response = await fetch(at, {
      method: "POST",
      headers: authed({ "content-type": "application/json" }),
      body: JSON.stringify({
        a2ui: [{ version: "1.0", action: { name: "submit", surfaceId: "form", sourceComponentId: "send", timestamp: "2026-01-15T12:00:00Z", context: { email: "a@b.example" } } }],
        a2uiRendererCapabilities: CAPABLE,
      }),
    });
    expect(response.status).toBe(200);
    const asked = JSON.stringify(stub.calls[0]!.body.messages);
    expect(asked).toContain("submit");
    expect(asked).toContain("a@b.example");

    // Nothing typed and nothing valid done: there is no turn to take.
    const empty = await fetch(at, {
      method: "POST",
      headers: authed({ "content-type": "application/json" }),
      body: JSON.stringify({ a2ui: [{ version: "1.0", action: { name: "broken" } }] }),
    });
    expect(empty.status).toBe(400);
  });
});

describe("over A2A", () => {
  async function load(replies: Reply[]) {
    const root = await makeProject({
      ...TEST_MODELS,
      "agents/helper.ts": `import { agent } from "${FRAMEWORK}"; export default agent({ role: "Help.", effect: "read" });`,
    });
    roots.push(root);
    const stub = stubModel(replies);
    return { app: await App.load({ root, env: MODEL_ENV, fetch: stub.fetch }), stub };
  }
  const message = (extra: Record<string, unknown> = {}) => ({ messageId: "m-1", role: "ROLE_USER", parts: [{ text: "ask me for my email" }], ...extra });
  const send = (params: Record<string, unknown>, method = "SendMessage") => ({ jsonrpc: "2.0", id: 1, method, params });
  const showing: Reply[] = [{ text: "", tool: { name: SURFACE_TOOL, args: { messages: SURFACE } } }, { text: "Fill that in." }];

  it("declares the extension on the card", async () => {
    const { app } = await load([]);
    const extensions = (agentCard(app).capabilities as { extensions: Record<string, unknown>[] }).extensions;
    expect(extensions).toEqual([expect.objectContaining({ uri: A2UI_EXTENSION_URI, required: false, params: { acceptsInlineCatalogs: false } })]);
  });

  it("answers a renderer that offered a catalog with a data part marked as A2UI", async () => {
    const { app } = await load(showing);
    const reply = (await handleA2A(app, send({ message: message({ metadata: { a2uiRendererCapabilities: CAPABLE } }) }), {}, new TaskStore())) as {
      result: { task: Task };
    };
    const artifacts = reply.result.task.artifacts!;
    const surface = artifacts.find((artifact) => artifact.parts[0]!.data !== undefined)!;
    expect(surface.parts[0]).toEqual({ data: SURFACE, mediaType: A2UI_MEDIA_TYPE, metadata: { mimeType: A2UI_MEDIA_TYPE } });
    // The words still arrive, as the text artifact they always were.
    expect(artifacts.some((artifact) => artifact.parts[0]!.text === "Fill that in.")).toBe(true);
  });

  it("streams it as an artifact update, and in 0.3's spelling for a 0.3 caller", async () => {
    const { app } = await load(showing);
    const frames: Record<string, any>[] = [];
    for await (const frame of streamA2A(app, send({ message: message({ metadata: { a2uiRendererCapabilities: CAPABLE } }) }, "SendStreamingMessage"), {}, new TaskStore())) {
      frames.push((frame as { result: Record<string, any> }).result);
    }
    const drawn = frames.find((frame) => frame.artifactUpdate?.artifact.parts[0].data !== undefined)!;
    expect(drawn.artifactUpdate.artifact.parts[0].metadata.mimeType).toBe(A2UI_MEDIA_TYPE);
    expect(drawn.artifactUpdate.lastChunk).toBe(true);

    const legacy = await load(showing);
    const reply = (await handleA2A(
      legacy.app,
      send({ message: { kind: "message", messageId: "m-1", role: "user", parts: [{ kind: "text", text: "hi" }], metadata: { a2uiRendererCapabilities: CAPABLE } } }, "message/send"),
      {},
      new TaskStore(),
    )) as { result: { artifacts: { parts: Record<string, any>[] }[] } };
    const part = reply.result.artifacts.map((artifact) => artifact.parts[0]!).find((entry) => entry.kind === "data")!;
    expect(part).toEqual({ kind: "data", data: SURFACE, metadata: { mimeType: A2UI_MEDIA_TYPE } });
  });

  it("sends no surface, and offers no tool, for a turn whose renderer offered nothing", async () => {
    const { app, stub } = await load([{ text: "plain" }]);
    const reply = (await handleA2A(app, send({ message: message() }), {}, new TaskStore())) as { result: { task: Task } };
    expect(stub.calls[0]!.body.tools).toBeUndefined();
    expect(reply.result.task.artifacts!.every((artifact) => artifact.parts[0]!.data === undefined)).toBe(true);
  });

  it("reads an action sent as an A2UI data part as what the person did, with the data model beside it", async () => {
    const { app, stub } = await load([{ text: "Thanks." }]);
    await handleA2A(
      app,
      send({
        message: {
          messageId: "m-2",
          role: "ROLE_USER",
          parts: [
            {
              data: [{ version: "1.0", action: { name: "submit", surfaceId: "form", sourceComponentId: "send", timestamp: "2026-01-15T12:00:00Z", context: { email: "a@b.example" } } }],
              metadata: { mimeType: A2UI_MEDIA_TYPE },
            },
          ],
          metadata: { a2uiRendererCapabilities: CAPABLE, a2uiRendererDataModel: { version: "1.0", surfaces: { form: { subscribe: true } } } },
        },
      }),
      {},
      new TaskStore(),
    );
    const asked = JSON.stringify(stub.calls[0]!.body.messages);
    expect(asked).toContain("The person acted on the surface");
    expect(asked).toContain("submit");
    expect(asked).toContain("subscribe");
    // As a sentence, not as the JSON it arrived in.
    expect(asked).not.toContain("sourceComponentId");
  });

  it("keeps a conversation's surfaces, so a later task can update what an earlier one drew", async () => {
    const { app } = await load([
      { text: "", tool: { name: SURFACE_TOOL, args: { messages: [create] } } },
      { text: "Drawn." },
      { text: "", tool: { name: SURFACE_TOOL, args: { messages: [update] } } },
      { text: "Updated." },
    ]);
    const tasks = new TaskStore();
    const capable = { metadata: { a2uiRendererCapabilities: CAPABLE } };
    const first = (await handleA2A(app, send({ message: message(capable) }), {}, tasks)) as { result: { task: Task } };
    const second = (await handleA2A(app, send({ message: message({ ...capable, contextId: first.result.task.contextId }) }), {}, tasks)) as {
      result: { task: Task };
    };
    const drawn = second.result.task.artifacts!.find((artifact) => artifact.parts[0]!.data !== undefined)!;
    expect(drawn.parts[0]!.data).toEqual([update]);
  });
});
