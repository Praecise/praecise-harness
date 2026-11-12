/**
 * What a model is shown when what it is sent is not text.
 *
 * One rule for every kind of thing and every wire: the endpoint reads it if it can, a
 * reader renders it if one knows the media type, and otherwise a note says it was left
 * out. The data itself is never rewritten — only what the model sees of it.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { agent, fn } from "../src/define.js";
import { attach, kindOf, present, registerReader, takesOf } from "../src/harness/modality.js";
import type { Attachment, ChatAdapter, ChatRequest, Message } from "../src/harness/types.js";
import { chatWire } from "../src/harness/wire/chat.js";
import { contentsWire } from "../src/harness/wire/contents.js";
import { interactionsWire } from "../src/harness/wire/interactions.js";
import { messagesWire } from "../src/harness/wire/messages.js";
import { responsesWire } from "../src/harness/wire/responses.js";
import { createApp } from "../src/sdk.js";
import { MODEL_ENV } from "./helpers.js";

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
const json = (mime: string, value: unknown, name?: string): Attachment => ({ mime, data: b64(JSON.stringify(value)), ...(name ? { name } : {}) });

const image: Attachment = { mime: "image/png", data: "aGVsbG8=" };
const audio: Attachment = { mime: "audio/wav", data: "UklGRg==" };
const video: Attachment = { mime: "video/mp4", url: "https://example.com/clip.mp4", name: "clip.mp4" };

describe("who reads what", () => {
  it("knows the four kinds an endpoint may read for itself", () => {
    expect(kindOf("image/jpeg")).toBe("image");
    expect(kindOf("audio/ogg")).toBe("audio");
    expect(kindOf("video/webm")).toBe("video");
    expect(kindOf("application/pdf")).toBe("document");
    expect(kindOf("application/senml+json")).toBeUndefined();
  });

  it("each shape takes what it has a place for, unless the provider says otherwise", () => {
    expect([...takesOf("messages")]).toEqual(["image", "document"]);
    expect([...takesOf("chat")]).toEqual(["image"]);
    expect(takesOf("contents").has("video")).toBe(true);
    expect([...takesOf("chat", ["image", "audio", "video"])]).toEqual(["image", "audio", "video"]);
  });

  it("sends what the endpoint takes as it is, and says what it could not send", () => {
    const shown = present([image, audio, video], takesOf("messages"), 1000);
    expect(shown.attachments).toEqual([image]);
    expect(shown.notes).toHaveLength(2);
    expect(shown.notes[0]).toContain("does not take audio");
    expect(shown.notes[1]).toContain('"clip.mp4" (video/mp4)');
    expect(shown.notes[1]).toContain("`takes`");
  });
});

describe("data no model reads is rendered, not dropped", () => {
  it("sensor measurements (SenML) become a series per channel, with what a person would ask of it", () => {
    const readings = [
      { bn: "boiler/", bt: 1_700_000_000, n: "temp", u: "Cel", v: 60 },
      ...Array.from({ length: 49 }, (_, at) => ({ n: "temp", v: 61 + at, t: (at + 1) * 10 })),
      { n: "pressure", u: "bar", v: 2.1, t: 0 },
      { n: "pressure", v: 2.4, t: 250 },
    ];
    const shown = present([json("application/senml+json", readings, "boiler.json")], takesOf("messages"), 2000);
    expect(shown.attachments).toEqual([]);
    expect(shown.notes).toEqual([]);
    expect(shown.text).toContain('[Attached "boiler.json" (application/senml+json), shown as sensor measurements]');
    expect(shown.text).toContain("2 channel(s)");
    expect(shown.text).toContain("boiler/temp (Cel): 50 values, over 490s");
    expect(shown.text).toContain("min 60, max 109");
    expect(shown.text).toContain("24 evenly spaced of them: 60,");
    expect(shown.text).toContain("boiler/pressure (bar): 2 values");
    // The reading is a summary; the samples themselves are not all spelled out.
    expect(shown.text.length).toBeLessThan(JSON.stringify(readings).length);
  });

  it("tensors (Open Inference Protocol) say their name, shape and range: a robot's state, an action chunk", () => {
    const payload = {
      inputs: [
        { name: "observation.state", shape: [7], datatype: "FP32", data: [0.1, -0.4, 0.9, 0, 0.2, 1.5, 0.04] },
        { name: "action", shape: [2, 7], datatype: "FP32", data: [[0, 0, 0.01, 0, 0, 0, 1], [0, 0, 0.02, 0, 0, 0, 1]] },
      ],
    };
    const shown = present([json("application/json", payload)], takesOf("chat"), 2000);
    expect(shown.text).toContain("shown as tensors");
    expect(shown.text).toContain("observation.state: shape [7], FP32; 7 values, min -0.4, max 1.5");
    expect(shown.text).toContain("action: shape [2, 7], FP32; 14 values");
  });

  it("a long table is summarised by column and shown at both ends; a short one is shown whole", () => {
    const rows = Array.from({ length: 500 }, (_, at) => `${at},${(at * 1.5).toFixed(1)},ok`);
    const long = { mime: "text/csv", data: b64(["t,load,state", ...rows].join("\n")), name: "load.csv" };
    const shown = present([long], takesOf("responses"), 3000);
    expect(shown.text).toContain("A table of 500 rows and 3 columns.");
    expect(shown.text).toContain("load: 500 values; min 0, max 748.5");
    expect(shown.text).toContain("state: text");
    expect(shown.text).toContain("Last 8 rows:");

    const small = { mime: "text/csv", data: b64("a,b\n1,2\n3,4") };
    expect(present([small], takesOf("responses"), 3000).text).toContain("a,b\n1,2\n3,4");
  });

  it("a scene is counted, not listed", () => {
    const scene = { asset: { version: "2.0", generator: "test" }, nodes: [{ name: "arm" }, { name: "gripper" }], meshes: [{ name: "link" }] };
    const shown = present([json("model/gltf+json", scene)], takesOf("messages"), 1000);
    expect(shown.text).toContain("A glTF 2.0 scene from test: 0 scene(s), 2 node(s), 1 mesh(es)");
    expect(shown.text).toContain("Nodes: arm, gripper");
  });

  it("plain text and JSON are read as what they are, cut to fit", () => {
    const shown = present([{ mime: "text/plain", data: b64("line\n".repeat(5000)), name: "log.txt" }], takesOf("chat"), 200);
    expect(shown.text).toContain("shown as text");
    expect(shown.text).toContain("omitted from the middle");
  });

  it("bytes nothing reads are left out with a note saying how to change that", () => {
    const shown = present([{ mime: "application/vnd.mcap", data: "AAECAw==", name: "run.mcap" }], takesOf("contents"), 1000);
    expect(shown.text).toBe("");
    expect(shown.notes[0]).toContain('"run.mcap" (application/vnd.mcap) was not shown to the model');
    expect(shown.notes[0]).toContain("registerReader");
  });

  it("an app teaches it a kind of data, and its reader is asked before the ones that ship", () => {
    registerReader("a robot log", "application/vnd.test-robot-log", (attachment) => `A robot log named ${attachment.name}, 3 topics.`);
    const shown = present([{ mime: "application/vnd.test-robot-log", data: "AAECAw==", name: "run7" }], takesOf("chat"), 1000);
    expect(shown.text).toContain("shown as a robot log");
    expect(shown.text).toContain("A robot log named run7, 3 topics.");
  });
});

describe("audio and video go where the shape has a place for them", () => {
  type Body = Record<string, unknown>;
  const send = async (wire: ChatAdapter, payload: unknown, messages: Message[]): Promise<Body> => {
    let body: Body = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body)) as Body;
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await wire({ model: "m", baseUrl: "https://api.example.com", apiKey: "k", system: "", messages, effort: 0, depth: "none", fetch: fetchImpl } as ChatRequest);
    return body;
  };
  const asked: Message[] = [{ role: "user", content: "what happens here?", attachments: [audio, video] }];

  it("chat: input_audio for bytes, video_url for a film", async () => {
    const body = await send(chatWire, { choices: [{ message: { content: "x" } }] }, asked);
    const parts = (body.messages as { content: Body[] }[])[0]!.content;
    expect(parts).toContainEqual({ type: "input_audio", input_audio: { data: "UklGRg==", format: "wav" } });
    expect(parts).toContainEqual({ type: "video_url", video_url: { url: video.url } });
  });

  it("contents and interactions: by media type", async () => {
    const contents = await send(contentsWire, { candidates: [{ content: { parts: [{ text: "x" }] } }] }, asked);
    expect((contents.contents as { parts: Body[] }[])[0]!.parts).toContainEqual({ fileData: { mimeType: "video/mp4", fileUri: video.url } });
    const interactions = await send(interactionsWire, { status: "completed", steps: [] }, asked);
    expect(interactions.input).toContainEqual({ type: "audio", data: "UklGRg==", mime_type: "audio/wav" });
    expect(interactions.input).toContainEqual({ type: "video", uri: video.url, mime_type: "video/mp4" });
  });

  const withResult: Message[] = [
    { role: "user", content: "look" },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "camera", args: {} }] },
    { role: "tool", toolCallId: "c1", name: "camera", content: "The frame.", attachments: [image] },
  ];

  it("a tool result carries what the tool returned, in each shape's own way", async () => {
    const messages = await send(messagesWire, { content: [], stop_reason: "end_turn" }, withResult);
    const result = (messages.messages as { content: Body[] }[])[2]!.content[0]!;
    expect(result.content).toEqual([
      { type: "text", text: "The frame." },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
    ]);

    const responses = await send(responsesWire(), { status: "completed", output: [] }, withResult);
    expect((responses.input as Body[]).at(-1)).toEqual({
      type: "function_call_output",
      call_id: "c1",
      output: [{ type: "input_text", text: "The frame." }, { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" }],
    });

    const contents = await send(contentsWire, { candidates: [{ content: { parts: [{ text: "x" }] } }] }, withResult);
    const parts = (contents.contents as { parts: Body[] }[]).at(-1)!.parts;
    expect(parts[0]).toHaveProperty("functionResponse");
    expect(parts[1]).toEqual({ inlineData: { mimeType: "image/png", data: "aGVsbG8=" } });

    const interactions = await send(interactionsWire, { status: "completed", steps: [] }, withResult);
    expect((interactions.input as Body[]).at(-1)).toMatchObject({
      type: "function_result",
      result: [{ type: "text", text: "The frame." }, { type: "image", data: "aGVsbG8=", mime_type: "image/png" }],
    });
  });

  it("chat: a tool message is text, so the picture follows in a turn of its own after every result", async () => {
    const two: Message[] = [
      { role: "user", content: "look" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "camera", args: {} }, { id: "c2", name: "clock", args: {} }] },
      { role: "tool", toolCallId: "c1", name: "camera", content: "The frame.", attachments: [image] },
      { role: "tool", toolCallId: "c2", name: "clock", content: "Noon." },
    ];
    const body = await send(chatWire, { choices: [{ message: { content: "x" } }] }, two);
    const roles = (body.messages as { role: string }[]).map((message) => message.role);
    expect(roles).toEqual(["user", "assistant", "tool", "tool", "user"]);
    expect((body.messages as { content: Body[] }[]).at(-1)!.content[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,aGVsbG8=" },
    });
  });

  it("what a model makes that is not text comes back with the reply", async () => {
    const reply = async (wire: ChatAdapter, payload: unknown) => {
      const fetchImpl = (async () =>
        new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
      return wire({ model: "m", baseUrl: "https://api.example.com", apiKey: "k", system: "", messages: asked, effort: 0, depth: "none", fetch: fetchImpl } as ChatRequest);
    };
    const drawn = await reply(contentsWire, { candidates: [{ content: { parts: [{ text: "Here." }, { inlineData: { mimeType: "image/png", data: "aGVsbG8=" } }] } }] });
    expect(drawn.attachments).toEqual([{ mime: "image/png", data: "aGVsbG8=" }]);
    const spoken = await reply(chatWire, { choices: [{ message: { content: "Hi.", audio: { data: "UklGRg==", format: "wav" } } }] });
    expect(spoken.attachments).toEqual([{ mime: "audio/wav", data: "UklGRg==" }]);
    const made = await reply(interactionsWire, { status: "completed", steps: [{ type: "model_output", content: [{ type: "image", mime_type: "image/jpeg", data: "aGVsbG8=" }] }] });
    expect(made.attachments).toEqual([{ mime: "image/jpeg", data: "aGVsbG8=" }]);
  });
});

describe("through an agent", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "praecise-modality-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  type Sent = { messages: { role: string; content: Record<string, unknown>[] }[] };
  const scripted = (replies: unknown[]) => {
    const sent: Sent[] = [];
    const queue = [...replies];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)) as Sent);
      return new Response(JSON.stringify(queue.shift() ?? { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return { sent, fetch: fetchImpl };
  };
  const config = { models: { house: { url: "https://models.test", credential: "HOUSE_KEY", speaks: "messages", fast: "small" } } };

  it("a question's sensor log reaches the model as a reading, beside the picture it can look at", async () => {
    const model = scripted([{ content: [{ type: "text", text: "It is overheating." }], stop_reason: "end_turn" }]);
    const app = await createApp({ root, config, agents: { a: agent({ role: "Diagnose.", quality: "fast" }) } }, { env: MODEL_ENV, fetch: model.fetch });
    const readings = [{ n: "temp", u: "Cel", v: 60, t: 0 }, { n: "temp", v: 140, t: 60 }];
    const answer = await app.ask("a", "Is this boiler healthy?", {
      attachments: [image, json("application/senml+json", readings, "boiler.json"), audio],
    });

    const user = model.sent[0]!.messages[0]!;
    expect(user.content[0]).toMatchObject({ type: "image" });
    const text = String(user.content[1]!.text);
    expect(text.startsWith("Is this boiler healthy?")).toBe(true);
    expect(text).toContain("temp (Cel): 2 values, over 60s");
    // The recording could not be sent on this shape, and the developer is told.
    expect(answer.notes?.join(" ")).toContain("does not take audio");
  });

  it("a function returns a picture with its words, and the model is shown both", async () => {
    const model = scripted([
      { content: [{ type: "tool_use", id: "t1", name: "camera", input: {} }], stop_reason: "tool_use" },
      { content: [{ type: "text", text: "A red valve." }], stop_reason: "end_turn" },
    ]);
    const camera = fn({ description: "Take a picture.", effect: "read", run: () => attach("Frame 12 from the front camera.", image) });
    const app = await createApp(
      { root, config, agents: { a: agent({ role: "Look.", quality: "fast", tools: ["camera"] }) }, functions: { camera } },
      { env: MODEL_ENV, fetch: model.fetch },
    );
    const answer = await app.ask("a", "what do you see?");
    expect(answer.text).toBe("A red valve.");
    const result = model.sent[1]!.messages[2]!.content[0]! as { content: Record<string, unknown>[] };
    expect(result.content[0]).toEqual({ type: "text", text: "Frame 12 from the front camera." });
    expect(result.content[1]).toMatchObject({ type: "image" });
  });
});
