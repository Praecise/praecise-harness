/**
 * Whether a backend actually behaves like one.
 *
 * A `Driver` is a short interface, which makes it look easy to write and is the
 * reason it is not. Most of what a store promises is not in the type: that a
 * redacted row keeps its place and its timestamp, that clearing what it said
 * also clears the vector it could still be found by, that a negative limit
 * means the whole window, that handing a row back does not hand over the row
 * itself. A driver can satisfy the compiler completely and get every one of
 * those wrong, and nothing would say so until an agent recalled something that
 * was supposed to have been taken back.
 *
 * So the promises are written down as checks anyone can run. Point this at a
 * driver and it answers in the same terms the documentation is written in.
 * Failures name what was expected rather than what was compared, because the
 * person reading them is holding a half-written backend, not this file.
 *
 * This is not a test framework and does not need one. It returns a list, so it
 * can run in a test, in a script, or on a machine that has just been handed a
 * connection string and would like to know before anything is trusted to it.
 */

import { Kept } from "./store.js";
import type { ConnectOptions, Driver, Keep } from "./types.js";

/** One promise a store makes, and whether this backend keeps it. */
export interface Promised {
  /** The promise, phrased as the promise rather than as the comparison. */
  name: string;
  ok: boolean;
  /** What went wrong, or why nothing was checked. */
  why?: string;
  /** Set when the backend says it cannot do this, so nothing was checked. */
  skipped?: boolean;
}

export interface Conformance {
  driver: string;
  ok: boolean;
  checks: Promised[];
}

/** The width of the vectors this suite makes up when a backend holds them. */
const WIDTH = 4;

function must(condition: unknown, said: string): asserts condition {
  if (!condition) throw new Error(said);
}

/** Readable in a failure, and different every run so a rerun is a clean one. */
let counter = 0;
const scopeFor = (what: string): string => `conform-${what}-${counter++}-${Date.now()}`;

