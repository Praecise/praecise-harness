/**
 * Signed webhooks, as Standard Webhooks defines them.
 *
 * The convention is only worth following exactly: a receiver verifies with a library
 * written against the specification, not against this file. So the first test is the
 * specification's own example, and the rest are the ways a verifier is fooled — an old
 * capture, a changed body, a signature for a different message.
 */
import { describe, expect, it } from "vitest";

import { CLOUDEVENTS_JSON, cloudEvent } from "../src/events.js";
import { deliverWebhook, signWebhook, verifyWebhook } from "../src/webhooks.js";

// The example the Standard Webhooks specification and its reference libraries use.
const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const ID = "msg_p5jXN8AQM9LWM0D4loKWxJek";
const AT = 1614265330;
const BODY = '{"test": 2432232314}';
const SIGNATURE = "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=";

const at = (seconds: number) => () => seconds * 1000;
const headers = (signature: string, timestamp = AT, id = ID) => ({
  "webhook-id": id,
  "webhook-timestamp": String(timestamp),
  "webhook-signature": signature,
});

describe("signing a webhook", () => {
  it("produces the specification's own example signature", () => {
    expect(signWebhook(SECRET, ID, AT, BODY)).toBe(SIGNATURE);
  });

  it("reads a whsec_ secret as base64 and anything else as the string itself", () => {
    const raw = Buffer.from("MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", "base64").toString("latin1");
    // Same key bytes reached two ways would sign alike; a different reading does not.
    expect(signWebhook("plain-secret", ID, AT, BODY)).not.toBe(SIGNATURE);
    expect(signWebhook("plain-secret", ID, AT, BODY)).toBe(signWebhook("plain-secret", ID, AT, BODY));
    expect(raw.length).toBe(24);
    expect(signWebhook("whsec_cGxhaW4tc2VjcmV0", ID, AT, BODY)).toBe(signWebhook("plain-secret", ID, AT, BODY));
  });

  it("signs bytes as it signs the same text", () => {
    expect(signWebhook(SECRET, ID, AT, new TextEncoder().encode(BODY))).toBe(SIGNATURE);
  });

  it("refuses an empty secret, which anyone could sign for", () => {
    expect(() => signWebhook("", ID, AT, BODY)).toThrow(/secret is empty/);
    expect(() => signWebhook("whsec_", ID, AT, BODY)).toThrow(/secret is empty/);
  });
});

