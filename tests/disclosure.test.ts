/**
 * What leaves the process when something goes wrong, and who may read what is left behind.
 *
 * Two surfaces, one question. `safeMessage` decides what a failure is allowed to SAY to
 * whoever can reach the port; `DIR_MODE` and `FILE_MODE` decide who may READ what the
 * framework wrote down. Both are refusals, and a refusal is the kind of behaviour that
 * degrades without any test failing: narrow `safeMessage` by one branch and the messages
 * still look fine, widen `FILE_MODE` by one bit and the files still load.
 *
 * So the tests here are mostly negative. They assert what does NOT appear in a returned
 * message and what a mode is NOT, because those are the properties the code exists for.
 */

import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ProviderError } from "../src/harness/types.js";
import { DIR_MODE, FILE_MODE } from "../src/private.js";
import { safeMessage } from "../src/redact.js";
import { RunStore, type Run } from "../src/workflow/store.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "praecise-disclosure-"));
  roots.push(root);
  return root;
}

/** Run `body` with the operator log captured rather than printed. */
function withLog<T>(body: () => T): { result: T; logged: unknown[][] } {
  const logged: unknown[][] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args);
  });
  try {
    return { result: body(), logged };
  } finally {
    spy.mockRestore();
  }
}

const run = (id: string): Run => ({
  id,
  workflow: "quiet",
  status: "done",
  input: {},
  outputs: {},
  plans: {},
  usage: { inputTokens: 0, outputTokens: 0 },
  events: [],
  startedAt: Date.now(),
  updatedAt: Date.now(),
});

describe("an upstream body is not repeated to whoever asked", () => {
  const leaky = () =>
    new ProviderError(
      "messages",
      401,
      JSON.stringify({ error: { message: "invalid x-api-key sk-ant-api03-AAAABBBBCCCCDDDD" } }),
    );

  it("says the endpoint refused without quoting a word of what it said", () => {
    const { result } = withLog(() => safeMessage(leaky(), "ask"));

    expect(result).not.toContain("sk-ant-api03");
    expect(result).not.toContain("x-api-key");
    expect(result).not.toContain("invalid");
    expect(result).toContain("the messages endpoint");
    expect(result).toContain("401");
  });

  it("does not fall back to redacting the body — the whole body is withheld", () => {
    // The distinction that matters. Redaction is pattern-matched and therefore fallible,
    // and an upstream body is the one class of message that is unbounded and shaped by
    // someone else at the same time. A credential in a shape `redact` has never seen
    // survives redaction; it does not survive being dropped.
    const unknownShape = new ProviderError("chat", 403, "denied for token QQQQ-2222-WWWW-8888");
    const { result } = withLog(() => safeMessage(unknownShape, "ask"));
    expect(result).not.toContain("QQQQ-2222-WWWW-8888");
    expect(result).not.toMatch(/\[redacted\]/);
  });

  it("keeps the whole failure in the operator log, so nothing is lost — only moved", () => {
    const err = leaky();
    const { logged } = withLog(() => safeMessage(err, "POST /api/agents/support"));
    expect(logged).toHaveLength(1);
    expect(String(logged[0]?.[0])).toContain("POST /api/agents/support");
    expect(logged[0]?.[1]).toBe(err);
  });

  it("names no endpoint rather than guessing when the error carries none", () => {
    const anonymous = Object.assign(new Error("body was sk-live-0123456789abcdef"), {
      name: "ProviderError",
    });
    const { result } = withLog(() => safeMessage(anonymous, "ask"));
    expect(result).toContain("a model endpoint");
    expect(result).toContain("refused the request");
    expect(result).not.toContain("sk-live-0123456789abcdef");
  });

  it("recognises the error by name, so a re-throw across a boundary is still withheld", () => {
    // Deliberately not `instanceof`: an error that crossed a module boundary, was
    // re-thrown, or was rebuilt from a structured clone has lost its identity and kept
    // its body. Pinned because switching to `instanceof` would look like a tightening
    // and would in fact open every one of those paths.
    const cloned = {
      name: "ProviderError",
      message: "responses responded 500: Authorization: Bearer abcdef0123456789",
      provider: "responses",
      status: 500,
    };
    const { result } = withLog(() => safeMessage(cloned, "ask"));
    expect(result).toContain("the responses endpoint responded 500");
    expect(result).not.toContain("abcdef0123456789");
    expect(cloned instanceof Error).toBe(false);
  });
});