export async function conform(driver: Driver, options: ConnectOptions): Promise<Conformance> {
  const checks: Promised[] = [];
  const check = async (name: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
      checks.push({ name, ok: true });
    } catch (error) {
      checks.push({ name, ok: false, why: (error as Error).message });
    }
  };
  const skip = (name: string, why: string): void => {
    checks.push({ name, ok: true, skipped: true, why });
  };

  const connection = await driver.connect({ dimensions: WIDTH, ...options });
  const can = connection.capabilities;

  try {
    await check("installs, and installing again changes nothing", async () => {
      await connection.install();
      await connection.install();
    });

    const store = new Kept(driver.name, can.vectors ? "vector" : "sql", connection);

    /** A store scoped to one check, so checks cannot see each other's rows. */
    const put = async (what: string, items: Keep[]): Promise<{ scope: string }> => {
      const scope = scopeFor(what);
      await store.remember(items.map((item) => ({ ...item, scope })));
      return { scope };
    };

    await check("keeps what it is given, and gives it back unchanged", async () => {
      const { scope } = await put("round-trip", [
        { text: "a thing worth keeping", meta: { note: "kept" }, at: 1_000 },
      ]);
      const [kept] = await store.history({ scope });
      must(kept, "nothing came back from a store that had just been written to");
      must(kept.text === "a thing worth keeping", "the text that came back is not the text put in");
      must(kept.at === 1_000, "the time it happened was not the time it was given");
      must(kept.meta?.note === "kept", "the metadata did not survive the round trip");
    });

    await check("hands back the newest first", async () => {
      const { scope } = await put("order", [
        { text: "first", at: 1_000 },
        { text: "second", at: 2_000 },
        { text: "third", at: 3_000 },
      ]);
      const seen = (await store.history({ scope })).map((item) => item.text);
      must(
        seen.join() === "third,second,first",
        `history is meant to be newest first, and came back ${seen.join()}`,
      );
    });

    await check("narrows to one scope and shows nothing of another", async () => {
      const mine = await put("scope-mine", [{ text: "mine", at: 1_000 }]);
      const theirs = await put("scope-theirs", [{ text: "theirs", at: 1_000 }]);
      const seen = await store.history({ scope: mine.scope });
      must(seen.length === 1, `one row was in this scope and ${seen.length} came back`);
      must(seen[0]?.text === "mine", "a row from another scope came back");
      must((await store.history({ scope: theirs.scope })).length === 1, "the other scope lost a row");
    });

    await check("narrows to what one writer wrote", async () => {
      const scope = scopeFor("writers");
      await store.as("one").remember({ text: "by one", scope, at: 1_000 });
      await store.as("two").remember({ text: "by two", scope, at: 2_000 });
      const seen = await store.history({ scope, by: "one" });
      must(seen.length === 1, `one row was written by "one" and ${seen.length} came back`);
      must(seen[0]?.by === "one", "the row that came back is marked as somebody else's");
    });

    await check("marks a row with whoever wrote it, and nothing else can", async () => {
      const scope = scopeFor("attribution");
      // `by` is not part of what a caller may hand over. Passed anyway, it must
      // not arrive: attribution that can be written by whatever is being
      // attributed is not attribution.
      await store.as("the agent").remember({ text: "said", scope, by: "somebody else" } as Keep);
      await store.remember({ text: "unsigned", scope });
      const rows = await store.history({ scope });
      const signed = rows.find((row) => row.text === "said");
      const unsigned = rows.find((row) => row.text === "unsigned");
      must(signed?.by === "the agent", "the writer is not who the store was speaking as");
      must(unsigned?.by === undefined, "a row nobody wrote came back marked as somebody's");
    });

    await check("narrows to what happened since a time", async () => {
      const { scope } = await put("since", [
        { text: "old", at: 1_000 },
        { text: "new", at: 9_000 },
      ]);
      const seen = await store.history({ scope, since: 5_000 });
      must(seen.length === 1, `one row is newer than the cut and ${seen.length} came back`);
      must(seen[0]?.text === "new", "the row from before the cut came back");
    });

    await check("gives no more than it was asked for", async () => {
      const { scope } = await put("limit", [
        { text: "one", at: 1_000 },
        { text: "two", at: 2_000 },
        { text: "three", at: 3_000 },
      ]);
      const seen = await store.history({ scope, limit: 2 });
      must(seen.length === 2, `two were asked for and ${seen.length} came back`);
    });

    await check("keeping the same id twice replaces rather than doubles", async () => {
      const scope = scopeFor("upsert");
      const [id] = await store.remember({ text: "as written", scope, at: 1_000 });
      await store.remember({ id, text: "as corrected", scope, at: 1_000 });
      const seen = await store.history({ scope });
      must(seen.length === 1, `writing one id twice left ${seen.length} rows`);
      must(seen[0]?.text === "as corrected", "the correction did not replace what was there");
    });

    await check("carries a batch bigger than one statement can hold", async () => {
      // The store breaks a batch up to fit; a driver that cannot be given a
      // second chunk loses everything after the first.
      const many = Math.max(2, Math.floor(can.maxBindValues / 6)) * 2 + 1;
      const scope = scopeFor("batch");
      await store.remember(
        Array.from({ length: many }, (_, index) => ({
          text: `row ${index}`,
          scope,
          at: 1_000 + index,
        })),
      );
      const seen = await store.history({ scope, limit: many + 10 });
      must(seen.length === many, `${many} rows went in and ${seen.length} came back`);
    });

    await check("forgets what it is asked to, and says how many went", async () => {
      const { scope } = await put("forget", [
        { text: "one", at: 1_000 },
        { text: "two", at: 2_000 },
      ]);
      const went = await store.forget({ scope });
      must(went === 2, `two rows were there and forgetting answered ${went}`);
      must((await store.history({ scope })).length === 0, "something survived being forgotten");
    });

    await check("finds by text what contains the words", async () => {
      const { scope } = await put("search", [
        { text: "the refund policy for damaged goods", at: 1_000 },
        { text: "opening hours over the holidays", at: 2_000 },
      ]);
      const found = await store.search("refund policy", { scope });
      must(found.length > 0, "searching for words that are in the store found nothing");
      must(
        found[0]?.text.includes("refund"),
        "the best match for these words is not the row containing them",
      );
    });

    await check("a redaction leaves the row where it was", async () => {
      const scope = scopeFor("redact-place");
      const [id] = await store.remember({
        text: "the account number is 1234",
        scope,
        at: 1_000,
        meta: { seen: "yes" },
      });
      const went = await store.redact({ scope, id }, "[taken back]");
      must(went === 1, `one row was taken back and redacting answered ${went}`);

      const [after] = await store.history({ scope });
      must(after, "a redacted row is meant to stay in the record, and it is not there");
      must(after.id === id, "the row that came back is not the row that was taken back");
      must(after.at === 1_000, "taking a row back moved when it happened");
      must(after.text === "[taken back]", "the row still says what it was taken back for saying");
      must(after.redactedAt !== undefined, "nothing on the row says it was taken back");
      must(after.meta === undefined, "the metadata survived a redaction that cleared the text");
    });

    await check("a redacted row never answers a question again", async () => {
      const scope = scopeFor("redact-recall");
      await store.remember({ text: "the passphrase is hunter", scope, at: Date.now() });
      await store.redact({ scope }, "[taken back]");
      const found = await store.recall("passphrase hunter", { scope });
      must(found.length === 0, "a row that was taken back came back from recall");
      must(
        (await store.search("passphrase", { scope })).length === 0,
        "a row that was taken back came back from search",
      );
    });

    await check("does not hand over the row it is holding", async () => {
      // A caller editing what it was given must not be a way of editing the
      // store. Every backend that crosses a socket gets this for free, and one
      // that does not is the only place where reading is a way of writing.
      const { scope } = await put("aliasing", [{ text: "as written", at: 1_000 }]);
      const [handed] = await store.history({ scope });
      must(handed, "nothing came back to try this on");
      handed.text = "as tampered with";
      if (handed.meta) handed.meta.injected = true;
      const [again] = await store.history({ scope });
      must(again?.text === "as written", "editing a row that was handed over edited the store");
    });

    await check("undoes a transaction that did not finish", async () => {
      const scope = scopeFor("transaction");
      await connection
        .transaction(async () => {
          await connection.put([{ id: "half-done", text: "half done", scope, at: 1_000 }], [
            undefined,
          ]);
          throw new Error("stopped halfway");
        })
        .catch(() => undefined);
      const seen = await store.history({ scope });
      must(seen.length === 0, "a write from a transaction that failed is still there");
    });

    if (can.vectors) {
      await check("orders by distance when asked with a vector", async () => {
        // Nothing here is the opposite of anything else. A cosine of -1 reads
        // as a score of zero, and a row scoring zero is dropped as no match at
        // all — which would look like a backend that lost a row.
        const scope = scopeFor("vectors");
        await store.remember([
          { text: "near", scope, at: Date.now(), vector: [1, 0, 0, 0] },
          { text: "far", scope, at: Date.now(), vector: [0, 1, 0, 0] },
        ]);
        const found = await store.recall([1, 0, 0, 0], { scope });
        must(found.length === 2, `two rows hold vectors and ${found.length} came back`);
        must(found[0]?.text === "near", "the nearest vector is not the one that came back first");
      });

      await check("a redaction clears the vector along with the text", async () => {
        // A row that can still be found by what it used to say has not been
        // taken back, whatever its text now reads. This one is asked of the
        // backend rather than of the store, because the store drops anything
        // redacted before a caller sees it — which would hide a vector still
        // sitting there, waiting for the day something reads it directly.
        const scope = scopeFor("redact-vector");
        const [id] = await store.remember({
          text: "secret",
          scope,
          at: Date.now(),
          vector: [1, 0, 0, 0],
        });
        await store.redact({ scope }, "[taken back]");
        const near = await connection.near([1, 0, 0, 0], { scope, limit: -1 });
        must(
          !near.some((row) => row.id === id),
          "a row taken back is still findable by the vector it was kept with",
        );
      });
    } else {
      skip("orders by distance when asked with a vector", "this backend holds no vectors");
      skip("a redaction clears the vector along with the text", "this backend holds no vectors");

      await check("says so plainly when asked for something it cannot do", async () => {
        const refused = await store
          .remember({ text: "with a vector", vector: [1, 0, 0, 0] })
          .then(() => undefined)
          .catch((error: unknown) => error as Error);
        must(refused, "a backend that holds no vectors accepted one instead of saying it cannot");
      });
    }
  } finally {
    await connection.close().catch(() => undefined);
  }

  return { driver: driver.name, ok: checks.every((one) => one.ok), checks };
}

/** The same answer, for somebody reading rather than something asserting. */
export function conformanceReport(result: Conformance): string {
  const lines = result.checks.map((one) => {
    if (one.skipped) return `  – ${one.name} (${one.why})`;
    return one.ok ? `  ✓ ${one.name}` : `  ✗ ${one.name}\n      ${one.why ?? ""}`;
  });
  const failed = result.checks.filter((one) => !one.ok).length;
  const head = result.ok
    ? `${result.driver}: behaves like a store`
    : `${result.driver}: ${failed} of ${result.checks.length} promises not kept`;
  return [head, ...lines].join("\n");
}
