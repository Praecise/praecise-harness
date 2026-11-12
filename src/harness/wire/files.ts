/**
 * Bytes too large to keep sending, handed to the endpoint once.
 *
 * An attachment travels inside the request that carries it, and a tool loop sends the
 * same request again with one more turn on the end — so a forty-megabyte recording is
 * uploaded six or sixty times, and past a certain size the endpoint refuses the request
 * outright. The endpoints that publish a files API take the bytes once and hand back a
 * name for them; this is the cache of those names.
 *
 * It is keyed by what the bytes are and where they went: the same file sent to two
 * endpoints is two uploads, because a name minted by one means nothing to the other,
 * and the same file sent twice to one endpoint is one. A name an endpoint said would
 * expire is not used past that, and an upload that fails is not an error: the bytes go
 * inside the request as they always did, and a note says so.
 *
 * How a given wire uploads is an `Uploader`, registered beside the wire. Each one here
 * was written from the vendor's documentation as it stood on 2026-11-13.
 */

import { createHash } from "node:crypto";

import type { Attachment } from "../types.js";
import { ProviderError } from "../types.js";
import { versioned } from "./contents.js";
import { bearer, send, type Endpoint } from "./http.js";
import { MESSAGES_VERSION } from "./messages.js";

/** What an endpoint gave back for bytes handed to it. */
export interface Uploaded {
  /** The attachment as it is sent from now on: named by `fileId` or `url`, without its bytes. */
  attachment: Attachment;
  /** When the endpoint stops holding it, in milliseconds since the epoch, where it said. */
  expires?: number;
}

/** What an uploader is given besides the bytes. */
export interface Uploading {
  /** How long the endpoint is asked to hold the file, in seconds, where it can be asked. */
  keep: number;
  /** Waits, for an endpoint that takes a moment to make a file usable. */
  wait(ms: number): Promise<void>;
}

/**
 * Hands one attachment's bytes to an endpoint and returns the name they now go by, or
 * nothing when this endpoint's files API does not hold that kind of thing.
 */
export type Uploader = (attachment: Attachment, endpoint: Endpoint, during: Uploading) => Promise<Uploaded | undefined>;

interface Registered {
  upload: Uploader;
  /** Bytes past which an attachment is uploaded when the provider names no size. */
  over: number;
  /** Whether an endpoint on this wire uploads without its provider saying so. */
  byDefault: boolean;
}

const MB = 1024 * 1024;

/** A week. Long enough for a conversation to be picked up again, short enough that nothing is kept for good. */
const KEEP_SECONDS = 7 * 24 * 60 * 60;

/** A name this close to expiring is not handed out: a request may be minutes in the making. */
const MARGIN_MS = 5 * 60 * 1000;

const bytesOf = (attachment: Attachment): Uint8Array<ArrayBuffer> => new Uint8Array(Buffer.from(attachment.data ?? "", "base64"));

const blobOf = (attachment: Attachment): Blob => new Blob([bytesOf(attachment)], { type: attachment.mime });

const named = (attachment: Attachment): string => attachment.name ?? `attachment.${attachment.mime.split("/")[1]?.replace(/[^a-z0-9]+/gi, "") || "bin"}`;

/** The reference that replaces the bytes: everything about the attachment except them. */
const referring = (attachment: Attachment, by: Pick<Attachment, "fileId" | "url">): Attachment => ({
  mime: attachment.mime,
  ...(attachment.name ? { name: attachment.name } : {}),
  ...by,
});

// ── messages ────────────────────────────────────────────────────────────────

/** The kinds this endpoint reads from a stored file: a picture as an image block, a PDF or plain text as a document. */
const MESSAGES_READS = /^(image\/(jpeg|png|gif|webp)|application\/pdf|text\/plain)$/;

/**
 * `POST {base}/v1/files`, multipart, one `file` part. The reply's `id` goes back in a
 * block whose source is `{ type: "file", file_id }`. The endpoint holds a file until it
 * is deleted unless `expires_in_seconds` is sent with it, so it is.
 */
