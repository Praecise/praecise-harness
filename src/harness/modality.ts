/**
 * What a model is shown when what it is sent is not text.
 *
 * Two different things arrive beside a question. Some an endpoint reads for itself: a
 * picture, a recording, a film, a PDF. The rest no model reads at all — a sensor log, a
 * robot's joint state, a tensor of actions, a scene — and those are most of what an
 * agent working outside a chat window is handed.
 *
 * Both are one `Attachment`: a media type and the bytes or an address. What differs is
 * who reads it, and that is decided here, once, for every wire:
 *
 *   the endpoint takes that kind  → it is sent as it is, untouched
 *   a reader knows the media type → the model is shown a faithful rendering of it
 *   neither                       → it is left out, and a note says so
 *
 * The data itself is never rewritten. A tool or a store that is handed the same
 * attachment gets every sample of it; only the model, which could not have read the
 * samples anyway, gets the summary. That is the whole of how a new kind of data is
 * supported: register a reader for its media type. Nothing in a wire or the loop changes.
 */

import { tokens, trim } from "./budget.js";
import type { Attachment } from "./types.js";

/** The kinds of thing an endpoint may read for itself. */
export type Kind = "image" | "audio" | "video" | "document";

/** Which of them a media type is, or nothing if no endpoint reads it natively. */
export function kindOf(mime: string): Kind | undefined {
  const type = mime.toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  if (type === "application/pdf") return "document";
  return undefined;
}

/**
 * What each shape that ships can be sent, when the provider says nothing.
 *
 * A floor rather than a claim: it is what the shape has a place for, and whether a given
 * model behind it actually looks is the endpoint's business. An endpoint that takes
 * more — a `chat` server with audio and video parts — says so in `takes`.
 */
const TAKES: Record<string, readonly Kind[]> = {
  messages: ["image", "document"],
  chat: ["image"],
  responses: ["image", "document"],
  contents: ["image", "audio", "video", "document"],
  interactions: ["image", "audio", "video", "document"],
};

export function takesOf(wire: string, declared?: readonly string[]): ReadonlySet<Kind> {
  return new Set((declared as Kind[] | undefined) ?? TAKES[wire] ?? ["image"]);
}

/** What a reader makes of an attachment: text for the model, or nothing if it is not its kind after all. */
export type Reader = (attachment: Attachment, text: string | undefined) => string | undefined;

const READERS: { name: string; matches: (mime: string) => boolean; read: Reader }[] = [];

/**
 * Teach the framework to show a kind of data to a model.
 *
 * `match` is a media type, a prefix ending in `/` or `+suffix` (`"application/senml"`,
 * `"+json"`), or a test. The reader is handed the attachment and, where it arrived as
 * bytes that decode as text, that text. It returns what the model should read — a
 * summary, a table, a description — or nothing to let the next reader try. Later
 * registrations are asked first, so an app's reader for a type beats the one that ships.
 */
export function registerReader(name: string, match: string | ((mime: string) => boolean), read: Reader): void {
  if (!name.trim()) throw new Error("a reader needs a name, to be named in a note");
  READERS.unshift({ name, matches: matcherFor(match), read });
}

/** A media type, a prefix ending in `/`, a `+suffix`, or a test of the caller's own. */
function matcherFor(match: string | ((mime: string) => boolean)): (mime: string) => boolean {
  return typeof match === "function"
    ? match
    : (mime: string): boolean =>
        match.startsWith("+") ? mime.endsWith(match) : match.endsWith("/") ? mime.startsWith(match) : mime === match || mime.startsWith(`${match}+`) || mime.startsWith(`${match};`);
}

/** The readers registered, newest first, for a diagnostic. */
export const knownReaders = (): string[] => READERS.map((reader) => reader.name);

