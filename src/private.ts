/**
 * The permissions everything under `.praecise/` is written with.
 *
 * What accumulates there is not incidental: the prompts an app sends, the inputs
 * callers gave it, the outputs it produced, every conversation it has held, and
 * the approvals ledger that says who signed off on what. On a shared host that
 * is a transcript of the business, and at a default umask it is world-readable —
 * a framework cannot know whether its host is a laptop or a build agent with
 * fifty accounts on it, so it must not write as though it were the laptop.
 *
 * Owner-only is the floor, not the answer. Past it, what is kept can be sealed or kept
 * somewhere else, part by part, by the app that knows what it holds:
 *
 *   workflow runs     sealed with `AppOptions.runCipher`
 *   conversations     sealed with a cipher as `AppOptions.threads`, or kept in a backend
 *                     of the app's own given there instead
 *   agent memory      sealed with a cipher as `AppOptions.memory` — the record of what
 *                     was asked and answered, and the notes learned from it — or kept in
 *                     a backend given there, or in a declared store the agent names
 *
 * The cipher is the app's: the framework holds no key and chooses no algorithm. What is
 * still written as plain JSON, whatever is configured: procedures an agent was taught,
 * the routing record (shapes and outcomes of requests, none of their text), recordings
 * where `record` is on, the cache of ingested documents, and source cursors. With a
 * memory backend in place of a cipher, learned notes stay plain files too. And there is
 * no retention anywhere: nothing here is ever deleted for being old. An app that needs
 * all of it sealed, or any of it expired, still points its state directory somewhere
 * that provides that.
 */

import { chmod, mkdir, rename, stat } from "node:fs/promises";

/**
 * Seals and opens what is kept at rest. The same two operations a workflow run's cipher
 * has (`RunCipher`), so one cipher can be given for runs, conversations and memory.
 */
export interface StateCipher {
  seal(plain: Uint8Array): Promise<Uint8Array>;
  open(sealed: Uint8Array): Promise<Uint8Array>;
}

/** Whether a value is a cipher, as opposed to a backend given in the same place. */
export function isCipher(value: unknown): value is StateCipher {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as StateCipher).seal === "function" &&
    typeof (value as StateCipher).open === "function"
  );
}

/** What a sealed state file starts with, so a sealed file and a plain one are never mistaken for each other. */
const SEALED_STATE = "praecise-sealed-state:v1\n";

/** A state file's contents as they are written: sealed behind the marker where there is a cipher, else as they are. */
export async function sealState(cipher: StateCipher | undefined, text: string): Promise<string | Uint8Array> {
  if (!cipher) return text;
  return Buffer.concat([Buffer.from(SEALED_STATE, "utf8"), Buffer.from(await cipher.seal(Buffer.from(text, "utf8")))]);
}

/**
 * A state file's contents as they were before sealing.
 *
 * Refuses the two mismatches, and does not guess at either. A plain file where a cipher
 * is set would be read as though sealing were in force when it is not; a sealed file
 * where none is set would be read as damaged, and the next write would replace it. Both
 * are a deployment that changed its mind half-way, and both are said out loud.
 */
export async function openState(cipher: StateCipher | undefined, raw: Uint8Array, path: string): Promise<string> {
  const bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  const head = Buffer.from(SEALED_STATE, "utf8");
  const sealed = bytes.length >= head.length && bytes.subarray(0, head.length).equals(head);
  if (!cipher) {
    if (sealed) throw new Error(`${path} is sealed, and no cipher was given to open it`);
    return bytes.toString("utf8");
  }
  if (!sealed) throw new Error(`${path} is not sealed, and what is kept here is only read sealed`);
  return Buffer.from(await cipher.open(bytes.subarray(head.length))).toString("utf8");
}

/** `rwx------` — nobody but the owner may even list what is in there. */
export const DIR_MODE = 0o700;

/** `rw-------`. Applied to the temp file, which is always freshly created, so the
 *  atomic write-then-rename carries the mode onto the target rather than leaving
 *  a pre-existing file at whatever it already was. */
export const FILE_MODE = 0o600;

/**
 * Make sure a state directory exists AND that nobody but the owner may list it.
 *
 * `mkdir(dir, { mode })` sets a mode only on directories it creates, which meant
 * `DIR_MODE` did nothing for the case it most needed to cover: a `.praecise/runs`
 * restored from an archive, checked out of a repository, made by an earlier
 * version or created by a deployment script keeps whatever mode it arrived with,
 * forever. The files inside are 0600, so the contents were never at risk; the run
 * ids, workflow names and timestamps that make up the filenames were, and a
 * directory listing is how you learn what an app is used for and how often.
 *
 * The tightening is a MASK rather than an assignment: whatever the directory has,
 * minus anything outside `DIR_MODE`. So 0o755 and 0o750 become 0o700, 0o700 is
 * left alone, and a directory an operator deliberately narrowed further than the
 * framework asks for stays narrowed. No bit is ever granted, which is what makes
 * this safe to do to a directory the framework did not create.
 *
 * A failure is swallowed, deliberately. A directory that cannot be stat-ed or
 * chmod-ed is one this process does not own, and a state store that refused to
 * write because it could not re-permission someone else's directory would turn a
 * hardening into an outage.
 */
export async function privateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
  try {
    const mode = (await stat(dir)).mode & 0o777;
    if ((mode & ~DIR_MODE) !== 0) await chmod(dir, mode & DIR_MODE);
  } catch {
    // Not ours to tighten. The write is what matters and it goes ahead.
  }
}

/**
 * Move a freshly written temp file over its target.
 *
 * On Windows a rename over a file that another handle has open for reading is refused
 * (`EPERM`, `EACCES` or `EBUSY`) for as long as the read lasts, which is microseconds.
 * State here is read while it is being written — a run is polled while it runs — so the
 * refusal is expected and is waited out, briefly, instead of failing the write. Anything
 * else, and a refusal that outlasts the waits, is thrown as it came.
 */
export async function replaceFile(temp: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temp, target);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 20 || (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")) throw err;
      await new Promise((resolve) => setTimeout(resolve, 5 + attempt * 5));
    }
  }
}
