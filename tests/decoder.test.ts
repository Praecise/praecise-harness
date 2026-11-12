/**
 * A film an endpoint cannot watch, taken apart for it.
 *
 * The framework carries no decoder, so one is registered: the stills it returns are
 * images like any other, and the sound is a recording the endpoint is sent if it hears,
 * a transcript if another endpoint on the ladder does, and otherwise named in a note.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { agent } from "../src/define.js";
import { ffmpegDecoder } from "../src/harness/ffmpeg.js";
import { knownDecoders, present, registerDecoder, show, takesOf, type Decoded } from "../src/harness/modality.js";
import type { Attachment } from "../src/harness/types.js";
import { createApp } from "../src/sdk.js";

const still = (at: number): Attachment => ({ mime: "image/jpeg", data: Buffer.from(`still ${at}`).toString("base64"), name: `clip at ${at * 2}s.jpg` });
const sound: Attachment = { mime: "audio/wav", data: "UklGRg==", name: "clip sound.wav" };
const film = (name = "clip.mp4"): Attachment => ({ mime: "video/x-test", data: "AAAA", name });

/** How many times the fake decoder was asked, by file name. */
const decodes = new Map<string, number>();
let next: Decoded | undefined | Error;

registerDecoder("a test decoder", "video/x-test", (attachment) => {
  decodes.set(attachment.name ?? "", (decodes.get(attachment.name ?? "") ?? 0) + 1);
  if (next instanceof Error) throw next;
  return next;
});

beforeEach(() => {
  next = { frames: [still(0), still(1), still(2)], every: 2, duration: 6, audio: sound };
});

describe("a film the endpoint cannot watch", () => {
  it("is named in a note, as before, when nothing decodes its type", async () => {
    const mp4: Attachment = { mime: "video/mp4", data: "AAAA", name: "holiday.mp4" };
    const shown = await show([mp4], takesOf("messages"), 1000);
    expect(shown).toEqual(present([mp4], takesOf("messages"), 1000));
    expect(shown.notes[0]).toContain("does not take video");
    expect(knownDecoders()).toContain("a test decoder");
  });

  it("is sent untouched to an endpoint that watches", async () => {
    const clip = film("watched.mp4");
    const shown = await show([clip], takesOf("contents"), 1000);
    expect(shown.attachments).toEqual([clip]);
    expect(decodes.get("watched.mp4")).toBeUndefined();
  });

  it("arrives as stills in order, and its sound is named where nothing can hear it", async () => {
    const shown = await show([film("a.mp4")], takesOf("messages"), 1000);
    expect(shown.attachments).toEqual([still(0), still(1), still(2)]);
    expect(shown.text).toContain('[Attached "a.mp4" (video/x-test), which this endpoint cannot watch, taken apart by a test decoder: 3 still(s) from it, in order, one every 2s of 6s]');
    expect(shown.notes).toHaveLength(1);
    expect(shown.notes[0]).toContain('the sound of "a.mp4" (video/x-test) (audio/wav) was not sent');
  });

  it("sends the sound as a recording to an endpoint that hears", async () => {
    const shown = await show([film("b.mp4")], takesOf("chat", ["image", "audio"]), 1000);
    expect(shown.attachments).toEqual([still(0), still(1), still(2), sound]);
    expect(shown.text).toContain("its sound as a recording");
    expect(shown.notes).toEqual([]);
  });

  it("has the sound written down where something else can hear it, once for every model asked", async () => {
    const clip = film("c.mp4");
    const heard: Attachment[] = [];
    const transcribe = async (audio: Attachment): Promise<string> => {
      heard.push(audio);
      return "Open the valve slowly.";
    };
    const first = await show([clip], takesOf("messages"), 1000, { transcribe });
    const second = await show([clip], takesOf("responses"), 1000, { transcribe });
    expect(first.text).toContain("a transcript of what is said in it]\nTranscript:\nOpen the valve slowly.");
    expect(second.text).toBe(first.text);
    expect(first.notes).toEqual([]);
    // Decoded once and listened to once, though two models were shown it.
    expect(decodes.get("c.mp4")).toBe(1);
    expect(heard).toEqual([sound]);
  });

  it("uses a transcript the decoder already has, and listens to nothing", async () => {
    next = { frames: [still(0)], transcript: "  Subtitles say hello.  " };
    let asked = 0;
    const shown = await show([film("d.mp4")], takesOf("messages"), 1000, {
      transcribe: async () => {
        asked++;
        return "never";
      },
    });
    expect(shown.text).toContain("Transcript:\nSubtitles say hello.");
    expect(asked).toBe(0);
  });

  it("says so when the stills cannot be sent either, and when a decoder fails", async () => {
    const blind = await show([film("e.mp4")], new Set(), 1000);
    expect(blind.attachments).toEqual([]);
    expect(blind.notes.join("\n")).toContain("the stills from");
    expect(blind.notes.join("\n")).toContain("does not take video");

    next = new Error("moov atom not found");
    const broken = await show([film("f.mp4")], takesOf("messages"), 1000);
    expect(broken.attachments).toEqual([]);
    expect(broken.notes[0]).toContain("could not be decoded by a test decoder: moov atom not found");
    expect(broken.notes[1]).toContain("does not take video");
  });

  it("leaves everything else that was attached where it was", async () => {
    const image: Attachment = { mime: "image/png", data: "aGVsbG8=" };
    const csv: Attachment = { mime: "text/csv", data: Buffer.from("a,b\n1,2\n").toString("base64"), name: "t.csv" };
    const shown = await show([image, film("g.mp4"), csv], takesOf("messages"), 1000, { transcribe: async () => "Hi." });
    expect(shown.attachments).toEqual([image, still(0), still(1), still(2)]);
    expect(shown.text.indexOf("taken apart")).toBeLessThan(shown.text.indexOf("shown as a table"));
  });
});

