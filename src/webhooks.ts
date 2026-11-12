/**
 * Telling somebody else, in the convention they already verify.
 *
 * A webhook is a POST the receiver has no reason to believe. Standard Webhooks is the
 * convention for making it believable — an id, a timestamp and an HMAC over both and
 * the body — and it is the one the receiver's libraries already check, so nothing here
 * is a scheme of this framework's own:
 *
 *   webhook-id         the event's id, the same on every retry, so a receiver can dedupe
 *   webhook-timestamp  unix seconds, so an old capture cannot be replayed later
 *   webhook-signature  `v1,` + base64(HMAC-SHA256(secret, `${id}.${timestamp}.${body}`))
 *
 * The body is signed as the bytes that were sent. A receiver must verify the raw body
 * before parsing it: JSON re-serialised is a different string and a different signature.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { CLOUDEVENTS_JSON, type CloudEvent } from "./events.js";

/** Somewhere a signed webhook is sent. */
export interface WebhookTarget {
  url: string;
  /** The shared secret: `whsec_<base64>` as Standard Webhooks writes it, or the raw string. */
  secret: string;
  /**
   * The event types to send. Absent ⇒ all of them. A full type
   * (`com.praecise.run.waiting`) or its last segment (`waiting`).
   */
  events?: string[];
}

/** What became of one delivery. Never thrown: a delivery that fails is a fact to record. */
export interface WebhookDelivery {
  delivered: boolean;
  /** How many requests were made. */
  attempts: number;
  /** The last status the receiver answered with, when it answered at all. */
  status?: number;
  /** Why the last attempt did not count, when the delivery failed. */
  error?: string;
}

