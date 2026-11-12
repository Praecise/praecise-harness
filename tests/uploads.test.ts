/**
 * An attachment too large to keep sending is uploaded once and named after.
 *
 * One upload per file per endpoint, a name not used past its expiry, and a failure that
 * costs nothing but the upload: the bytes go inside the request as they did before.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { agent, fn } from "../src/define.js";
import type { Attachment, ChatRequest } from "../src/harness/types.js";
import { chatWire } from "../src/harness/wire/chat.js";
import { contentsWire } from "../src/harness/wire/contents.js";
import { Uploads, knownUploaders, registerUploader } from "../src/harness/wire/files.js";
import type { Endpoint } from "../src/harness/wire/http.js";
import { interactionsWire } from "../src/harness/wire/interactions.js";
import { messagesWire } from "../src/harness/wire/messages.js";
import { responsesWire } from "../src/harness/wire/responses.js";
import { createApp } from "../src/sdk.js";

const pdf: Attachment = { mime: "application/pdf", data: Buffer.from("%PDF-1.7 a long report").toString("base64"), name: "report.pdf" };
const picture: Attachment = { mime: "image/png", data: Buffer.from("a large picture").toString("base64"), name: "plan.png" };
const film: Attachment = { mime: "video/mp4", data: Buffer.from("a long film").toString("base64"), name: "tour.mp4" };

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  form?: Record<string, string>;
  file?: { name: string; type: string; text: string };
  body?: string;
}

/** An endpoint that records what it was sent and answers from a function. */
function recorder(answer: (seen: Seen, all: Seen[]) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const impl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const entry: Seen = { url: String(url), method: init?.method ?? "GET", headers: { ...(init?.headers as Record<string, string>) } };
    if (init?.body instanceof FormData) {
      entry.form = {};
      for (const [key, value] of init.body.entries()) {
        if (typeof value === "string") entry.form[key] = value;
        else entry.file = { name: value.name, type: value.type, text: await value.text() };
      }
    } else if (init?.body instanceof Blob) {
      entry.body = await init.body.text();
    } else if (init?.body !== undefined) {
      entry.body = String(init.body);
    }
    seen.push(entry);
    return answer(entry, seen);
  }) as typeof fetch;
  return { fetch: impl, seen };
}

const at = (baseUrl: string, fetchImpl: typeof fetch, over: Partial<Endpoint> = {}): Endpoint => ({ baseUrl, apiKey: "secret", fetch: fetchImpl, ...over });

/** Everything is past the line in these tests: the line is one byte. */
const small = { over: 1 };