const messagesUploader: Uploader = async (attachment, endpoint, during) => {
  if (!MESSAGES_READS.test(attachment.mime.toLowerCase())) return undefined;
  const form = new FormData();
  form.append("file", blobOf(attachment), named(attachment));
  form.append("expires_in_seconds", String(Math.min(Math.max(during.keep, 3_600), 7_776_000)));
  const response = await send("messages", endpoint, `${endpoint.baseUrl.replace(/\/$/, "")}/v1/files`, {
    headers: { [endpoint.credentialHeader ?? "x-api-key"]: endpoint.apiKey, "anthropic-version": MESSAGES_VERSION },
    body: form,
  });
  const file = (await response.json()) as { id?: string; expires_at?: string | null };
  if (!file.id) throw new Error("the endpoint stored the file and returned no id for it");
  const expires = file.expires_at ? Date.parse(file.expires_at) : NaN;
  return { attachment: referring(attachment, { fileId: file.id }), ...(Number.isFinite(expires) ? { expires } : {}) };
};

// ── responses and chat ──────────────────────────────────────────────────────

/**
 * `POST {base}/files`, multipart: a `purpose` and the `file`. A picture is stored for
 * looking at (`vision`) and anything else as something a model is given (`user_data`).
 * The expiry is asked for in the bracketed form the endpoint documents for multipart,
 * and comes back in seconds.
 */
function storedFiles(wire: string, root: (baseUrl: string) => string, reads: (mime: string) => boolean): Uploader {
  return async (attachment, endpoint, during) => {
    const mime = attachment.mime.toLowerCase();
    if (!reads(mime)) return undefined;
    const form = new FormData();
    form.append("purpose", mime.startsWith("image/") ? "vision" : "user_data");
    form.append("file", blobOf(attachment), named(attachment));
    form.append("expires_after[anchor]", "created_at");
    form.append("expires_after[seconds]", String(Math.min(Math.max(during.keep, 3_600), 2_592_000)));
    const response = await send(wire, endpoint, `${root(endpoint.baseUrl)}/files`, { headers: bearer(endpoint), body: form });
    const file = (await response.json()) as { id?: string; expires_at?: number | null };
    if (!file.id) throw new Error("the endpoint stored the file and returned no id for it");
    return {
      attachment: referring(attachment, { fileId: file.id }),
      ...(typeof file.expires_at === "number" ? { expires: file.expires_at * 1000 } : {}),
    };
  };
}

/** Where the `responses` surface keeps its siblings: beside it, under the version. */
function responsesRoot(baseUrl: string): string {
  const root = baseUrl.replace(/\/+$/, "");
  return /\/v\d[^/]*$/.test(root) ? root : `${root}/v1`;
}

// ── contents and interactions ───────────────────────────────────────────────

interface StoredFile {
  name?: string;
  uri?: string;
  state?: string;
  expirationTime?: string;
  error?: { message?: string };
}

/** How long a file may take to become usable before the upload counts as failed. A film is processed before it can be read. */
const READY_MS = 120_000;

/**
 * The two-step upload this vendor documents: a start request that says what is coming
 * and is answered with an address in `x-goog-upload-url`, then the bytes to that
 * address. The file comes back with a `uri`, which is what a request names it by, and
 * possibly still `PROCESSING` — it is asked after until it is `ACTIVE`. Every file is
 * dropped by the endpoint after two days, and says when.
 */