/** The bytes of an attachment as text, where they are text. */
function textOf(attachment: Attachment): string | undefined {
  if (attachment.data === undefined) return undefined;
  try {
    const bytes = Buffer.from(attachment.data, "base64");
    // A NUL in the first stretch is the cheapest honest test for "this is not text".
    if (bytes.subarray(0, 4096).includes(0)) return undefined;
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

export interface Presented {
  /** What the endpoint is sent as it is. */
  attachments: Attachment[];
  /** What the model reads in place of the rest, to go with the question. */
  text: string;
  /** What could not be shown at all, for the developer. */
  notes: string[];
}

const label = (attachment: Attachment): string =>
  attachment.name ? `"${attachment.name}" (${attachment.mime})` : attachment.mime;

/**
 * Decide, for each thing sent with a question, who reads it.
 *
 * `limit` is the most tokens one rendering may take: a reader's summary is trimmed to
 * it like any tool result, because a sensor log that fills the context has been shown
 * to nobody.
 */
export function present(attachments: readonly Attachment[] | undefined, takes: ReadonlySet<Kind>, limit: number): Presented {
  const out: Presented = { attachments: [], text: "", notes: [] };
  const rendered: string[] = [];

  for (const attachment of attachments ?? []) {
    const mime = attachment.mime.toLowerCase();
    const kind = kindOf(mime);
    if (kind && takes.has(kind)) {
      out.attachments.push(attachment);
      continue;
    }

    const text = textOf(attachment);
    let shown: string | undefined;
    let by = "";
    for (const reader of READERS) {
      if (!reader.matches(mime)) continue;
      try {
        shown = reader.read(attachment, text);
      } catch (err) {
        out.notes.push(`${label(attachment)} could not be read as ${reader.name}: ${(err as Error).message}`);
      }
      if (shown) {
        by = reader.name;
        break;
      }
    }

    if (shown) {
      rendered.push(`[Attached ${label(attachment)}, shown as ${by}]\n${trim(shown, limit)}`);
    } else if (kind) {
      out.notes.push(`${label(attachment)} was not sent: this endpoint does not take ${kind}. Name it in \`takes\` on the endpoint if it does.`);
    } else if (attachment.data === undefined) {
      out.notes.push(`${label(attachment)} was not sent: it is an address, and nothing here reads that media type. Send the bytes, or register a reader for it.`);
    } else {
      out.notes.push(`${label(attachment)} was not shown to the model: nothing reads that media type. Register a reader for it with registerReader.`);
    }
  }

  out.text = rendered.join("\n\n");
  return out;
}

// ── Film an endpoint cannot be sent ──────────────────────────────────────────
//
// A reader turns bytes into text, and a film is not text: what a model that cannot
// watch one can still be given is stills from it and what is said in it. Getting those
// out of a container takes a decoder, and the framework carries none — so it is a seam,
// filled by whatever the app points at.

/** What a decoder got out of a film. */
export interface Decoded {
  /** Stills from it, in the order they occur. */
  frames: Attachment[];
  /** Seconds between one still and the next, where they were taken evenly. */
  every?: number;
  /** How long it runs, in seconds, where the decoder could tell. */
  duration?: number;
  /** Its sound, as a recording of its own. */
  audio?: Attachment;
  /** What is said in it, where the decoder already knows — a subtitle track, say. */
  transcript?: string;
}

/** Takes a film apart, or returns nothing if it is not one this decoder opens. */
export type Decoder = (attachment: Attachment, during: { signal?: AbortSignal }) => Decoded | undefined | Promise<Decoded | undefined>;

const DECODERS: { name: string; matches: (mime: string) => boolean; decode: Decoder }[] = [];

/**
 * Teach the framework to take a film apart for a model that cannot watch one.
 *
 * `match` is read as it is for a reader. With a decoder registered, a video sent to an
 * endpoint that does not take video arrives as stills in order, and its sound as a
 * recording where the endpoint hears, as a transcript where another endpoint on the
 * agent's ladder does, and otherwise named in a note. With none registered nothing
 * changes: the video is left out and a note says so. Later registrations are asked first.
 */
export function registerDecoder(name: string, match: string | ((mime: string) => boolean), decode: Decoder): void {
  if (!name.trim()) throw new Error("a decoder needs a name, to be named in a note");
  if (typeof decode !== "function") throw new Error(`decoder "${name}" must be a function taking an attachment`);
  DECODERS.unshift({ name, matches: matcherFor(match), decode });
}

/** The decoders registered, newest first, for a diagnostic. */
export const knownDecoders = (): string[] => DECODERS.map((decoder) => decoder.name);

/**
 * What each film came apart into, kept for as long as the attachment itself is.
 *
 * A request may be put to several models in turn, and each is shown the same film. It
 * is decoded for the first of them and not again; likewise what was heard in it.
 */
const TAKEN_APART = new WeakMap<Attachment, Promise<{ decoded?: Decoded; by: string; notes: string[] }>>();
const HEARD = new WeakMap<Attachment, Promise<string | undefined>>();

async function takeApart(attachment: Attachment, signal?: AbortSignal): Promise<{ decoded?: Decoded; by: string; notes: string[] }> {
  const mime = attachment.mime.toLowerCase();
  const notes: string[] = [];
  for (const decoder of DECODERS) {
    if (!decoder.matches(mime)) continue;
    try {
      const decoded = await decoder.decode(attachment, { signal });
      if (decoded && (decoded.frames.length || decoded.audio || decoded.transcript)) return { decoded, by: decoder.name, notes };
    } catch (err) {
      notes.push(`${label(attachment)} could not be decoded by ${decoder.name}: ${(err as Error).message}`);
    }
  }
  return { by: "", notes };
}

const seconds = (value: number): string => `${short(Number(value.toFixed(1)))}s`;

export interface Showing {
  signal?: AbortSignal;
  /**
   * Has a recording written down by something that can hear it, where this endpoint
   * cannot. Returns nothing when it could not be.
   */
  transcribe?: (audio: Attachment) => Promise<string | undefined>;
}

/**
 * `present`, after any film the endpoint cannot be sent has been taken apart.
 *
 * The stills and the sound are attachments like any other, so what happens to them
 * next is the rule above and nothing new: an endpoint that sees gets the stills, one
 * that hears gets the recording, and what neither can take is said in a note.
 */
export async function show(
  attachments: readonly Attachment[] | undefined,
  takes: ReadonlySet<Kind>,
  limit: number,
  during: Showing = {},
): Promise<Presented> {
  const films = (attachments ?? []).filter((attachment) => kindOf(attachment.mime.toLowerCase()) === "video");
  if (!DECODERS.length || !films.length || takes.has("video")) return present(attachments, takes, limit);

  const list: Attachment[] = [];
  const said: string[] = [];
  const notes: string[] = [];

  for (const attachment of attachments ?? []) {
    if (!films.includes(attachment)) {
      list.push(attachment);
      continue;
    }
    let pending = TAKEN_APART.get(attachment);
    if (!pending) {
      pending = takeApart(attachment, during.signal);
      TAKEN_APART.set(attachment, pending);
    }
    const { decoded, by, notes: problems } = await pending;
    notes.push(...problems);
    if (!decoded) {
      // Nothing opened it, so it is left to the rule it was under before: named in a note.
      list.push(attachment);
      continue;
    }

    const shown: string[] = [];
    if (decoded.frames.length && takes.has("image")) {
      list.push(...decoded.frames);
      shown.push(
        `${decoded.frames.length} still(s) from it, in order` +
          (decoded.every ? `, one every ${seconds(decoded.every)}` : "") +
          (decoded.duration ? ` of ${seconds(decoded.duration)}` : ""),
      );
    } else if (decoded.frames.length) {
      notes.push(`the stills from ${label(attachment)} were not sent: this endpoint does not take images.`);
    }

    let transcript = decoded.transcript?.trim();
    if (!transcript && decoded.audio) {
      if (takes.has("audio")) {
        list.push(decoded.audio);
        shown.push("its sound as a recording");
      } else if (during.transcribe) {
        let heard = HEARD.get(attachment);
        if (!heard) {
          heard = during.transcribe(decoded.audio).catch((err: unknown) => {
            notes.push(`the sound of ${label(attachment)} could not be transcribed: ${(err as Error).message}`);
            // Not kept: the next model asked may be luckier with it.
            HEARD.delete(attachment);
            return undefined;
          });
          HEARD.set(attachment, heard);
        }
        transcript = (await heard)?.trim();
        if (!transcript) notes.push(`the sound of ${label(attachment)} was not shown to the model: no transcript of it could be made.`);
      } else {
        notes.push(
          `the sound of ${label(attachment)} (${decoded.audio.mime}) was not sent: neither this endpoint nor any other ` +
            `on this agent's ladder takes audio, so there was nothing to transcribe it with.`,
        );
      }
    }
    if (transcript) shown.push("a transcript of what is said in it");

    if (!shown.length) {
      list.push(attachment);
      continue;
    }
    said.push(
      `[Attached ${label(attachment)}, which this endpoint cannot watch, taken apart by ${by}: ${shown.join("; ")}]` +
        (transcript ? `\nTranscript:\n${trim(transcript, limit)}` : ""),
    );
  }

  const rest = present(list, takes, limit);
  return {
    attachments: rest.attachments,
    text: [...said, rest.text].filter(Boolean).join("\n\n"),
    notes: [...notes, ...rest.notes],
  };
}

const ATTACHED = Symbol.for("praecise.attached");

/** A tool result with something attached to it. Made by `attach`. */
export interface Attached {
  readonly [ATTACHED]: Attachment[];
  readonly result: unknown;
}

/**
 * Return something other than text from a function.
 *
 * `return attach("Here is the camera frame.", { mime: "image/jpeg", data })` hands the
 * model the sentence and the picture. What the picture is shown as follows the same
 * rule as anything sent with a question: the endpoint reads it if it can, a reader
 * renders it if one knows the type, and otherwise a note says it was left out.
 */
export function attach(result: unknown, ...attachments: Attachment[]): Attached {
  return { [ATTACHED]: attachments, result };
}

export const attachedIn = (value: unknown): Attachment[] | undefined =>
  typeof value === "object" && value !== null && ATTACHED in value ? (value as Attached)[ATTACHED] : undefined;

// ── The readers that ship ───────────────────────────────────────────────────
//
// Each renders a standard, not a format of this framework's own: an app that already
// has its data in one of these needs to do nothing, and an app with another registers a
// reader of its own beside them.

interface Stats {
  count: number;
  min: number;
  max: number;
  mean: number;
  sd: number;
}

function statsOf(values: readonly number[]): Stats | undefined {
  const finite = values.filter((value) => Number.isFinite(value));
  if (!finite.length) return undefined;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const value of finite) {
    if (value < min) min = value;
    if (value > max) max = value;
    sum += value;
  }
  const mean = sum / finite.length;
  const variance = finite.reduce((total, value) => total + (value - mean) ** 2, 0) / finite.length;
  return { count: finite.length, min, max, mean, sd: Math.sqrt(variance) };
}

const short = (value: number): string => (Number.isInteger(value) ? String(value) : Number(value.toPrecision(5)).toString());

/** How many points of a series a model is shown. Enough to see its shape; not the series. */
const SHOWN = 24;

/** Evenly spaced samples, always including the first and the last. */
function sample<T>(values: readonly T[], most = SHOWN): T[] {
  if (values.length <= most) return [...values];
  return Array.from({ length: most }, (_, at) => values[Math.round((at * (values.length - 1)) / (most - 1))]!);
}

function describeSeries(name: string, unit: string | undefined, values: number[], times?: number[]): string {
  const stats = statsOf(values);
  if (!stats) return `${name}: no numeric values`;
  const span =
    times && times.length > 1 ? `, over ${short(times[times.length - 1]! - times[0]!)}s (t ${short(times[0]!)} to ${short(times[times.length - 1]!)})` : "";
  return (
    `${name}${unit ? ` (${unit})` : ""}: ${stats.count} values${span}; ` +
    `min ${short(stats.min)}, max ${short(stats.max)}, mean ${short(stats.mean)}, sd ${short(stats.sd)}; ` +
    `first ${short(values[0]!)}, last ${short(values[values.length - 1]!)}\n` +
    `  ${values.length > SHOWN ? `${SHOWN} evenly spaced of them` : "all of them"}: ${sample(values).map(short).join(", ")}`
  );
}

/**
 * SenML (RFC 8428): the IETF's shape for sensor measurements.
 *
 * An array of records, each a name, a value and a time, with base fields a record sets
 * once for those after it. Grouped by name here, because a model asked about a boiler
 * wants the temperature channel as a series and not interleaved with the pressure one.
 */
function readSenml(_attachment: Attachment, text: string | undefined): string | undefined {
  if (!text) return undefined;
  const records: unknown = JSON.parse(text);
  if (!Array.isArray(records) || !records.some((record) => typeof record === "object" && record !== null && ("n" in record || "bn" in record))) {
    return undefined;
  }
  const series = new Map<string, { unit?: string; values: number[]; times: number[] }>();
  let baseName = "";
  let baseTime = 0;
  let baseUnit: string | undefined;
  let baseValue = 0;
  for (const raw of records as Record<string, unknown>[]) {
    if (typeof raw.bn === "string") baseName = raw.bn;
    if (typeof raw.bt === "number") baseTime = raw.bt;
    if (typeof raw.bu === "string") baseUnit = raw.bu;
    if (typeof raw.bv === "number") baseValue = raw.bv;
    const value = typeof raw.v === "number" ? raw.v + baseValue : typeof raw.vb === "boolean" ? Number(raw.vb) : undefined;
    if (value === undefined) continue;
    const name = `${baseName}${typeof raw.n === "string" ? raw.n : ""}` || "value";
    const entry = series.get(name) ?? { unit: typeof raw.u === "string" ? raw.u : baseUnit, values: [], times: [] };
    entry.values.push(value);
    entry.times.push((typeof raw.t === "number" ? raw.t : 0) + baseTime);
    series.set(name, entry);
  }
  if (!series.size) return undefined;
  return [
    `Sensor measurements, ${series.size} channel(s):`,
    ...[...series.entries()].map(([name, entry]) => describeSeries(name, entry.unit, entry.values, entry.times)),
  ].join("\n");
}

interface Tensor {
  name?: string;
  shape?: number[];
  datatype?: string;
  data?: unknown;
}

const isTensor = (value: unknown): value is Tensor =>
  typeof value === "object" && value !== null && Array.isArray((value as Tensor).shape) && "data" in value;

function describeTensor(tensor: Tensor): string {
  const flat = (Array.isArray(tensor.data) ? tensor.data.flat(Infinity) : []).filter(
    (value): value is number => typeof value === "number",
  );
  const stats = statsOf(flat);
  return (
    `${tensor.name ?? "tensor"}: shape [${(tensor.shape ?? []).join(", ")}]${tensor.datatype ? `, ${tensor.datatype}` : ""}` +
    (stats
      ? `; ${stats.count} values, min ${short(stats.min)}, max ${short(stats.max)}, mean ${short(stats.mean)}, sd ${short(stats.sd)}\n` +
        `  ${flat.length > SHOWN ? `first ${SHOWN}` : "all"}: ${flat.slice(0, SHOWN).map(short).join(", ")}`
      : "; no numeric values")
  );
}

/**
 * Tensors in the Open Inference Protocol's JSON form: a name, a shape, a datatype and
 * the values. It is what a model server already exchanges, so it is how robot state, an
 * action chunk or a latent arrives when it arrives as JSON at all.
 */
function readTensors(_attachment: Attachment, text: string | undefined): string | undefined {
  if (!text) return undefined;
  const parsed: unknown = JSON.parse(text);
  const wrapped = parsed as { inputs?: unknown; outputs?: unknown };
  const tensors = isTensor(parsed)
    ? [parsed]
    : Array.isArray(parsed) && parsed.every(isTensor)
      ? parsed
      : [wrapped?.inputs, wrapped?.outputs].flatMap((list) => (Array.isArray(list) ? list.filter(isTensor) : []));
  if (!tensors.length) return undefined;
  return [`${tensors.length} tensor(s):`, ...tensors.map(describeTensor)].join("\n");
}

/** A glTF scene, counted: what is in it, not its vertices. */
function readGltf(_attachment: Attachment, text: string | undefined): string | undefined {
  if (!text) return undefined;
  const scene = JSON.parse(text) as Record<string, unknown> & { asset?: { version?: string; generator?: string } };
  if (!scene.asset?.version) return undefined;
  const count = (key: string): number => (Array.isArray(scene[key]) ? (scene[key] as unknown[]).length : 0);
  const named = (key: string): string =>
    (Array.isArray(scene[key]) ? (scene[key] as { name?: string }[]) : [])
      .map((entry) => entry.name)
      .filter(Boolean)
      .slice(0, 20)
      .join(", ");
  return (
    `A glTF ${scene.asset.version} scene${scene.asset.generator ? ` from ${scene.asset.generator}` : ""}: ` +
    `${count("scenes")} scene(s), ${count("nodes")} node(s), ${count("meshes")} mesh(es), ${count("materials")} material(s), ` +
    `${count("animations")} animation(s), ${count("cameras")} camera(s).` +
    (named("nodes") ? `\nNodes: ${named("nodes")}` : "") +
    (named("meshes") ? `\nMeshes: ${named("meshes")}` : "")
  );
}

/** Split one CSV line, honouring quotes. */
function cells(line: string): string[] {
  const out: string[] = [];
  let cell = "";
  let quoted = false;
  for (let at = 0; at < line.length; at++) {
    const char = line[at]!;
    if (quoted) {
      if (char === '"' && line[at + 1] === '"') {
        cell += '"';
        at++;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      out.push(cell);
      cell = "";
    } else cell += char;
  }
  out.push(cell);
  return out;
}

/** How many rows of a table a model is shown from each end. */
const ROWS = 8;

/**
 * A table: its columns, what each numeric one amounts to, and its first and last rows.
 *
 * A file that is short is shown whole instead — a summary of twelve rows is longer
 * than the twelve rows.
 */
function readCsv(_attachment: Attachment, text: string | undefined): string | undefined {
  if (!text) return undefined;
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return undefined;
  if (lines.length <= ROWS * 2 + 1 && tokens(text) < 1_000) return text;
  const header = cells(lines[0]!);
  const rows = lines.slice(1).map(cells);
  const columns = header.map((name, at) => {
    const values = rows.map((row) => Number(row[at]));
    const numeric = values.filter((value, index) => rows[index]![at]?.trim() !== "" && Number.isFinite(value));
    return numeric.length >= rows.length * 0.9 ? describeSeries(name || `column ${at + 1}`, undefined, numeric) : `${name || `column ${at + 1}`}: text, e.g. ${JSON.stringify(rows[0]![at] ?? "")}`;
  });
  return [
    `A table of ${rows.length.toLocaleString()} rows and ${header.length} columns.`,
    ...columns,
    `First ${ROWS} rows:`,
    lines.slice(0, ROWS + 1).join("\n"),
    `Last ${ROWS} rows:`,
    lines.slice(-ROWS).join("\n"),
  ].join("\n");
}

// Registered broadest first: later registrations are asked first, so the specific
// readers get a JSON document before the one that only knows it is JSON.
registerReader("text", (mime) => mime.startsWith("text/") || /(\+json|\/json|\+xml|\/xml|yaml|x-ndjson)$/.test(mime), (_attachment, text) => text);
registerReader("a table", (mime) => mime === "text/csv" || mime === "text/tab-separated-values", (attachment, text) =>
  attachment.mime.toLowerCase() === "text/tab-separated-values" ? readCsv(attachment, text?.replace(/\t/g, ",")) : readCsv(attachment, text),
);
registerReader("a scene", (mime) => mime === "model/gltf+json", readGltf);
registerReader("tensors", (mime) => mime.endsWith("json"), readTensors);
registerReader("sensor measurements", (mime) => mime.endsWith("json"), readSenml);
