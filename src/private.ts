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

/** `rwx------` — nobody but the owner may even list what is in there. */
export const DIR_MODE = 0o700;

/** `rw-------`. Applied to the temp file, which is always freshly created, so the
 *  atomic write-then-rename carries the mode onto the target rather than leaving
 *  a pre-existing file at whatever it already was. */
export const FILE_MODE = 0o600;
