/**
 * A conversation over one connection.
 *
 * Two protocols ship, each read into one vocabulary of events; over either, an agent's
 * tools are served through the same guard as in a request, and what the session cost is
 * counted as a request's is. Nothing here opens a real socket: the constructor is the
 * seam, and a scripted one stands in.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { agent, fn, guard } from "../src/define.js";
import type { Attachment, ToolSchema } from "../src/harness/types.js";
import { knownSessions, liveSession, realtimeSession, registerSession, sessionFor } from "../src/harness/wire/index.js";
import { liveUrl } from "../src/harness/wire/live.js";
import { realtimeUrl } from "../src/harness/wire/realtime.js";
import type { Session, SessionEvent, SessionRequest, SocketConstructor, WireSession } from "../src/harness/wire/session.js";
import { createApp } from "../src/sdk.js";

type Message = Record<string, unknown>;

/** A socket that records what is sent down it and delivers what a script says. */
class FakeSocket {
  static made: FakeSocket[] = [];
  /** What the far end does when it is sent something. */
  static server: (socket: FakeSocket, message: Message) => void = () => undefined;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly sent: Message[] = [];
  closed = false;
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor(url: string, options?: { headers?: Record<string, string> }) {
    this.url = url;
    this.headers = options?.headers ?? {};
    FakeSocket.made.push(this);
    queueMicrotask(() => this.emit("open", {}));
  }

  addEventListener(type: string, listener: (event: never) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener as (event: unknown) => void]);
  }

  send(data: string): void {
    const message = JSON.parse(data) as Message;
    this.sent.push(message);
    FakeSocket.server(this, message);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.emit("close", { code: 1000 }));
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  /** Deliver a message from the far end, as text or as the binary frame one vendor sends. */
  deliver(message: Message, binary = false): void {
    const text = JSON.stringify(message);
    this.emit("message", { data: binary ? new TextEncoder().encode(text).buffer : text });
  }
}
const Fake = FakeSocket as unknown as SocketConstructor;

/** Let everything already delivered be read. */
const settle = (): Promise<void> => new Promise((resume) => setTimeout(resume, 5));

/** Read events as they come into a list a test can look at. */
function reading(session: AsyncIterable<SessionEvent>): SessionEvent[] {
  const seen: SessionEvent[] = [];
  void (async () => {
    for await (const event of session) seen.push(event);
  })();
  return seen;
}

const lookup: ToolSchema = { name: "lookup", description: "Look an order up.", parameters: { type: "object", properties: { order: { type: "string" } }, required: ["order"] } };

beforeEach(() => {
  FakeSocket.made = [];
  FakeSocket.server = () => undefined;
});