function resumable(wire: string): Uploader {
  return async (attachment, endpoint, during) => {
    const base = new URL(versioned(endpoint.baseUrl));
    const credential = { [endpoint.credentialHeader ?? "x-goog-api-key"]: endpoint.apiKey };
    const bytes = bytesOf(attachment);

    const started = await send(wire, endpoint, `${base.origin}/upload${base.pathname}/files`, {
      headers: {
        ...credential,
        "x-goog-upload-protocol": "resumable",
        "x-goog-upload-command": "start",
        "x-goog-upload-header-content-length": String(bytes.byteLength),
        "x-goog-upload-header-content-type": attachment.mime,
        "content-type": "application/json",
      },
      body: JSON.stringify({ file: { display_name: named(attachment) } }),
    });
    const target = started.headers.get("x-goog-upload-url");
    if (!target) throw new Error("the endpoint accepted the upload and gave no address to send it to");

    const finished = await send(wire, endpoint, target, {
      headers: { "x-goog-upload-offset": "0", "x-goog-upload-command": "upload, finalize" },
      body: new Blob([bytes]),
    });
    let file = ((await finished.json()) as { file?: StoredFile }).file ?? {};

    const deadline = Date.now() + READY_MS;
    for (let pause = 1_000; file.state === "PROCESSING" && file.name; pause = Math.min(pause * 2, 8_000)) {
      if (Date.now() > deadline) throw new Error("the endpoint was still processing the file after two minutes");
      await during.wait(pause);
      file = (await (await send(wire, endpoint, `${base.href.replace(/\/$/, "")}/${file.name}`, { headers: credential })).json()) as StoredFile;
    }
    if (file.state === "FAILED") throw new Error(`the endpoint could not process the file${file.error?.message ? `: ${file.error.message}` : ""}`);
    if (!file.uri) throw new Error("the endpoint stored the file and returned no uri for it");

    const expires = file.expirationTime ? Date.parse(file.expirationTime) : NaN;
    return { attachment: referring(attachment, { url: file.uri }), ...(Number.isFinite(expires) ? { expires } : {}) };
  };
}

const UPLOADERS = new Map<string, Registered>([
  // A picture past five megabytes is refused inline on this endpoint, so that is the line.
  ["messages", { upload: messagesUploader, over: 5 * MB, byDefault: true }],
  ["responses", { upload: storedFiles("responses", responsesRoot, () => true), over: 20 * MB, byDefault: true }],
  // The shape many servers speak and few of them store files for. Only a PDF is read
  // from a stored file here, and only where the provider said the endpoint has the API.
  ["chat", { upload: storedFiles("chat", (baseUrl) => baseUrl.replace(/\/+$/, ""), (mime) => mime === "application/pdf"), over: 20 * MB, byDefault: false }],
  ["contents", { upload: resumable("contents"), over: 20 * MB, byDefault: true }],
  ["interactions", { upload: resumable("interactions"), over: 20 * MB, byDefault: true }],
]);

const BUILT_IN: ReadonlySet<string> = new Set(UPLOADERS.keys());

/**
 * Teach the framework how a wire of your own stores a file.
 *
 * Registered under the wire's name, beside `registerWire`. `over` is the size in bytes
 * past which an attachment is uploaded when the provider names none. The ones that ship
 * are not replaceable, for the reason the wires are not.
 */
export function registerUploader(wire: string, upload: Uploader, options: { over?: number } = {}): void {
  if (!wire || !wire.trim()) throw new Error("an uploader is registered under the name of the wire it uploads for");
  if (BUILT_IN.has(wire)) throw new Error(`"${wire}" is a shape this framework ships, and so is how it stores a file. Register yours under your own wire's name.`);
  if (typeof upload !== "function") throw new Error(`the uploader for "${wire}" must be a function taking an attachment and an endpoint`);
  UPLOADERS.set(wire, { upload, over: options.over ?? 20 * MB, byDefault: true });
}

/** The wires that can store a file, for a diagnostic. */
export const knownUploaders = (): string[] => [...UPLOADERS.keys()];

/** What a provider may say about uploading: nothing, yes or no, or the size and how long to keep. */
export type UploadSetting = boolean | { over?: number; keep?: number } | undefined;

const fingerprint = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

const megabytes = (bytes: number): string => `${(bytes / MB).toFixed(1)} MB`;

const labelOf = (attachment: Attachment): string => (attachment.name ? `"${attachment.name}" (${attachment.mime})` : attachment.mime);

export interface UploadsOptions {
  /** The clock expiry is judged against. Replaceable so a test can move it. */
  now?: () => number;
  /** How a wait is waited. Replaceable so a test does not. */
  wait?: (ms: number) => Promise<void>;
}