export interface DeliverWebhookOptions {
  fetch?: typeof fetch;
  /** Requests made before giving up. Default 4. */
  attempts?: number;
  /** The longest the whole delivery may take, waits included. Default 30 seconds. */
  budgetMs?: number;
  /** The longest one request may take. Default 10 seconds. */
  timeoutMs?: number;
  /** Stops the delivery, between or during attempts. */
  signal?: AbortSignal;
  /** The clock and the wait, so a test does not have to sit through a backoff. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const PREFIX = "whsec_";

/** The key a secret stands for: the bytes after `whsec_`, or the string itself. */
function keyOf(secret: string): Buffer {
  const key = secret.startsWith(PREFIX)
    ? Buffer.from(secret.slice(PREFIX.length), "base64")
    : Buffer.from(secret, "utf8");
  if (!key.length) {
    throw new Error(
      "the webhook secret is empty, so anyone could sign for it. Set it to `whsec_` followed by base64 of at least 24 random bytes.",
    );
  }
  return key;
}

function digest(secret: string, id: string, timestamp: number, body: string | Uint8Array): Buffer {
  return createHmac("sha256", keyOf(secret)).update(`${id}.${timestamp}.`).update(body).digest();
}

/** The `webhook-signature` value for one message: `v1,<base64>`. `timestamp` is unix seconds. */
export function signWebhook(secret: string, id: string, timestamp: number, body: string | Uint8Array): string {
  return `v1,${digest(secret, id, timestamp, body).toString("base64")}`;
}

/**
 * Whether a received webhook was signed with this secret, recently.
 *
 * `body` is the raw request body, exactly as it arrived. True only when the id,
 * timestamp and signature headers are all present, the timestamp is within the
 * tolerance of now in either direction, and one of the `v1` signatures matches. The
 * header may carry several, space-separated, which is how a sender rotates a secret
 * without a receiver missing a delivery.
 */
export function verifyWebhook(
  secret: string,
  headers: Headers | Record<string, string | string[] | undefined>,
  body: string | Uint8Array,
  options: { toleranceSeconds?: number; now?: () => number } = {},
): boolean {
  const id = headerOf(headers, "webhook-id");
  const sent = headerOf(headers, "webhook-timestamp");
  const signatures = headerOf(headers, "webhook-signature");
  if (!id || !sent || !signatures) return false;

  // Digits only: `Number` would read "1e9" or " 12 " as a time, and the signed string
  // is the header as sent.
  if (!/^\d{1,15}$/.test(sent)) return false;
  const timestamp = Number(sent);
  const tolerance = options.toleranceSeconds ?? 300;
  const now = Math.floor((options.now?.() ?? Date.now()) / 1000);
  if (Math.abs(now - timestamp) > tolerance) return false;

  const expected = digest(secret, id, timestamp, body);
  let matched = false;
  for (const candidate of signatures.split(" ")) {
    const comma = candidate.indexOf(",");
    if (comma < 0 || candidate.slice(0, comma) !== "v1") continue;
    const offered = Buffer.from(candidate.slice(comma + 1), "base64");
    // Every candidate is compared, and in constant time, so how long this takes says
    // nothing about which one matched or how nearly.
    if (offered.length === expected.length && timingSafeEqual(offered, expected)) matched = true;
  }
  return matched;
}

function headerOf(headers: Headers | Record<string, string | string[] | undefined>, name: string): string | undefined {
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined;
  for (const [key, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (key.toLowerCase() === name) return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

/** How long a receiver asked to be left alone: `Retry-After` as seconds or as a date. */
function retryAfter(response: Response, now: number): number | undefined {
  const said = response.headers.get("retry-after")?.trim();
  if (!said) return undefined;
  if (/^\d+$/.test(said)) return Number(said) * 1000;
  const at = Date.parse(said);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/**
 * Send one event as a signed webhook, trying again where trying again can help.
 *
 * The body is the CloudEvent as structured JSON. A network error, a 5xx, a 429 or a 408
 * is retried with a doubling wait, or the wait the receiver named in `Retry-After`; any
 * other refusal is the receiver's answer and is not asked twice. The id is the same on
 * every attempt and the timestamp is each attempt's own, so a retry is neither a
 * duplicate to the receiver nor stale by the time it lands.
 *
 * Redirects are not followed: the signature vouches for the event to the URL that was
 * configured, not to wherever that URL points today.
 */
export async function deliverWebhook(
  target: Pick<WebhookTarget, "url" | "secret">,
  event: CloudEvent,
  options: DeliverWebhookOptions = {},
): Promise<WebhookDelivery> {
  const send = options.fetch ?? fetch;
  const most = Math.max(1, options.attempts ?? 4);
  const budget = options.budgetMs ?? 30_000;
  const timeout = options.timeoutMs ?? 10_000;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));

  const body = JSON.stringify(event);
  const began = now();
  let attempts = 0;
  let status: number | undefined;
  let error: string | undefined;

  while (attempts < most) {
    if (options.signal?.aborted) {
      error = "the delivery was stopped";
      break;
    }
    attempts += 1;
    const timestamp = Math.floor(now() / 1000);
    let wait = 500 * 2 ** (attempts - 1);

    try {
      const limit = AbortSignal.timeout(timeout);
      const response = await send(target.url, {
        method: "POST",
        headers: {
          "content-type": CLOUDEVENTS_JSON,
          "webhook-id": event.id,
          "webhook-timestamp": String(timestamp),
          "webhook-signature": signWebhook(target.secret, event.id, timestamp, body),
        },
        body,
        redirect: "manual",
        signal: options.signal ? AbortSignal.any([limit, options.signal]) : limit,
      });
      status = response.status;
      // Nothing in the answer is used; left unread it would hold the connection.
      await response.body?.cancel().catch(() => undefined);
      if (response.ok) return { delivered: true, attempts, status };

      error = `the receiver answered ${status}`;
      if (status < 500 && status !== 429 && status !== 408) break;
      wait = retryAfter(response, now()) ?? wait;
    } catch (err) {
      status = undefined;
      const cause = (err as { cause?: { code?: unknown } }).cause?.code;
      error = `${(err as Error).message}${typeof cause === "string" ? ` (${cause})` : ""}`;
    }

    if (attempts >= most) break;
    if (now() - began + wait > budget) {
      error = `${error}; the next attempt was ${Math.ceil(wait / 1000)}s away, past the ${Math.ceil(budget / 1000)}s a delivery is given`;
      break;
    }
    await sleep(wait);
  }

  return { delivered: false, attempts, ...(status === undefined ? {} : { status }), error };
}