describe("the realtime protocol", () => {
  const request = (over: Partial<SessionRequest> = {}): SessionRequest => ({
    model: "talker",
    baseUrl: "https://voice.test/v1",
    apiKey: "secret",
    system: "Be brief.",
    tools: [lookup],
    voice: "ember",
    WebSocket: Fake,
    ...over,
  });
  const ready = (socket: FakeSocket, message: Message): void => {
    if (message.type === "session.update") queueMicrotask(() => socket.deliver({ type: "session.updated", session: {} }));
  };

  it("finds its address from the endpoint's, and says what the session is before anything else", async () => {
    expect(realtimeUrl({ baseUrl: "https://voice.test/v1", model: "talker" })).toBe("wss://voice.test/v1/realtime?model=talker");
    expect(realtimeUrl({ baseUrl: "http://localhost:8080", model: "talker" })).toBe("ws://localhost:8080/v1/realtime?model=talker");
    expect(realtimeUrl({ baseUrl: "https://voice.test/v1", url: "wss://edge.test/rt", model: "talker" })).toBe("wss://edge.test/rt");

    FakeSocket.server = ready;
    const session = await realtimeSession(request({ headers: { "x-tenant": "t1" }, body: { audio: { input: { turn_detection: null } } } }));
    const socket = FakeSocket.made[0]!;
    expect(socket.url).toBe("wss://voice.test/v1/realtime?model=talker");
    expect(socket.headers).toEqual({ authorization: "Bearer secret", "x-tenant": "t1" });
    expect(socket.sent[0]).toEqual({
      type: "session.update",
      session: {
        type: "realtime",
        instructions: "Be brief.",
        output_modalities: ["audio"],
        audio: { input: { turn_detection: null }, output: { voice: "ember" } },
        tools: [{ type: "function", name: "lookup", description: "Look an order up.", parameters: lookup.parameters }],
        tool_choice: "auto",
      },
    });
    expect(session.audio).toEqual({ input: "audio/pcm;rate=24000", output: "audio/pcm;rate=24000" });
    await session.close();
  });

  it("sends what is typed, heard and shown, and reads a turn into text, speech, a transcript and its cost", async () => {
    FakeSocket.server = ready;
    const session = await realtimeSession(request());
    const socket = FakeSocket.made[0]!;
    const seen = reading(session);

    const picture: Attachment = { mime: "image/png", data: "aGk=" };
    session.send({ text: "What is this?", attachments: [picture] });
    session.send({ audio: "AAAA" });
    session.send({ audio: "BBBB", done: true });
    expect(socket.sent.slice(1)).toEqual([
      { type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,aGk=" }, { type: "input_text", text: "What is this?" }] } },
      { type: "response.create" },
      { type: "input_audio_buffer.append", audio: "AAAA" },
      { type: "input_audio_buffer.append", audio: "BBBB" },
      { type: "input_audio_buffer.commit" },
      { type: "response.create" },
    ]);

    socket.deliver({ type: "input_audio_buffer.speech_started" });
    socket.deliver({ type: "response.created", response: {} });
    socket.deliver({ type: "response.output_text.delta", delta: "A valve." });
    socket.deliver({ type: "response.output_audio.delta", item_id: "item_1", delta: "UENN" });
    socket.deliver({ type: "response.output_audio_transcript.delta", delta: "A valve." });
    socket.deliver({ type: "conversation.item.input_audio_transcription.completed", transcript: "what is this" });
    socket.deliver({
      type: "response.done",
      response: { status: "completed", output: [], usage: { input_tokens: 120, output_tokens: 30, input_token_details: { cached_tokens: 100 } } },
    });
    await settle();
    expect(seen).toEqual([
      { kind: "speech", state: "started" },
      { kind: "turn", state: "started" },
      { kind: "text", text: "A valve." },
      { kind: "audio", data: "UENN", mime: "audio/pcm;rate=24000" },
      { kind: "transcript", of: "output", text: "A valve." },
      { kind: "transcript", of: "input", text: "what is this" },
      { kind: "usage", usage: { inputTokens: 120, outputTokens: 30, cachedTokens: 100 } },
      { kind: "turn", state: "ended", stop: "end" },
    ]);

    await session.close();
    await settle();
    expect(seen.at(-1)).toEqual({ kind: "closed" });
    expect(socket.closed).toBe(true);
  });

  it("reports a tool the model wants, and lets it go on once every call of the turn is answered", async () => {
    FakeSocket.server = ready;
    const session = await realtimeSession(request());
    const socket = FakeSocket.made[0]!;
    const seen = reading(session);

    socket.deliver({ type: "response.created", response: {} });
    socket.deliver({ type: "response.function_call_arguments.done", call_id: "c1", name: "lookup", arguments: '{"order":"A"}' });
    await settle();
    expect(seen[1]).toEqual({ kind: "tool", call: { id: "c1", name: "lookup", args: { order: "A" } } });

    // Answered before the turn is over: the result goes at once, the nudge waits for the end.
    session.answer({ id: "c1", name: "lookup", args: {} }, "shipped");
    expect(socket.sent.at(-1)).toEqual({ type: "conversation.item.create", item: { type: "function_call_output", call_id: "c1", output: "shipped" } });
    socket.deliver({
      type: "response.done",
      response: {
        status: "completed",
        // The same call again as an item of the response, and one that had no event of its own.
        output: [{ type: "function_call", call_id: "c1", name: "lookup", arguments: '{"order":"A"}' }, { type: "function_call", call_id: "c2", name: "lookup", arguments: '{"order":"B"}' }],
      },
    });
    await settle();
    expect(seen.filter((event) => event.kind === "tool")).toHaveLength(2);
    expect(seen.at(-1)).toEqual({ kind: "turn", state: "ended", stop: "tools" });
    expect(socket.sent.at(-1)!.type).toBe("conversation.item.create");

    session.answer({ id: "c2", name: "lookup", args: {} }, "delayed");
    expect(socket.sent.slice(-2)).toEqual([
      { type: "conversation.item.create", item: { type: "function_call_output", call_id: "c2", output: "delayed" } },
      { type: "response.create" },
    ]);
    // A result nobody is owed is not sent.
    session.answer({ id: "c2", name: "lookup", args: {} }, "again");
    expect(socket.sent.at(-1)).toEqual({ type: "response.create" });
    await session.close();
  });

  it("stops the model, has it forget what was not heard, and reports the turn as interrupted", async () => {
    FakeSocket.server = ready;
    const session = await realtimeSession(request({ output: "text", voice: undefined }));
    const socket = FakeSocket.made[0]!;
    expect((socket.sent[0]!.session as Message).output_modalities).toEqual(["text"]);
    const seen = reading(session);

    session.interrupt();
    expect(socket.sent).toHaveLength(1);

    socket.deliver({ type: "response.created", response: {} });
    socket.deliver({ type: "response.output_audio.delta", item_id: "item_9", delta: "UENN" });
    await settle();
    session.interrupt(1500.7);
    expect(socket.sent.slice(-2)).toEqual([
      { type: "response.cancel" },
      { type: "conversation.item.truncate", item_id: "item_9", content_index: 0, audio_end_ms: 1500 },
    ]);
    socket.deliver({ type: "response.done", response: { status: "cancelled", status_details: { reason: "client_cancelled" } } });
    socket.deliver({ type: "response.created", response: {} });
    socket.deliver({ type: "response.done", response: { status: "incomplete", status_details: { reason: "max_output_tokens" } } });
    await settle();
    expect(seen.filter((event) => event.kind === "turn")).toEqual([
      { kind: "turn", state: "started" },
      { kind: "turn", state: "interrupted" },
      { kind: "turn", state: "started" },
      { kind: "turn", state: "ended", stop: "length" },
    ]);
    await session.close();
  });

  it("does not open when the endpoint refuses the session, or hangs up, and leaves no socket behind", async () => {
    FakeSocket.server = (socket, message) => {
      if (message.type === "session.update") queueMicrotask(() => socket.deliver({ type: "error", error: { message: "no such model" } }));
    };
    await expect(realtimeSession(request())).rejects.toThrow("no such model");
    expect(FakeSocket.made[0]!.closed).toBe(true);

    FakeSocket.server = (socket) => queueMicrotask(() => socket.emit("close", { code: 1008, reason: "policy" }));
    await expect(realtimeSession(request())).rejects.toThrow("policy");

    const gone = new AbortController();
    gone.abort();
    await expect(realtimeSession(request({ signal: gone.signal }))).rejects.toThrow("before it was ready");
  });
});

describe("the live protocol", () => {
  const request = (over: Partial<SessionRequest> = {}): SessionRequest => ({
    model: "listener",
    baseUrl: "https://media.test",
    apiKey: "secret",
    system: "Be brief.",
    tools: [lookup, { name: "ping", description: "Ping.", parameters: { type: "object", properties: {} } }],
    voice: "Kore",
    WebSocket: Fake,
    ...over,
  });
  const ready = (socket: FakeSocket, message: Message): void => {
    if (message.setup) queueMicrotask(() => socket.deliver({ setupComplete: {} }, true));
  };

  it("finds its address from the endpoint's, and sets the session up before anything else", async () => {
    expect(liveUrl({ baseUrl: "https://media.test", apiKey: "k" })).toBe("wss://media.test/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=k");
    expect(liveUrl({ baseUrl: "https://media.test/v1alpha", apiKey: "k" })).toContain("generativelanguage.v1alpha.GenerativeService");
    expect(liveUrl({ baseUrl: "https://media.test", apiKey: "k", credentialHeader: "x-goog-api-key" })).not.toContain("key=");

    FakeSocket.server = ready;
    const session = await liveSession(request({ body: { generationConfig: { temperature: 0.2 }, realtimeInputConfig: { automaticActivityDetection: { disabled: true } } } }));
    const socket = FakeSocket.made[0]!;
    expect(socket.url).toBe("wss://media.test/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=secret");
    expect(socket.sent[0]).toEqual({
      setup: {
        realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
        model: "models/listener",
        generationConfig: { temperature: 0.2, responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } } },
        systemInstruction: { parts: [{ text: "Be brief." }] },
        tools: [{ functionDeclarations: [{ name: "lookup", description: "Look an order up.", parameters: lookup.parameters }, { name: "ping", description: "Ping." }] }],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
    });
    expect(session.audio).toEqual({ input: "audio/pcm;rate=16000", output: "audio/pcm;rate=24000" });
    await session.close();
  });

  it("sends what is typed, heard and shown, and reads frames that arrive as bytes", async () => {
    FakeSocket.server = ready;
    const session = await liveSession(request());
    const socket = FakeSocket.made[0]!;
    const seen = reading(session);

    session.send({ attachments: [{ mime: "image/jpeg", data: "anBn" }, { mime: "image/png", url: "https://x.test/a.png", name: "a.png" }] });
    session.send({ audio: "AAAA" });
    session.send({ done: true });
    session.send({ text: "And now?" });
    expect(socket.sent.slice(1)).toEqual([
      { realtimeInput: { video: { data: "anBn", mimeType: "image/jpeg" } } },
      { realtimeInput: { audio: { data: "AAAA", mimeType: "audio/pcm;rate=16000" } } },
      { realtimeInput: { audioStreamEnd: true } },
      { realtimeInput: { text: "And now?" } },
    ]);

    socket.deliver({ serverContent: { inputTranscription: { text: "and now" } } }, true);
    socket.deliver({ serverContent: { modelTurn: { parts: [{ text: "thinking about it", thought: true }, { inlineData: { mimeType: "audio/pcm;rate=24000", data: "UENN" } }] } } }, true);
    socket.deliver({ serverContent: { modelTurn: { parts: [{ text: "Closed." }] }, outputTranscription: { text: "Closed." } } });
    socket.deliver({ usageMetadata: { promptTokenCount: 50, responseTokenCount: 10, thoughtsTokenCount: 4, cachedContentTokenCount: 20 } }, true);
    socket.deliver({ serverContent: { turnComplete: true } }, true);
    await settle();
    expect(seen).toEqual([
      { kind: "note", text: "a.png was not sent: this session takes a picture as its bytes, and nothing else." },
      { kind: "transcript", of: "input", text: "and now" },
      { kind: "turn", state: "started" },
      { kind: "audio", data: "UENN", mime: "audio/pcm;rate=24000" },
      { kind: "text", text: "Closed." },
      { kind: "transcript", of: "output", text: "Closed." },
      { kind: "usage", usage: { inputTokens: 50, outputTokens: 14, cachedTokens: 20, reasoningTokens: 4 } },
      { kind: "turn", state: "ended", stop: "end" },
    ]);
    await session.close();
  });

  it("answers the calls the model makes by id, drops one it withdrew, and interrupts with the message that does", async () => {
    FakeSocket.server = ready;
    const session = await liveSession(request({ output: "text", voice: undefined }));
    const socket = FakeSocket.made[0]!;
    expect((socket.sent[0]!.setup as Message).generationConfig).toEqual({ responseModalities: ["TEXT"] });
    expect((socket.sent[0]!.setup as Message).inputAudioTranscription).toBeUndefined();
    const seen = reading(session);

    socket.deliver({ toolCall: { functionCalls: [{ id: "f1", name: "lookup", args: { order: "A" } }, { id: "f2", name: "ping" }] } });
    socket.deliver({ toolCallCancellation: { ids: ["f2"] } });
    await settle();
    expect(seen.slice(0, 2)).toEqual([
      { kind: "tool", call: { id: "f1", name: "lookup", args: { order: "A" } } },
      { kind: "tool", call: { id: "f2", name: "ping", args: {} } },
    ]);
    expect(seen[2]).toMatchObject({ kind: "note" });

    session.answer({ id: "f2", name: "ping", args: {} }, "pong");
    session.answer({ id: "f1", name: "lookup", args: {} }, "shipped");
    expect(socket.sent.slice(1)).toEqual([{ toolResponse: { functionResponses: [{ id: "f1", name: "lookup", response: { result: "shipped" } }] } }]);

    session.interrupt();
    expect(socket.sent).toHaveLength(2);
    socket.deliver({ serverContent: { modelTurn: { parts: [{ text: "It has" }] } } });
    await settle();
    session.interrupt();
    expect(socket.sent.at(-1)).toEqual({ clientContent: { turns: [], turnComplete: false } });
    socket.deliver({ serverContent: { interrupted: true } });
    socket.deliver({ goAway: { timeLeft: "10s" } });
    await settle();
    expect(seen.slice(-2)).toEqual([
      { kind: "turn", state: "interrupted" },
      { kind: "note", text: "the endpoint is about to close this session (in 10s)" },
    ]);
    await session.close();
  });
});