describe("everything else is redacted rather than withheld", () => {
  it("strips a credential an ordinary exception quoted", () => {
    const { result } = withLog(() =>
      safeMessage(
        new Error('store refused: postgres://app:hunter2@db.internal:5432/praecise'),
        "save",
      ),
    );
    expect(result).not.toContain("hunter2");
    expect(result).toContain("db.internal");
  });

  it("keeps the part of the message that is diagnostic", () => {
    const plain = 'step "draft" took longer than 600s (run greet-abc123)';
    const { result } = withLog(() => safeMessage(new Error(plain), "run"));
    expect(result).toBe(plain);
  });

  it("stringifies a thrown non-Error and redacts that too", () => {
    const { result } = withLog(() => safeMessage("api_key=sk-live-0123456789abcdef", "x"));
    expect(result).not.toContain("sk-live-0123456789abcdef");
    expect(result).toContain("[redacted]");
  });

  it("returns something rather than throwing for a thrown null or object", () => {
    // Reached from a `catch` on the server's request path, where throwing a second time
    // turns a 400 with a message into a 500 with none.
    expect(withLog(() => safeMessage(null, "x")).result).toBe("null");
    expect(withLog(() => safeMessage(undefined, "x")).result).toBe("undefined");
    expect(withLog(() => safeMessage({ code: 42 }, "x")).result).toBe("[object Object]");
  });

  it("loses a thrown object's message rather than leaking it (hazard)", () => {
    // HAZARD (pinned, not fixed). A thrown plain object is stringified as
    // "[object Object]", so an error shaped like `{ message: "..." }` — which is what a
    // structured clone of an Error from a worker looks like — reaches the caller with no
    // information at all. Failing safe, but failing blind: the caller is told nothing and
    // the operator log holds the object. Reading `.message` off a non-Error would fix the
    // blindness and would also start returning text from a shape that was never checked,
    // so it is a decision about what counts as an error rather than a tidy-up.
    const cloned = { message: "the store rejected the write: disk full" };
    const { result, logged } = withLog(() => safeMessage(cloned, "save"));
    expect(result).toBe("[object Object]");
    expect(logged[0]?.[1]).toBe(cloned);
  });

  it("redacts ordinary prose that happens to open with an auth keyword (hazard)", () => {
    // HAZARD (pinned, not fixed). `redact` anchors on how a secret is INTRODUCED —
    // `Bearer `, `Token `, `authorization:` — and English uses those words too. The
    // module's own comment says a redactor that eats ordinary text gets turned off, and
    // these are that failure, reached through the surface a user reads:
    //
    //   "Basic understanding of the schema is required" -> "Basic [redacted] of the ..."
    //   "Token exchanged successfully"                  -> "Token [redacted] successfully"
    //   "authorization: denied by policy"               -> "authorization: [redacted] by policy"
    //
    // Nothing is leaked; a diagnosis is mangled. Narrowing the patterns is the fix and it
    // trades directly against the leak they exist to stop, so it needs someone to choose,
    // with the corpus in front of them, rather than a coverage commit.
    const mangled = withLog(() =>
      safeMessage(new Error("Basic understanding of the schema is required"), "x"),
    ).result;
    expect(mangled).toBe("Basic [redacted] of the schema is required");

    expect(
      withLog(() => safeMessage(new Error("authorization: denied by policy"), "x")).result,
    ).toBe("authorization: [redacted] by policy");
  });

  it("is NOT idempotent, though its own comment says it is (hazard)", () => {
    // HAZARD (pinned, not fixed). `redact` says "Safe to apply more than once", and it is
    // safe in the sense that matters — nothing is un-redacted, no credential reappears —
    // but it is not idempotent, and the output visibly degrades on every pass.
    //
    // Two patterns overlap on the same text. The vendor-prefix rule replaces the key with
    // the literal "[redacted]", and then the named-secret rule, which runs after it, sees
    // `api_key=` followed by a value and replaces that value too. Its value class excludes
    // `]`, so it consumes "[redacted" and leaves the closing bracket behind:
    //
    //     api_key=sk-live-0123456789abcdef   ->  api_key=[redacted]]
    //     api_key=[redacted]]                ->  api_key=[redacted]]]
    //
    // `safeMessage` is applied at every boundary a message crosses, so a failure that
    // passes through the runner and then the server accumulates a bracket per hop. Nothing
    // leaks; the message gets uglier and the docstring is wrong. Both fixes — anchoring the
    // value class on an already-redacted marker, or making the rules mutually exclusive —
    // change what `redact` produces for text that is already correct today, and `redact` is
    // asserted on elsewhere in this suite. That is a change to make deliberately.
    const once = withLog(() => safeMessage(new Error("api_key=sk-live-0123456789abcdef"), "a"))
      .result;
    expect(once).not.toContain("sk-live-0123456789abcdef");
    expect(once).toBe("api_key=[redacted]]");

    const twice = withLog(() => safeMessage(new Error(once), "b")).result;
    expect(twice).toBe("api_key=[redacted]]]");
  });

  it("never un-redacts on a second pass, which is the half that matters", () => {
    // The property the docstring was reaching for, stated in the form that is true: a
    // message that has already been through `safeMessage` cannot come back out of it
    // carrying anything it was stripped of.
    const secrets = [
      "api_key=sk-live-0123456789abcdef",
      "Authorization: Bearer abcdef0123456789",
      "postgres://app:hunter2@db.internal:5432/praecise",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP",
    ];
    for (const secret of secrets) {
      let message = secret;
      for (let pass = 0; pass < 3; pass++) {
        message = withLog(() => safeMessage(new Error(message), "hop")).result;
      }
      expect(message).toMatch(/redacted/);
      expect(message).not.toContain("sk-live-0123456789abcdef");
      expect(message).not.toContain("abcdef0123456789");
      expect(message).not.toContain("hunter2");
      expect(message).not.toContain("dBjftJeZ4CVP");
    }
  });
});