describe("the upload cache", () => {
  it("uploads once per file per endpoint on messages, and names it by file id after", async () => {
    const model = recorder((_seen, all) => Response.json({ id: `file_${all.length}`, type: "file", expires_at: null }));
    const uploads = new Uploads();
    const here = at("https://models.test", model.fetch);

    const first = await uploads.refer("messages", here, [pdf, picture], small);
    expect(first.attachments).toEqual([
      { mime: "application/pdf", name: "report.pdf", fileId: "file_1" },
      { mime: "image/png", name: "plan.png", fileId: "file_2" },
    ]);
    expect(first.notes).toEqual([]);
    expect(model.seen[0]).toMatchObject({
      url: "https://models.test/v1/files",
      method: "POST",
      headers: { "x-api-key": "secret", "anthropic-version": "2023-06-01" },
      form: { expires_in_seconds: "604800" },
      file: { name: "report.pdf", type: "application/pdf", text: "%PDF-1.7 a long report" },
    });

    // The same bytes again, under another name: nothing is sent.
    const again = await uploads.refer("messages", here, [{ ...pdf, name: "copy.pdf" }], small);
    expect(again.attachments[0]!.fileId).toBe("file_1");
    expect(model.seen).toHaveLength(2);

    // Another endpoint has never seen it, and neither has another credential on this one.
    await uploads.refer("messages", at("https://other.test", model.fetch), [pdf], small);
    await uploads.refer("messages", at("https://models.test", model.fetch, { apiKey: "another" }), [pdf], small);
    expect(model.seen.map((entry) => entry.url)).toEqual([
      "https://models.test/v1/files",
      "https://models.test/v1/files",
      "https://other.test/v1/files",
      "https://models.test/v1/files",
    ]);
  });

  it("leaves alone what is small, what is already a name or an address, and what the endpoint does not store", async () => {
    const model = recorder(() => Response.json({ id: "file_1" }));
    const uploads = new Uploads();
    const here = at("https://models.test", model.fetch);
    const linked: Attachment = { mime: "application/pdf", url: "https://files.test/a.pdf" };
    const held: Attachment = { mime: "application/pdf", fileId: "file_app" };
    const sheet: Attachment = { mime: "text/csv", data: Buffer.from("a,b\n1,2").toString("base64") };

    expect((await uploads.refer("messages", here, [pdf])).attachments).toEqual([pdf]);
    expect((await uploads.refer("messages", here, [linked, held, sheet], small)).attachments).toEqual([linked, held, sheet]);
    expect((await uploads.refer("messages", here, [pdf], false)).attachments).toEqual([pdf]);
    expect((await uploads.refer("a wire nobody registered", here, [pdf], small)).attachments).toEqual([pdf]);
    expect(model.seen).toHaveLength(0);
  });

  it("does not use a name past the time the endpoint said it would expire", async () => {
    let now = Date.parse("2026-11-13T00:00:00Z");
    const model = recorder((_seen, all) => Response.json({ id: `file_${all.length}`, expires_at: "2026-11-14T00:00:00Z" }));
    const uploads = new Uploads({ now: () => now });
    const here = at("https://models.test", model.fetch);

    expect((await uploads.refer("messages", here, [pdf], small)).attachments[0]!.fileId).toBe("file_1");
    now = Date.parse("2026-11-13T23:00:00Z");
    expect((await uploads.refer("messages", here, [pdf], small)).attachments[0]!.fileId).toBe("file_1");
    // Within minutes of expiring is as good as expired: a request can take that long.
    now = Date.parse("2026-11-13T23:58:00Z");
    expect((await uploads.refer("messages", here, [pdf], small)).attachments[0]!.fileId).toBe("file_2");
    expect(model.seen).toHaveLength(2);
  });

  it("uploads once when several requests want the same file at once", async () => {
    const model = recorder(async () => {
      await new Promise((resume) => setTimeout(resume, 5));
      return Response.json({ id: "file_1" });
    });
    const uploads = new Uploads();
    const here = at("https://models.test", model.fetch);
    const all = await Promise.all([1, 2, 3].map(() => uploads.refer("messages", here, [pdf], small)));
    expect(all.map((one) => one.attachments[0]!.fileId)).toEqual(["file_1", "file_1", "file_1"]);
    expect(model.seen).toHaveLength(1);
  });

  it("stores a picture to be looked at and a document to be read on responses, with an expiry in seconds", async () => {
    const model = recorder((_seen, all) => Response.json({ id: `file-${all.length}`, expires_at: 1_800_000_000 }));
    const uploads = new Uploads({ now: () => 1_700_000_000_000 });
    const referred = await uploads.refer("responses", at("https://items.test/v1", model.fetch), [picture, pdf], { over: 1, keep: 3600 });
    expect(referred.attachments.map((attachment) => attachment.fileId)).toEqual(["file-1", "file-2"]);
    expect(model.seen[0]).toMatchObject({
      url: "https://items.test/v1/files",
      headers: { authorization: "Bearer secret" },
      form: { purpose: "vision", "expires_after[anchor]": "created_at", "expires_after[seconds]": "3600" },
    });
    expect(model.seen[1]!.form!.purpose).toBe("user_data");
    // A bare origin gets the version the surface lives under, as its conversations do.
    await uploads.refer("responses", at("https://bare.test", model.fetch), [pdf], small);
    expect(model.seen[2]!.url).toBe("https://bare.test/v1/files");
  });

  it("uploads on chat only where the provider said the endpoint stores files, and only a PDF", async () => {
    const model = recorder(() => Response.json({ id: "file-1" }));
    const uploads = new Uploads();
    const here = at("https://chat.test/v1", model.fetch, { credentialHeader: "api-key" });
    expect((await uploads.refer("chat", here, [pdf])).attachments).toEqual([pdf]);
    expect(model.seen).toHaveLength(0);
    const referred = await uploads.refer("chat", here, [pdf, picture], { over: 1 });
    expect(referred.attachments).toEqual([{ mime: "application/pdf", name: "report.pdf", fileId: "file-1" }, picture]);
    expect(model.seen).toHaveLength(1);
    expect(model.seen[0]).toMatchObject({ url: "https://chat.test/v1/files", headers: { "api-key": "secret" } });
  });

  it("starts an upload, sends the bytes where it is told, and waits for a film to be processed on contents", async () => {
    const waits: number[] = [];
    const model = recorder((seen) => {
      if (seen.url.endsWith("/upload/v1beta/files")) return new Response("{}", { headers: { "x-goog-upload-url": "https://store.test/session/abc" } });
      if (seen.url === "https://store.test/session/abc") {
        return Response.json({ file: { name: "files/f1", uri: "https://media.test/v1beta/files/f1", state: "PROCESSING" } });
      }
      return Response.json({ name: "files/f1", uri: "https://media.test/v1beta/files/f1", state: "ACTIVE", expirationTime: "2026-11-15T00:00:00Z" });
    });
    const uploads = new Uploads({ now: () => Date.parse("2026-11-13T00:00:00Z"), wait: async (ms) => void waits.push(ms) });
    const referred = await uploads.refer("contents", at("https://media.test", model.fetch), [film], small);

    expect(referred.attachments).toEqual([{ mime: "video/mp4", name: "tour.mp4", url: "https://media.test/v1beta/files/f1" }]);
    expect(model.seen[0]).toMatchObject({
      url: "https://media.test/upload/v1beta/files",
      method: "POST",
      headers: {
        "x-goog-api-key": "secret",
        "x-goog-upload-protocol": "resumable",
        "x-goog-upload-command": "start",
        "x-goog-upload-header-content-length": "11",
        "x-goog-upload-header-content-type": "video/mp4",
      },
      body: JSON.stringify({ file: { display_name: "tour.mp4" } }),
    });
    expect(model.seen[1]).toMatchObject({
      url: "https://store.test/session/abc",
      headers: { "x-goog-upload-offset": "0", "x-goog-upload-command": "upload, finalize" },
      body: "a long film",
    });
    expect(model.seen[2]).toMatchObject({ url: "https://media.test/v1beta/files/f1", method: "GET" });
    expect(waits).toEqual([1000]);

    // The same store serves the other shape this vendor speaks, from a base that names its version.
    const other = await uploads.refer("interactions", at("https://media.test/v1beta", model.fetch), [film], small);
    expect(other.attachments[0]!.url).toBe("https://media.test/v1beta/files/f1");
    expect(model.seen[3]!.url).toBe("https://media.test/upload/v1beta/files");
  });

  it("sends the bytes inside the request when an upload fails, says so, and stops asking an endpoint with no files API", async () => {
    const model = recorder((seen) =>
      seen.url.startsWith("https://nofiles.test") ? new Response("no such route", { status: 404 }) : new Response("storage is full", { status: 400 }),
    );
    const uploads = new Uploads();

    const full = await uploads.refer("messages", at("https://models.test", model.fetch), [pdf], small);
    expect(full.attachments).toEqual([pdf]);
    expect(full.notes[0]).toContain('"report.pdf" (application/pdf) is 0.0 MB and could not be uploaded to this endpoint');
    expect(full.notes[0]).toContain("storage is full");
    expect(full.notes[0]).toContain("sent inside the request instead");
    // A refusal that might clear is asked again next time.
    await uploads.refer("messages", at("https://models.test", model.fetch), [pdf], small);
    expect(model.seen).toHaveLength(2);

    const none = at("https://nofiles.test", model.fetch);
    expect((await uploads.refer("messages", none, [pdf, picture], small)).notes).toHaveLength(1);
    expect((await uploads.refer("messages", none, [pdf], small)).notes).toEqual([]);
    expect(model.seen.filter((entry) => entry.url.startsWith("https://nofiles.test"))).toHaveLength(1);
  });

  it("takes an uploader for a wire of the app's own, and refuses one for a wire that ships", async () => {
    registerUploader("house-wire", async (attachment) => ({ attachment: { mime: attachment.mime, fileId: "h1" } }), { over: 2 });
    expect(knownUploaders()).toEqual(expect.arrayContaining(["messages", "responses", "chat", "contents", "interactions", "house-wire"]));
    const referred = await new Uploads().refer("house-wire", at("https://house.test", fetch), [pdf]);
    expect(referred.attachments).toEqual([{ mime: "application/pdf", fileId: "h1" }]);
    expect(() => registerUploader("messages", async () => undefined)).toThrow("ships");
  });
});