/**
 * The names endpoints have given for bytes handed to them, for as long as this lives.
 *
 * Held in memory by whoever is making requests — the runtime keeps one. A process that
 * restarts uploads again, which costs one upload and is the safe direction to be wrong
 * in: a name remembered past the file it named is a request that fails.
 */
export class Uploads {
  private readonly held = new Map<string, Promise<Uploaded | undefined>>();
  /** Endpoints that answered an upload as though they have no files API at all. */
  private readonly without = new Set<string>();
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;

  constructor(options: UploadsOptions = {}) {
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? ((ms) => new Promise((resume) => setTimeout(resume, ms)));
  }

  /**
   * The attachments as this endpoint should be sent them: those past the line by name,
   * the rest as they are. `notes` says what could not be uploaded and went inline.
   */
  async refer(
    wire: string,
    endpoint: Endpoint,
    attachments: readonly Attachment[],
    setting?: UploadSetting,
  ): Promise<{ attachments: Attachment[]; notes: string[] }> {
    const registered = UPLOADERS.get(wire);
    const notes: string[] = [];
    if (!registered || setting === false || (setting === undefined && !registered.byDefault)) {
      return { attachments: [...attachments], notes };
    }
    const chosen = typeof setting === "object" ? setting : {};
    const over = chosen.over ?? registered.over;
    const keep = chosen.keep ?? KEEP_SECONDS;
    const place = `${wire}\u0000${endpoint.baseUrl}\u0000${fingerprint(endpoint.apiKey)}`;

    const out: Attachment[] = [];
    for (const attachment of attachments) {
      // Already a name or an address, or small enough to travel: nothing to do.
      const size = attachment.data === undefined || attachment.fileId ? 0 : Math.floor((attachment.data.length * 3) / 4);
      if (size <= over || this.without.has(place)) {
        out.push(attachment);
        continue;
      }
      const key = `${place}\u0000${createHash("sha256").update(attachment.mime.toLowerCase()).update("\u0000").update(attachment.data ?? "").digest("hex")}`;
      try {
        const uploaded = await this.once(key, () => registered.upload(attachment, endpoint, { keep, wait: this.wait }));
        out.push(uploaded?.attachment ?? attachment);
      } catch (error) {
        // An endpoint that does not know the path has no files API; asking it again for
        // the next file would be the same answer at the cost of another request.
        if (error instanceof ProviderError && [404, 405, 501].includes(error.status)) this.without.add(place);
        // The caller giving up is the caller's, not a reason to send forty megabytes inline.
        if (endpoint.signal?.aborted) throw error;
        notes.push(
          `${labelOf(attachment)} is ${megabytes(size)} and could not be uploaded to this endpoint ` +
            `(${(error as Error).message.slice(0, 200)}); it was sent inside the request instead.`,
        );
        out.push(attachment);
      }
    }
    return { attachments: out, notes };
  }

  /** One upload per file per endpoint, however many requests ask at once, until its name expires. */
  private async once(key: string, upload: () => Promise<Uploaded | undefined>): Promise<Uploaded | undefined> {
    const existing = this.held.get(key);
    if (existing) {
      const uploaded = await existing.catch(() => undefined);
      if (uploaded === undefined && this.held.get(key) === existing) {
        // It was not this endpoint's kind of file. That does not change by asking again.
        return undefined;
      }
      if (uploaded && (uploaded.expires === undefined || uploaded.expires - MARGIN_MS > this.now())) return uploaded;
      if (this.held.get(key) === existing) this.held.delete(key);
      return this.once(key, upload);
    }
    const pending = upload();
    this.held.set(key, pending);
    try {
      return await pending;
    } catch (error) {
      if (this.held.get(key) === pending) this.held.delete(key);
      throw error;
    }
  }

  /** Forget every name, so the next request uploads afresh. */
  clear(): void {
    this.held.clear();
    this.without.clear();
  }
}
