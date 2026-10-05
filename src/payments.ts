/**
 * Paying for a request that answers 402, exactly once.
 *
 * The app's injected fetch is the one way out to the network, so it is also the
 * one place a "payment required" can be met. With a payer configured, a 402 is
 * handed to it with an idempotency key; the payer settles and says which headers
 * prove it, and the request is sent again carrying them.
 *
 * The key is what makes it once. Inside a workflow step it is derived from the
 * step's own idempotency key and the request, so the same step retried after a
 * crash presents the same key: the payer is asked for the key's status first,
 * and a payment that already settled is reused rather than made again.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

/** What a server said when it asked to be paid. */
export interface PaymentRequired {
  url: string;
  method: string;
  /** The 402 response's headers, lower-cased. */
  headers: Record<string, string>;
  /** The 402 response's body, as text. */
  body: string;
}

/** Headers that prove payment, to send with the retried request, plus anything worth recording. */
export interface Paid {
  headers: Record<string, string>;
  proof?: unknown;
}

export type PaymentStatus = ({ state: "settled" } & Paid) | { state: "pending" } | { state: "absent" };

export interface Payer {
  /** Settle what the server asked for, under `key`. Called only after `status(key)` said absent. */
  pay(required: PaymentRequired, key: string): Promise<Paid>;
  /** What happened to the payment made under `key`, if any. */
  status(key: string): Promise<PaymentStatus>;
}

/** One record per payment the fetch made or reused, for the journal and the caller. */
export interface PaymentRecord {
  key: string;
  url: string;
  reused: boolean;
  proof?: unknown;
}

interface Scope {
  key: string;
  payments: PaymentRecord[];
}

const scope = new AsyncLocalStorage<Scope>();

/**
 * Run `work` with `key` as the idempotency key any 402 inside it pays under.
 * Answers with what it returned and the payments made or reused while it ran.
 */
export async function withPaymentKey<T>(key: string, work: () => Promise<T>): Promise<{ value: T; payments: PaymentRecord[] }> {
  const payments: PaymentRecord[] = [];
  const value = await scope.run({ key, payments }, work);
  return { value, payments };
}

function keyFor(base: string, method: string, url: string): string {
  return createHash("sha256").update(`${base}\n${method}\n${url}`).digest("hex");
}

/**
 * A fetch that meets a 402 by paying. Outside a keyed scope a 402 is returned
 * as it came: there is no key to make the payment once with, and paying without
 * one could pay twice.
 */
export function payingFetch(base: typeof fetch, payer: Payer): typeof fetch {
  return async (input, init) => {
    const first = await base(input, init);
    if (first.status !== 402) return first;
    const current = scope.getStore();
    if (!current) return first;

    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const key = keyFor(current.key, method, url);

    const known = await payer.status(key);
    let paid: Paid;
    if (known.state === "settled") {
      paid = known;
      current.payments.push({ key, url, reused: true, proof: known.proof });
    } else if (known.state === "pending") {
      throw new Error(`payment ${key} for ${method} ${url} is still pending; retry once it settles`);
    } else {
      const headers: Record<string, string> = {};
      first.headers.forEach((value, name) => (headers[name.toLowerCase()] = value));
      paid = await payer.pay({ url, method, headers, body: await first.text() }, key);
      current.payments.push({ key, url, reused: false, proof: paid.proof });
    }

    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    for (const [name, value] of Object.entries(paid.headers)) headers.set(name, value);
    const again = await base(input, { ...init, headers });
    if (again.status === 402) {
      throw new Error(`${method} ${url} still asks for payment after payment ${key} was presented`);
    }
    return again;
  };
}