describe("through an agent", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "praecise-decoder-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  it("the model that cannot watch is sent stills and a transcript from the rung that hears", async () => {
    const config = {
      models: {
        house: { url: "https://models.test", credential: "HOUSE_KEY", speaks: "messages", fast: "small" },
        ears: { url: "https://ears.test", credential: "EARS_KEY", speaks: "contents", fast: "listener" },
      },
    };
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      sent.push({ url: String(url), body });
      if (String(url).startsWith("https://ears.test")) {
        return Response.json({
          candidates: [{ content: { parts: [{ text: "Close the valve now." }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 6 },
        });
      }
      return Response.json({ content: [{ type: "text", text: "Someone closes a valve." }], stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 5 } });
    }) as typeof fetch;

    const app = await createApp(
      { root, config, agents: { a: agent({ role: "Describe.", quality: "fast" }) } },
      { env: { HOUSE_KEY: "k", EARS_KEY: "e" }, fetch: fetchImpl },
    );
    const answer = await app.ask("a", "What happens here?", { attachments: [film("valve.mp4")] });
    expect(answer.text).toBe("Someone closes a valve.");

    // The rung that hears was asked to write the sound down, and only that.
    const listening = sent.find((entry) => entry.url.includes("ears.test"))!;
    expect(listening.url).toContain("/models/listener:generateContent");
    expect(JSON.stringify(listening.body)).toContain('"inlineData":{"mimeType":"audio/wav"');

    const asked = sent.find((entry) => entry.url.includes("models.test"))!;
    const content = (asked.body.messages as { content: Record<string, unknown>[] }[])[0]!.content;
    expect(content.filter((block) => block.type === "image")).toHaveLength(3);
    const text = String(content.find((block) => block.type === "text")!.text);
    expect(text).toContain("What happens here?");
    expect(text).toContain("Transcript:\nClose the valve now.");
    // What the transcript cost is part of what the answer cost.
    expect(answer.usage.inputTokens).toBe(140);
    expect(answer.notes ?? []).toEqual([]);
    await app.close();
  });
});

describe("the decoder over an ffmpeg binary", () => {
  it("asks the binary what the film is, then for stills spanning it and its sound", async () => {
    const runs: string[][] = [];
    const decode = ffmpegDecoder({
      bin: "/opt/tools/ffmpeg",
      frames: 4,
      run: async (bin, args) => {
        expect(bin).toBe("/opt/tools/ffmpeg");
        runs.push(args);
        const out = args[args.length - 1]!;
        if (out.endsWith("still-%04d.jpg")) {
          for (const at of [1, 2, 3, 4]) await writeFile(out.replace("%04d", String(at).padStart(4, "0")), `jpeg ${at}`);
          return { code: 0, stderr: "" };
        }
        if (out.endsWith("sound.wav")) {
          await writeFile(out, "RIFF");
          return { code: 0, stderr: "" };
        }
        return {
          code: 1,
          stderr:
            "Input #0, mov,mp4, from 'input.mp4':\n  Duration: 00:01:00.00, start: 0.000000, bitrate: 900 kb/s\n" +
            "  Stream #0:0(und): Video: h264\n  Stream #0:1(und): Audio: aac, 44100 Hz\nAt least one output file must be specified\n",
        };
      },
    });

    const decoded = await decode({ mime: "video/mp4", data: "AAAA", name: "tour.mp4" }, {});
    expect(decoded?.duration).toBe(60);
    // Sixty seconds and room for four stills: one every fifteen, not the first eight seconds.
    expect(decoded?.every).toBe(15);
    expect(decoded?.frames.map((frame) => frame.name)).toEqual(["tour.mp4 at 0s.jpg", "tour.mp4 at 15s.jpg", "tour.mp4 at 30s.jpg", "tour.mp4 at 45s.jpg"]);
    expect(Buffer.from(decoded!.frames[1]!.data!, "base64").toString()).toBe("jpeg 2");
    expect(decoded?.audio).toMatchObject({ mime: "audio/wav", name: "tour.mp4 sound.wav" });

    expect(runs).toHaveLength(3);
    expect(runs[0]!.slice(0, 2)).toEqual(["-hide_banner", "-i"]);
    expect(runs[0]![2]!.endsWith("input.mp4")).toBe(true);
    expect(runs[1]).toContain("fps=1/15,scale=w='min(768,iw)':h=-2");
    expect(runs[1]![runs[1]!.indexOf("-frames:v") + 1]).toBe("4");
    expect(runs[2]).toEqual(expect.arrayContaining(["-vn", "-ac", "1", "-ar", "16000"]));
  });

  it("reports what the binary said when it cannot open the film, and leaves an address alone", async () => {
    const decode = ffmpegDecoder({
      bin: "ffmpeg",
      run: async (_bin, args) =>
        args.includes("-vf") ? { code: 1, stderr: "input.mp4: Invalid data found when processing input\n" } : { code: 1, stderr: "" },
    });
    await expect(decode({ mime: "video/mp4", data: "AAAA" }, {})).rejects.toThrow("Invalid data found");
    expect(await decode({ mime: "video/mp4", url: "https://films.test/a.mp4" }, {})).toBeUndefined();
    expect(() => ffmpegDecoder({ bin: "" })).toThrow("needs `bin`");
  });
});
