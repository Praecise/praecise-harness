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
 * Owner-only is the floor, not the answer. There is no retention here and no
 * encryption at rest; an app holding anything that needs either should point its
 * state directory somewhere that provides them.
 */

import { chmod, mkdir, stat } from "node:fs/promises";

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