describe("what is written under the state directory is owner-only", () => {
  it("is owner-only and nothing else — group and other have no bit at all", () => {
    // Asserted as an exact value rather than as "no world bits", because the failure
    // being guarded against is a widening, and 0o750 would pass a looser check while
    // handing the transcript of the business to every account in the group.
    expect(DIR_MODE).toBe(0o700);
    expect(FILE_MODE).toBe(0o600);
    expect(DIR_MODE & 0o077).toBe(0);
    expect(FILE_MODE & 0o077).toBe(0);
  });

  it("gives a directory the execute bit it needs and a file none", () => {
    // A file mode with the execute bit set is a file the framework wrote that the owner
    // can run; a directory without it is a directory nobody can enter.
    expect(DIR_MODE & 0o100).toBe(0o100);
    expect(FILE_MODE & 0o100).toBe(0);
  });

  it("reaches the disk — a run directory and run file are created owner-only", async () => {
    const root = await scratch();
    const store = new RunStore(join(root, "runs"));
    await store.save(run("greet-1"));

    expect((await stat(join(root, "runs"))).mode & 0o777).toBe(DIR_MODE);
    expect((await stat(join(root, "runs", "greet-1.json"))).mode & 0o777).toBe(FILE_MODE);
  });

  it("carries the mode onto a target that already existed and was readable", async () => {
    // This is why FILE_MODE is applied to the TEMP file rather than to the target. The
    // temp file is always freshly created, so it always gets the mode, and the rename
    // replaces the target's inode along with whatever permissions it had. Writing to the
    // target in place would leave a file first created at a default umask exactly as
    // world-readable as it already was.
    const root = await scratch();
    const dir = join(root, "runs");
    await mkdir(dir, { recursive: true });
    const target = join(dir, "greet-2.json");
    await writeFile(target, "{}", "utf8");
    await chmod(target, 0o644);
    expect((await stat(target)).mode & 0o777).toBe(0o644);

    await new RunStore(dir).save(run("greet-2"));
    expect((await stat(target)).mode & 0o777).toBe(FILE_MODE);
  });

  it("does NOT tighten a state directory that already existed (hazard)", async () => {
    // HAZARD (pinned, not fixed). `mkdir(dir, { mode: DIR_MODE })` sets the mode only on
    // directories it CREATES. A `.praecise/runs` that already exists — made by an earlier
    // version, restored from an archive, checked out of a repository, or created by a
    // deployment script — keeps whatever mode it has, forever, and every run written into
    // it is world-listable no matter what this constant says. The files inside are still
    // 0600, so the contents are safe; the run ids, workflow names and timestamps in the
    // filenames are not.
    //
    // The fix is a `chmod` after `mkdir`, and that is a framework silently changing the
    // permissions of a directory an operator configured, possibly one deliberately shared
    // with a sidecar. Worth doing, probably; worth doing on purpose, certainly.
    const root = await scratch();
    const dir = join(root, "runs");
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o755);

    await new RunStore(dir).save(run("greet-3"));

    expect((await stat(dir)).mode & 0o777).toBe(0o755);
    expect((await stat(join(dir, "greet-3.json"))).mode & 0o777).toBe(FILE_MODE);
  });
});