describe("a stored file on each wire", () => {
  const sentBy = async (adapter: (request: ChatRequest) => Promise<unknown>, attachments: Attachment[], baseUrl = "https://models.test"): Promise<string> => {
    let body = "";
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      body = String(init?.body);
      return Response.json({});
    }) as typeof fetch;
    await adapter({
      model: "m",
      baseUrl,
      apiKey: "k",
      system: "",
      messages: [{ role: "user", content: "Read this.", attachments }],
      effort: 0,
      depth: "none",
      fetch: fetchImpl,
    });
    return body;
  };
  const stored: Attachment = { mime: "application/pdf", name: "report.pdf", fileId: "file_1" };
  const seenPicture: Attachment = { mime: "image/png", fileId: "file_2" };

  it("is named, not sent, on messages, responses and chat", async () => {
    const messages = await sentBy(messagesWire, [stored, seenPicture]);
    expect(messages).toContain('{"type":"document","source":{"type":"file","file_id":"file_1"},"title":"report.pdf"}');
    expect(messages).toContain('{"type":"image","source":{"type":"file","file_id":"file_2"}}');

    const responses = await sentBy(responsesWire(), [stored, seenPicture]);
    expect(responses).toContain('{"type":"input_file","file_id":"file_1"}');
    expect(responses).toContain('{"type":"input_image","file_id":"file_2"}');

    expect(await sentBy(chatWire, [stored])).toContain('{"type":"file","file":{"file_id":"file_1"}}');
  });

  it("is named by its address on contents and interactions", async () => {
    const byUri: Attachment = { mime: "video/mp4", url: "https://media.test/v1beta/files/f1" };
    expect(await sentBy(contentsWire, [byUri])).toContain('{"fileData":{"mimeType":"video/mp4","fileUri":"https://media.test/v1beta/files/f1"}}');
    expect(await sentBy(interactionsWire, [byUri])).toContain('{"type":"video","uri":"https://media.test/v1beta/files/f1","mime_type":"video/mp4"}');
  });
});