describe("verifying a webhook", () => {
  it("accepts the specification's example", () => {
    expect(verifyWebhook(SECRET, headers(SIGNATURE), BODY, { now: at(AT) })).toBe(true);
  });

  it("reads headers whatever their case, and from a Headers object", () => {
    const shouted = { "Webhook-Id": ID, "Webhook-Timestamp": String(AT), "Webhook-Signature": SIGNATURE };
    expect(verifyWebhook(SECRET, shouted, BODY, { now: at(AT) })).toBe(true);
    expect(verifyWebhook(SECRET, new Headers(headers(SIGNATURE)), BODY, { now: at(AT) })).toBe(true);
  });

  it("refuses a body that was changed after signing", () => {
    expect(verifyWebhook(SECRET, headers(SIGNATURE), '{"test": 2432232315}', { now: at(AT) })).toBe(false);
    // Re-serialised JSON is a different string, so it is a different message.
    expect(verifyWebhook(SECRET, headers(SIGNATURE), '{"test":2432232314}', { now: at(AT) })).toBe(false);
  });

  it("refuses a signature moved onto another id or another time", () => {
    expect(verifyWebhook(SECRET, headers(SIGNATURE, AT, "msg_other"), BODY, { now: at(AT) })).toBe(false);
    expect(verifyWebhook(SECRET, headers(SIGNATURE, AT + 1), BODY, { now: at(AT) })).toBe(false);
  });

  it("refuses the wrong secret", () => {
    expect(verifyWebhook("whsec_b3RoZXItc2VjcmV0LW90aGVyLXNlY3JldA==", headers(SIGNATURE), BODY, { now: at(AT) })).toBe(
      false,
    );
  });

  it("refuses a timestamp outside the tolerance, in either direction", () => {
    // Five minutes by default: a capture replayed later has gone stale.
    expect(verifyWebhook(SECRET, headers(SIGNATURE), BODY, { now: at(AT + 300) })).toBe(true);
    expect(verifyWebhook(SECRET, headers(SIGNATURE), BODY, { now: at(AT + 301) })).toBe(false);
    expect(verifyWebhook(SECRET, headers(SIGNATURE), BODY, { now: at(AT - 301) })).toBe(false);
    expect(verifyWebhook(SECRET, headers(SIGNATURE), BODY, { now: at(AT + 301), toleranceSeconds: 600 })).toBe(true);
    expect(verifyWebhook(SECRET, headers(SIGNATURE), BODY, { now: at(AT + 5), toleranceSeconds: 2 })).toBe(false);
  });

  it("refuses a timestamp that is not a plain number of seconds", () => {
    for (const odd of ["", "soon", "1e9", `${AT}.5`, ` ${AT}`]) {
      const sent = { ...headers(SIGNATURE), "webhook-timestamp": odd };
      expect(verifyWebhook(SECRET, sent, BODY, { now: at(AT) })).toBe(false);
    }
  });

  it("accepts several space-separated signatures when any v1 one matches", () => {
    // How a sender rotates a secret: it signs with the old and the new for a while.
    const other = signWebhook("whsec_b3RoZXItc2VjcmV0LW90aGVyLXNlY3JldA==", ID, AT, BODY);
    expect(verifyWebhook(SECRET, headers(`${other} ${SIGNATURE}`), BODY, { now: at(AT) })).toBe(true);
    expect(verifyWebhook(SECRET, headers(`${SIGNATURE} ${other}`), BODY, { now: at(AT) })).toBe(true);
    expect(verifyWebhook(SECRET, headers(`${other} ${other}`), BODY, { now: at(AT) })).toBe(false);
  });

  it("ignores a signature of a scheme it does not check, even with the right bytes", () => {
    const bytes = SIGNATURE.slice("v1,".length);
    expect(verifyWebhook(SECRET, headers(`v1a,${bytes}`), BODY, { now: at(AT) })).toBe(false);
    expect(verifyWebhook(SECRET, headers(bytes), BODY, { now: at(AT) })).toBe(false);
    expect(verifyWebhook(SECRET, headers("v1,"), BODY, { now: at(AT) })).toBe(false);
  });

  it("refuses when a header is missing", () => {
    for (const gone of ["webhook-id", "webhook-timestamp", "webhook-signature"]) {
      const sent: Record<string, string | undefined> = { ...headers(SIGNATURE), [gone]: undefined };
      expect(verifyWebhook(SECRET, sent, BODY, { now: at(AT) })).toBe(false);
    }
  });
});

