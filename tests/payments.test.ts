/**
 * A 402 met by the app's payer, once: keyed by the step, status before pay, and
 * a crash between paying and recording recovered without a second payment.
 */

import { afterEach, describe, expect, it } from "vitest";

import { App } from "../src/app.js";
import { payingFetch, withPaymentKey, type Payer, type PaymentStatus } from "../src/payments.js";
import { MODEL_ENV, TEST_ENDPOINT, cleanup, FRAMEWORK, makeProject } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(cleanup)));

/** A ledger of settled payments, by key. */
function ledgerPayer(): Payer & { paid: string[]; settled: Map<string, string> } {
  const settled = new Map<string, string>();
  const paid: string[] = [];
  return {
    paid,
    settled,
    async pay(required, key) {
      expect(required.headers["x-price"]).toBe("3");
      paid.push(key);
      settled.set(key, `receipt-${paid.length}`);
      return { headers: { "x-payment": `receipt-${paid.length}` }, proof: `receipt-${paid.length}` };
    },
    async status(key): Promise<PaymentStatus> {
      const receipt = settled.get(key);
      return receipt ? { state: "settled", headers: { "x-payment": receipt }, proof: receipt } : { state: "absent" };
    },
  };
}

/** A server that wants payment unless a receipt is presented. */
const server: typeof fetch = async (_input, init) => {
  const receipt = new Headers(init?.headers).get("x-payment");
  return receipt
    ? new Response(JSON.stringify({ data: "ok", receipt }), { status: 200 })
    : new Response("pay me", { status: 402, headers: { "x-price": "3" } });
};

describe("a paying fetch", () => {
  it("pays a 402 inside a keyed scope and retries with the proof", async () => {
    const payer = ledgerPayer();
    const paying = payingFetch(server, payer);
    const { value, payments } = await withPaymentKey("step-1", async () => (await paying("https://api.example/x")).json());
    expect(value).toEqual({ data: "ok", receipt: "receipt-1" });
    expect(payments).toMatchObject([{ reused: false, proof: "receipt-1" }]);
  });

  it("reuses a settled payment for the same key instead of paying twice", async () => {
    const payer = ledgerPayer();
    const paying = payingFetch(server, payer);
    await withPaymentKey("step-1", () => paying("https://api.example/x"));
    const again = await withPaymentKey("step-1", () => paying("https://api.example/x"));
    expect(payer.paid).toHaveLength(1);
    expect(again.payments).toMatchObject([{ reused: true }]);
  });

  it("returns the 402 unpaid outside a keyed scope", async () => {
    const payer = ledgerPayer();
    const res = await payingFetch(server, payer)("https://api.example/x");
    expect(res.status).toBe(402);
    expect(payer.paid).toHaveLength(0);
  });

  it("refuses to pay while a payment under the key is pending", async () => {
    const payer: Payer = { pay: async () => ({ headers: {} }), status: async () => ({ state: "pending" }) };
    await expect(withPaymentKey("k", () => payingFetch(server, payer)("https://api.example/x"))).rejects.toThrow(/pending/);
  });
});

describe("a workflow step that pays", () => {
  it("pays once across a crash between paying and recording", async () => {
    const root = await makeProject({
      "praecise.config.ts": `import { defineConfig } from "${FRAMEWORK}";
        export default defineConfig({ name: "acme", ${TEST_ENDPOINT} });`,
      "functions/buy.ts": `import { fn } from "${FRAMEWORK}";
        let crash = true;
        export default fn({
          description: "Buy the report.",
          effect: "write",
          run: async (_args, opts) => {
            const res = await opts.fetch("https://api.example/report");
            const body = await res.json();
            if (crash) { crash = false; throw new Error("process died"); }
            return body;
          },
        });`,
      "workflows/buy.ts": `import { workflow } from "${FRAMEWORK}";
        export default workflow({ description: "Buy.", steps: [{ id: "buy", use: "buy" }] });`,
    });
    roots.push(root);
    const payer = ledgerPayer();
    const app = await App.load({ root, env: MODEL_ENV, fetch: server, payer });

    const failed = await app.startWorkflow("buy", {});
    expect(failed.status).toBe("failed");
    expect(payer.paid).toHaveLength(1);

    // The failed attempt left its inflight marker; recovery retries under the same key.
    const stored = (await app.runs.load(failed.id))!;
    stored.status = "running";
    await app.runs.save(stored);
    const done = await app.recoverWorkflow(failed.id, { retryInflight: true });
    expect(done.status).toBe("done");
    expect(done.outputs.buy).toEqual({ data: "ok", receipt: "receipt-1" });
    expect(payer.paid).toHaveLength(1);
    await app.close();
  });
});