describe("the seam", () => {
  it("opens sessions for the shapes whose vendors publish a protocol, and takes one of the app's own", async () => {
    expect(knownSessions()).toEqual(expect.arrayContaining(["responses", "chat", "contents", "interactions"]));
    expect(knownSessions()).not.toContain("messages");
    expect(() => sessionFor("messages")).toThrow('no session protocol called "messages"');
    expect(() => registerSession("contents", liveSession)).toThrow("ships");

    const opener = async (): Promise<WireSession> => ({
      audio: { input: "audio/opus", output: "audio/opus" },
      send: () => undefined,
      answer: () => undefined,
      interrupt: () => undefined,
      close: async () => undefined,
      [Symbol.asyncIterator]: async function* () {
        yield { kind: "text", text: "hello" } as SessionEvent;
      },
    });
    registerSession("house-voice", opener);
    expect(sessionFor("house-voice")).toBe(opener);
  });
});

describe("through an agent", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "praecise-session-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  const config = {
    models: {
      voice: { url: "https://voice.test/v1", credential: "VOICE_KEY", speaks: "responses", fast: "writer", realtime: { model: "talker", voice: "ember" } },
    },
  };
  const ready = (socket: FakeSocket, message: Message): void => {
    if (message.type === "session.update") queueMicrotask(() => socket.deliver({ type: "session.updated", session: {} }));
  };

  it("serves the agent's tools through the guard mid-conversation, and counts what the session cost", async () => {
    FakeSocket.server = ready;
    const looked: string[] = [];
    const lookupFn = fn({ description: "Look an order up.", input: { order: "the order id" }, effect: "read", run: ({ order }) => (looked.push(String(order)), `order ${String(order)} shipped`) });
    const app = await createApp(
      {
        root,
        config,
        agents: { desk: agent({ role: "Answer the phone.", quality: "fast", tools: ["lookup"] }) },
        functions: { lookup: lookupFn },
        guard: guard((attempt) => (attempt.args.order === "B" ? "Order B is under review and may not be looked up." : undefined)),
      },
      { env: { VOICE_KEY: "k" }, WebSocket: Fake },
    );
    const session: Session = await app.open("desk");
    const socket = FakeSocket.made[0]!;
    const seen = reading(session);

    // The session is the agent: its instructions, its tools, the endpoint's own voice and session model.
    expect(socket.url).toBe("wss://voice.test/v1/realtime?model=talker");
    const said = socket.sent[0]!.session as { instructions: string; tools: { name: string }[]; audio: unknown };
    expect(said.instructions).toContain("Answer the phone.");
    expect(said.tools.map((tool) => tool.name)).toContain("lookup");
    expect(said.audio).toEqual({ output: { voice: "ember" } });

    socket.deliver({ type: "response.created", response: {} });
    socket.deliver({ type: "response.function_call_arguments.done", call_id: "c1", name: "lookup", arguments: '{"order":"A"}' });
    socket.deliver({ type: "response.function_call_arguments.done", call_id: "c2", name: "lookup", arguments: '{"order":"B"}' });
    socket.deliver({ type: "response.done", response: { status: "completed", output: [{ type: "function_call", call_id: "c1" }], usage: { input_tokens: 200, output_tokens: 20, input_token_details: { cached_tokens: 150 } } } });
    await settle();
    await settle();

    expect(looked).toEqual(["A"]);
    const outputs = socket.sent.filter((message) => (message.item as Message | undefined)?.type === "function_call_output").map((message) => message.item as { call_id: string; output: string });
    expect(outputs).toEqual(expect.arrayContaining([
      { type: "function_call_output", call_id: "c1", output: "order A shipped" },
      { type: "function_call_output", call_id: "c2", output: "Order B is under review and may not be looked up." },
    ]));
    // One nudge to go on, after both results.
    expect(socket.sent.at(-1)).toEqual({ type: "response.create" });
    expect(socket.sent.filter((message) => message.type === "response.create")).toHaveLength(1);

    expect(seen).toEqual(expect.arrayContaining([
      { kind: "tool", call: { id: "c1", name: "lookup", args: { order: "A" } } },
      { kind: "tool result", name: "lookup", failed: false },
      { kind: "refused", name: "lookup", why: "Order B is under review and may not be looked up." },
      { kind: "turn", state: "ended", stop: "tools" },
    ]));
    expect(session.usage).toMatchObject({ inputTokens: 200, outputTokens: 20, cachedTokens: 150 });

    // A table is read for the model; a picture is shown to it; a recording is named as left out.
    const csv: Attachment = { mime: "text/csv", data: Buffer.from("a,b\n1,2\n").toString("base64"), name: "t.csv" };
    session.send({ text: "And this?", attachments: [csv, { mime: "image/png", data: "aGk=" }, { mime: "audio/wav", data: "UklG" }] });
    session.send({ audio: "AAAA" });
    await settle();
    const item = socket.sent.find((message) => JSON.stringify(message).includes("And this?"))!.item as { content: { type: string; text?: string }[] };
    expect(item.content.map((part) => part.type)).toEqual(["input_image", "input_text"]);
    expect(item.content[1]!.text).toContain("shown as a table");
    // Said second, sent second, though the first had to be prepared.
    expect(socket.sent.at(-1)).toEqual({ type: "input_audio_buffer.append", audio: "AAAA" });
    expect(seen.some((event) => event.kind === "note" && event.text.includes("does not take audio"))).toBe(true);

    await session.close();
    await settle();
    expect(seen.at(-1)).toEqual({ kind: "closed" });
    await app.close();
  });

  it("says what to configure when no endpoint names a model for sessions", async () => {
    const plain = { models: { voice: { url: "https://voice.test/v1", credential: "VOICE_KEY", speaks: "responses", fast: "writer" } } };
    const app = await createApp({ root, config: plain, agents: { desk: agent({ role: "Answer.", quality: "fast" }) } }, { env: { VOICE_KEY: "k" }, WebSocket: Fake });
    await expect(app.open("desk")).rejects.toThrow("realtime: { model");
    await expect(app.open("nobody")).rejects.toThrow('no agent named "nobody"');
    await app.close();
  });
});