describe("delivering a webhook", () => {
  const event = cloudEvent("com.praecise.run.done", "/apps/acme", { run: "r1" }, { subject: "r1", id: "evt-1" });
  const target = { url: "https://hooks.test/in", secret: SECRET };

  /** A receiver that answers from a script, and remembers what it was sent. */
  const receiver = (answers: (Response | Error)[]) => {
    const got: { url: string; headers: Record<string, string>; body: string; redirect?: string }[] = [];
    const waits: number[] = [];
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      got.push({
        url: String(input),
        headers: init?.headers as Record<string, string>,
        body: String(init?.body),
        redirect: init?.redirect,
      });
      const next = answers.shift() ?? new Response(null, { status: 200 });
      if (next instanceof Error) throw next;
      return next;
    }) as typeof fetch;
    return { fetch: impl, got, waits, sleep: async (ms: number) => void waits.push(ms) };
  };

  it("posts the event as structured CloudEvents JSON, signed so the receiver can verify it", async () => {
    const to = receiver([]);
    const result = await deliverWebhook(target, event, { fetch: to.fetch, now: at(AT) });

    expect(result).toEqual({ delivered: true, attempts: 1, status: 200 });
    const sent = to.got[0]!;
    expect(sent.url).toBe("https://hooks.test/in");
    expect(sent.headers["content-type"]).toBe(CLOUDEVENTS_JSON);
    expect(sent.headers["webhook-id"]).toBe("evt-1");
    expect(sent.headers["webhook-timestamp"]).toBe(String(AT));
    expect(JSON.parse(sent.body)).toEqual(event);
    expect(verifyWebhook(SECRET, sent.headers, sent.body, { now: at(AT) })).toBe(true);
    // The signature vouches to the configured URL, not to wherever it redirects.
    expect(sent.redirect).toBe("manual");
  });

  it("tries again after a 5xx, a 429 and a network error, under the same id", async () => {
    const to = receiver([
      new Response("busy", { status: 503 }),
      new Response("slow down", { status: 429 }),
      new TypeError("fetch failed"),
      new Response(null, { status: 204 }),
    ]);
    const result = await deliverWebhook(target, event, { fetch: to.fetch, sleep: to.sleep, now: at(AT) });

    expect(result).toEqual({ delivered: true, attempts: 4, status: 204 });
    expect(new Set(to.got.map((sent) => sent.headers["webhook-id"]))).toEqual(new Set(["evt-1"]));
    expect(to.waits).toEqual([500, 1000, 2000]);
  });

  it("stamps each attempt with its own time, so a late retry is not stale on arrival", async () => {
    let clock = AT * 1000;
    const to = receiver([new Response(null, { status: 500 })]);
    await deliverWebhook(target, event, {
      fetch: to.fetch,
      now: () => clock,
      sleep: async (ms) => void (clock += ms + 4000),
    });
    expect(to.got.map((sent) => sent.headers["webhook-timestamp"])).toEqual([String(AT), String(AT + 4)]);
    expect(verifyWebhook(SECRET, to.got[1]!.headers, to.got[1]!.body, { now: () => clock })).toBe(true);
  });

  it("waits as long as Retry-After says, in seconds or as a date", async () => {
    const to = receiver([
      new Response(null, { status: 429, headers: { "retry-after": "3" } }),
      new Response(null, { status: 503, headers: { "retry-after": new Date((AT + 7) * 1000).toUTCString() } }),
    ]);
    const result = await deliverWebhook(target, event, { fetch: to.fetch, sleep: to.sleep, now: at(AT) });
    expect(result.delivered).toBe(true);
    expect(to.waits).toEqual([3000, 7000]);
  });

  it("does not ask twice when the receiver refused the event itself", async () => {
    for (const status of [400, 401, 404, 410, 302]) {
      const to = receiver([new Response(null, { status })]);
      const result = await deliverWebhook(target, event, { fetch: to.fetch, sleep: to.sleep });
      expect(result).toEqual({ delivered: false, attempts: 1, status, error: `the receiver answered ${status}` });
      expect(to.waits).toEqual([]);
    }
  });

  it("gives up after a few attempts and says what the last one came to", async () => {
    const to = receiver(Array.from({ length: 9 }, () => new Response(null, { status: 502 })));
    const result = await deliverWebhook(target, event, { fetch: to.fetch, sleep: to.sleep });
    expect(result).toEqual({ delivered: false, attempts: 4, status: 502, error: "the receiver answered 502" });

    const down = receiver(Array.from({ length: 9 }, () => new TypeError("fetch failed")));
    const lost = await deliverWebhook(target, event, { fetch: down.fetch, sleep: down.sleep, attempts: 2 });
    expect(lost).toEqual({ delivered: false, attempts: 2, error: "fetch failed" });
  });

  it("gives up rather than wait past the time a delivery is given", async () => {
    const to = receiver([new Response(null, { status: 503, headers: { "retry-after": "3600" } })]);
    const result = await deliverWebhook(target, event, { fetch: to.fetch, sleep: to.sleep });
    expect(result.delivered).toBe(false);
    expect(result.attempts).toBe(1);
    expect(result.error).toContain("past the 30s a delivery is given");
    expect(to.waits).toEqual([]);
  });
});
