/**
 * A decoder that asks an `ffmpeg` binary to do the work.
 *
 * The framework ships no codec and will not grow one: a decoder for every container
 * and every codec inside it is a project of its own, and one already exists on most
 * machines that handle video at all. So this is the thinnest thing that can be called a
 * decoder — it writes the film to a temporary directory, runs the binary the app
 * pointed at twice, and reads back stills and a sound track.
 *
 * Nothing here looks for the binary. An app that wants this names where it is:
 *
 *   registerDecoder("ffmpeg", "video/", ffmpegDecoder({ bin: "/usr/bin/ffmpeg" }));
 *
 * and an app that does not is exactly where it was before.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Decoded, Decoder } from "./modality.js";
import type { Attachment } from "./types.js";

/** What running the binary came to. */
export interface FfmpegRun {
  /** Its exit code. */
  code: number;
  /** What it wrote to standard error, which is where it writes everything about the input. */
  stderr: string;
}

export interface FfmpegOptions {
  /** The binary to run. Named by the app; never searched for. */
  bin: string;
  /** Seconds between one still and the next. Default 2. */
  every?: number;
  /**
   * The most stills taken from one film. Default 16. A film too long for that many at
   * `every` is sampled more sparsely instead of being cut short, so the stills span it.
   */
  frames?: number;
  /** The widest a still may be, in pixels. Narrower films are left as they are. Default 768. */
  width?: number;
  /** The form the sound track is taken in, or false to leave it. Default `"wav"`, which every build can write. */
  audio?: "wav" | "mp3" | false;
  /**
   * Whether a film given as an address is handed to the binary to fetch. Default false:
   * the binary would fetch it from this machine, which is not a thing to do with an
   * address somebody else supplied unless the app has decided it is.
   */
  urls?: boolean;
  /** How the binary is run. Replaceable so that a test needs no binary. */
  run?: (bin: string, args: string[], signal?: AbortSignal) => Promise<FfmpegRun>;
}

const EVERY = 2;
const FRAMES = 16;
const WIDTH = 768;

/** Run a binary with arguments and no shell, and report how it ended instead of throwing on a bad exit. */
function runBinary(bin: string, args: string[], signal?: AbortSignal): Promise<FfmpegRun> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { signal, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (!error) return resolve({ code: 0, stderr });
      const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
      // A number is the binary's own verdict on its input. Anything else is the binary
      // not having run at all — not found, not executable, cancelled.
      if (typeof code === "number") return resolve({ code, stderr });
      reject(new Error(`could not run ${bin}: ${error.message}`, { cause: error }));
    });
  });
}

/** How long the input runs, read from what the binary says about it. */
function durationIn(stderr: string): number | undefined {
  const found = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr);
  if (!found) return undefined;
  const total = Number(found[1]) * 3600 + Number(found[2]) * 60 + Number(found[3]);
  return Number.isFinite(total) && total > 0 ? total : undefined;
}

/** The last few lines of what the binary complained about, which is where the reason is. */
const complaint = (stderr: string): string => stderr.trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 400) || "it gave no reason";

const extensionOf = (mime: string): string => (/^video\/([a-z0-9]+)/.exec(mime.toLowerCase())?.[1] ?? "bin").replace("quicktime", "mov").replace("x-matroska", "mkv");

/**
 * A decoder over an `ffmpeg` binary: stills at an even interval, and the sound track.
 *
 * The first run asks the binary only what the input is, which is how the interval is
 * chosen: `every` seconds, or wider if the film is too long for `frames` stills at that.
 */
export function ffmpegDecoder(options: FfmpegOptions): Decoder {
  if (!options.bin?.trim()) throw new Error("ffmpegDecoder needs `bin`: the path of the ffmpeg binary to run");
  const run = options.run ?? runBinary;
  const most = Math.max(1, Math.floor(options.frames ?? FRAMES));
  const width = Math.max(16, Math.floor(options.width ?? WIDTH));
  const sound = options.audio ?? "wav";

  return async (attachment: Attachment, during): Promise<Decoded | undefined> => {
    const remote = attachment.data === undefined;
    if (remote && !(options.urls && /^https?:\/\//i.test(attachment.url ?? ""))) return undefined;

    const dir = await mkdtemp(join(tmpdir(), "praecise-film-"));
    try {
      let input = attachment.url ?? "";
      if (!remote) {
        input = join(dir, `input.${extensionOf(attachment.mime)}`);
        await writeFile(input, Buffer.from(attachment.data ?? "", "base64"));
      }

      // With no output named the binary describes the input and exits non-zero, which is
      // the cheapest way to learn how long it runs and whether it has sound.
      const probe = await run(options.bin, ["-hide_banner", "-i", input], during.signal);
      const duration = durationIn(probe.stderr);
      const hasSound = /Stream #[^\n]*Audio:/.test(probe.stderr);
      const every = Math.max(options.every ?? EVERY, duration ? duration / most : 0);

      const stills = await run(
        options.bin,
        [
          "-hide_banner", "-loglevel", "error", "-y",
          "-i", input,
          "-vf", `fps=1/${every},scale=w='min(${width},iw)':h=-2`,
          "-frames:v", String(most),
          "-q:v", "4",
          join(dir, "still-%04d.jpg"),
        ],
        during.signal,
      );
      if (stills.code !== 0) throw new Error(`ffmpeg could not take stills: ${complaint(stills.stderr)}`);

      const base = attachment.name ?? "video";
      const names = (await readdir(dir)).filter((name) => /^still-\d+\.jpg$/.test(name)).sort();
      const frames: Attachment[] = [];
      for (const [at, name] of names.entries()) {
        frames.push({
          mime: "image/jpeg",
          data: (await readFile(join(dir, name))).toString("base64"),
          name: `${base} at ${Number((at * every).toFixed(1))}s.jpg`,
        });
      }

      let audio: Attachment | undefined;
      if (sound && hasSound) {
        const file = join(dir, `sound.${sound}`);
        const taken = await run(
          options.bin,
          [
            "-hide_banner", "-loglevel", "error", "-y",
            "-i", input,
            // Speech, not music: one channel at sixteen kilohertz is what a model that
            // hears is trained on, and a tenth of the bytes of the track as recorded.
            "-vn", "-ac", "1", "-ar", "16000",
            ...(sound === "mp3" ? ["-b:a", "48k"] : ["-c:a", "pcm_s16le"]),
            file,
          ],
          during.signal,
        );
        // A film whose sound cannot be taken is still a film with stills.
        if (taken.code === 0) {
          audio = {
            mime: sound === "mp3" ? "audio/mpeg" : "audio/wav",
            data: (await readFile(file)).toString("base64"),
            name: `${base} sound.${sound}`,
          };
        }
      }

      if (!frames.length && !audio) return undefined;
      return { frames, every, ...(duration ? { duration } : {}), ...(audio ? { audio } : {}) };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}
