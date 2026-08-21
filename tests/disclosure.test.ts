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
import { redact, safeMessage } from "../src/redact.js";
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

  it("reads the message off a thrown object rather than saying [object Object]", () => {
    // A thrown plain object used to stringify as "[object Object]", so an error shaped
    // like `{ message: "..." }` — which is what a structured clone of an Error from a
    // worker or off a message port looks like — reached the caller with no information at
    // all. Failing safe, but failing blind.
    const cloned = { message: "the store rejected the write: disk full" };
    const { result, logged } = withLog(() => safeMessage(cloned, "save"));
    expect(result).toBe("the store rejected the write: disk full");
    expect(logged[0]?.[1]).toBe(cloned);
  });

  it("redacts what it reads off one, so reading it widens what may be SAID and not leaked", () => {
    const cloned = { message: "connect failed: postgres://app:hunter2@db.internal/prod" };
    const { result } = withLog(() => safeMessage(cloned, "save"));
    expect(result).not.toContain("hunter2");
    expect(result).toContain("[redacted]");
    expect(result).toContain("db.internal");
  });

  it("takes only a string message — anything else still stringifies", () => {
    // The narrowness is the point: `message` is read when it is text, not whenever it
    // exists, so an object carrying a `message` object does not get `String`-ed into the
    // reply by a different route.
    expect(withLog(() => safeMessage({ message: { code: 42 } }, "x")).result).toBe(
      "[object Object]",
    );
  });

  it("leaves ordinary prose that opens with an auth keyword alone", () => {
    // `redact` anchors on how a secret is INTRODUCED — `Bearer `, `Token `,
    // `authorization:` — and English uses those words too, so it used to mangle the
    // diagnosis it was supposed to be delivering:
    //
    //   "Basic understanding of the schema is required" -> "Basic [redacted] of the ..."
    //   "Token exchanged successfully"                  -> "Token [redacted] successfully"
    //   "authorization: denied by policy"               -> "authorization: [redacted] by policy"
    //
    // The module's own comment says a redactor that eats ordinary text gets turned off,
    // and a redactor that is off leaks everything it would ever have caught. So this is
    // not a cosmetic failure. The four lead-ins that are also English words now require
    // what follows to be unwordlike; see the test below, which is the other half.
    for (const prose of [
      "Basic understanding of the schema is required",
      "Token exchanged successfully",
      "authorization: denied by policy",
      "Bearer instruments are not supported",
      "authorization = pending review",
    ]) {
      expect(withLog(() => safeMessage(new Error(prose), "x")).result).toBe(prose);
    }
  });

  it("still catches every real credential shape behind those same words", () => {
    // The half that must not be traded away. Narrowing the patterns to spare prose is
    // only allowed because none of these stops matching: hex has digits, base64 has
    // capitals inside it, a vendor key has a separator, and a long run of letters is
    // long. If a change to `redact` makes the test above pass by making this one fail,
    // it has made the framework leak.
    const secrets: [string, string][] = [
      ["Authorization: Bearer abcdef0123456789", "abcdef0123456789"],
      ["Authorization: Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNzd29yZA"],
      ["authorization: QQQQ2222WWWW8888", "QQQQ2222WWWW8888"],
      ["Token sk-live-0123456789abcdef", "sk-live-0123456789abcdef"],
      ["bearer abcdefghijklmnopqrstuvwxyz", "abcdefghijklmnopqrstuvwxyz"],
      ["api_key=correcthorsebatterystaple", "correcthorsebatterystaple"],
      ["password: hunter2", "hunter2"],
      ["password: swordfish", "swordfish"],
    ];
    for (const [message, secret] of secrets) {
      const { result } = withLog(() => safeMessage(new Error(message), "x"));
      expect(result, message).not.toContain(secret);
      expect(result, message).toContain("[redacted]");
    }
  });

  it("is idempotent, which is what its comment now claims", () => {
    // It used to say "Safe to apply more than once" and mean only that nothing is
    // un-redacted. Two patterns overlapped on the same text: the vendor-prefix rule wrote
    // the literal "[redacted]", and the named-secret rule, running after it, saw
    // `api_key=` followed by a value and took that too. Its value class excluded `]` but
    // not `[`, so it consumed "[redacted" and left the closing bracket:
    //
    //     api_key=sk-live-0123456789abcdef   ->  api_key=[redacted]]
    //     api_key=[redacted]]                ->  api_key=[redacted]]]
    //
    // `safeMessage` runs at every boundary a message crosses, so a failure that passed
    // through the runner and then the server accumulated a bracket per hop. The value
    // class excludes both brackets now, so nothing any rule writes is matched by any rule.
    const once = withLog(() => safeMessage(new Error("api_key=sk-live-0123456789abcdef"), "a"))
      .result;
    expect(once).not.toContain("sk-live-0123456789abcdef");
    expect(once).toBe("api_key=[redacted]");

    const twice = withLog(() => safeMessage(new Error(once), "b")).result;
    expect(twice).toBe(once);
  });

  it("is idempotent for every shape it knows, not only the one that was broken", () => {
    for (const secret of [
      "api_key=sk-live-0123456789abcdef",
      "Authorization: Bearer abcdef0123456789",
      "postgres://app:hunter2@db.internal:5432/praecise",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP",
      'AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE, password: hunter2',
      "authorization: QQQQ2222WWWW8888",
    ]) {
      const once = redact(secret);
      expect(redact(once), secret).toBe(once);
      expect(redact(redact(once)), secret).toBe(once);
    }
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