describe("through an agent", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "praecise-uploads-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  it("a large document is uploaded once and named on every turn of the loop, and a large tool result likewise", async () => {
    const config = {
      models: { house: { url: "https://models.test", credential: "HOUSE_KEY", speaks: "messages", fast: "small", uploads: { over: 8 } } },
    };
    const turns = [
      { content: [{ type: "tool_use", id: "t1", name: "scan", input: {} }], stop_reason: "tool_use" },
      { content: [{ type: "text", text: "Both say the same." }], stop_reason: "end_turn" },
    ];
    const model = recorder((seen, all) => {
      if (seen.url.endsWith("/v1/files")) return Response.json({ id: `file_${all.filter((entry) => entry.url.endsWith("/v1/files")).length}` });
      return Response.json({ ...turns.shift(), usage: { input_tokens: 10, output_tokens: 2 } });
    });
    const scan = fn({ description: "Scan the page on the desk.", effect: "read", run: async () => (await import("../src/harness/modality.js")).attach("Scanned.", picture) });
    const app = await createApp(
      { root, config, agents: { a: agent({ role: "Compare.", quality: "fast", tools: ["scan"] }) }, functions: { scan } },
      { env: { HOUSE_KEY: "k" }, fetch: model.fetch },
    );
    const tiny: Attachment = { mime: "image/png", data: "aGk=" };
    const answer = await app.ask("a", "Compare the report with the page.", { attachments: [pdf, tiny] });
    expect(answer.text).toBe("Both say the same.");
    expect(answer.notes ?? []).toEqual([]);

    const uploadsSeen = model.seen.filter((entry) => entry.url.endsWith("/v1/files"));
    expect(uploadsSeen.map((entry) => entry.file?.name)).toEqual(["report.pdf", "plan.png"]);
    const asks = model.seen.filter((entry) => entry.url.endsWith("/v1/messages"));
    expect(asks).toHaveLength(2);
    for (const ask of asks) {
      expect(ask.body).toContain('"source":{"type":"file","file_id":"file_1"}');
      expect(ask.body).not.toContain(pdf.data);
      // What is small still travels as it always did.
      expect(ask.body).toContain('"data":"aGk="');
    }
    expect(asks[1]!.body).toContain('"source":{"type":"file","file_id":"file_2"}');
    await app.close();
  });
});
