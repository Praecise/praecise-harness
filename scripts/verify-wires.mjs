/**
 * One real call per wire, because everything else in this repo is a fake.
 *
 * The five wire adapters — `messages`, `chat`, `contents`, `responses`, `interactions` —
 * were each written from a vendor's documentation and are tested against a stub `fetch`
 * that answers whatever the test decided it should. That proves the adapter is
 * self-consistent. It cannot prove the adapter is RIGHT: a field named one level too deep,
 * a parameter renamed in a recent revision, a response read from a key that no longer
 * exists — every one of those passes the whole suite and fails on the first real call.
 *
 * This is the smallest thing that closes that gap. It makes one minimal request per
 * provider you have a key for, and reports which wires are confirmed against a live
 * endpoint and which are still only confirmed against our own assumptions.
 *
 * ── What it costs ─────────────────────────────────────────────────────────────
 *
 * One request per configured provider, capped at a handful of output tokens, asking for
 * a single word. At current prices this is a fraction of a cent in total. It is not free,
 * so it does not run as part of the test suite and nothing runs it automatically.
 *
 * ── How to read a failure ─────────────────────────────────────────────────────
 *
 * The distinction the report draws is the one that matters:
 *
 *   NO KEY      nothing was tried; this wire remains unverified
 *   AUTH        the key was refused. The wire is untested, not broken — check the key
 *   BAD MODEL   the wire reached the provider and the provider does not have that model.
 *               The adapter is probably fine; pass a current id via the env var named.
 *   WIRE        the request was rejected or the reply could not be read. THIS is the
 *               case this script exists for — the adapter and the endpoint disagree.
 *   OK          a real endpoint accepted our request and we read its answer
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... OPENAI_API_KEY=... node scripts/verify-wires.mjs
 */

import { adapterFor, knownWires } from "../dist/harness/wire/index.js";

/**
 * The providers this can check, and how each is reached.
 *
 * Model ids are the most perishable thing here — they change on someone else's schedule —
 * so every one is overridable, and "the provider has never heard of that model" is
 * reported as its own outcome rather than as a wire fault. A stale default id must not
 * look like a broken adapter.
 */
const PROVIDERS = [
  {
    name: "anthropic",
    wire: "messages",
    credential: "ANTHROPIC_API_KEY",
    baseUrl: "https://api.anthropic.com",
    model: process.env.PRAECISE_ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
    modelEnv: "PRAECISE_ANTHROPIC_MODEL",
  },
  {
    name: "openai (chat)",
    wire: "chat",
    credential: "OPENAI_API_KEY",
    baseUrl: "https://api.openai.com/v1",
    model: process.env.PRAECISE_OPENAI_MODEL ?? "gpt-4o-mini",
    modelEnv: "PRAECISE_OPENAI_MODEL",
  },
  {
    name: "openai (responses)",
    wire: "responses",
    credential: "OPENAI_API_KEY",
    baseUrl: "https://api.openai.com/v1",
    model: process.env.PRAECISE_OPENAI_MODEL ?? "gpt-4o-mini",
    modelEnv: "PRAECISE_OPENAI_MODEL",
  },
  {
    name: "google (contents)",
    wire: "contents",
    credential: "GEMINI_API_KEY",
    baseUrl: "https://generativelanguage.googleapis.com",
    model: process.env.PRAECISE_GEMINI_MODEL ?? "gemini-3.7-flash",
    modelEnv: "PRAECISE_GEMINI_MODEL",
  },
  {
    name: "google (interactions)",
    wire: "interactions",
    credential: "GEMINI_API_KEY",
    baseUrl: "https://generativelanguage.googleapis.com",
    model: process.env.PRAECISE_GEMINI_MODEL ?? "gemini-3.7-flash",
    modelEnv: "PRAECISE_GEMINI_MODEL",
  },
  {
    name: "xai",
    wire: "chat",
    credential: "XAI_API_KEY",
    baseUrl: "https://api.x.ai/v1",
    model: process.env.PRAECISE_XAI_MODEL ?? "grok-4",
    modelEnv: "PRAECISE_XAI_MODEL",
  },
  {
    // xAI serves the Responses shape as well as Chat Completions, which makes it the
    // one provider here that can confirm two wires from one key.
    name: "xai (responses)",
    wire: "responses",
    credential: "XAI_API_KEY",
    baseUrl: "https://api.x.ai/v1",
    model: process.env.PRAECISE_XAI_MODEL ?? "grok-4",
    modelEnv: "PRAECISE_XAI_MODEL",
  },
  {
    name: "openrouter",
    wire: "chat",
    credential: "OPENROUTER_API_KEY",
    baseUrl: "https://openrouter.ai/api/v1",
    model: process.env.PRAECISE_OPENROUTER_MODEL ?? "openai/gpt-4o-mini",
    modelEnv: "PRAECISE_OPENROUTER_MODEL",
  },
];

/**
 * What one provider may cost before this stops calling it.
 *
 * A verification script is the easiest place in a codebase to spend real money by
 * accident: it loops over providers, it is run from a terminal, and a typo in a model id
 * or a retry loop turns a fraction of a cent into a bill nobody authorised. So the ceiling
 * is checked BEFORE each call rather than reported after, and it is per provider — one
 * misbehaving endpoint must not consume the budget for the rest.
 *
 * Published prices, per million tokens. Wrong-but-close is fine and wrong-but-low is not,
 * so anything unlisted is priced at the most expensive thing here rather than at zero: a
 * provider whose price nobody wrote down must not be the cheap one.
 */
const CAP_USD = Number(process.env.PRAECISE_VERIFY_CAP ?? 1);

const PRICES = {
  anthropic: { in: 3, out: 15 },
  openai: { in: 2.5, out: 10 },
  // Gemini 3.7 Flash introductory rates, verified from Google's own model page.
  // They rise to 1.50/7.50 on 2027-01-01, so this is a floor with an expiry.
  google: { in: 0.75, out: 3.75 },
  xai: { in: 2, out: 6 },
  openrouter: { in: 2, out: 10 },
};

const priceOf = (name) => {
  const key = Object.keys(PRICES).find((known) => name.startsWith(known));
  if (key) return PRICES[key];
  // Unlisted is expensive, never free.
  return Object.values(PRICES).reduce((worst, p) => (p.out > worst.out ? p : worst));
};

const costOf = (name, usage) => {
  const price = priceOf(name);
  return (usage.inputTokens / 1e6) * price.in + (usage.outputTokens / 1e6) * price.out;
};

/** Spent so far, per provider. */
const spent = new Map();

/** Does this failure mean "no such model" rather than "the wire is wrong"? */
const looksLikeUnknownModel = (message) =>
  /model.*(not found|does not exist|is not available|invalid|unsupported)|no such model|404/i.test(message);

/**
 * Does this failure mean the credential was refused?
 *
 * Kept separate because reporting a typo'd key as a broken adapter is the one way this
 * script could do harm: it would send someone to rewrite a wire that was always correct.
 */
const looksLikeAuth = (message) =>
  /401|403|unauthor|invalid.*(api.?key|credential|token)|authentication/i.test(message);

const results = [];

for (const provider of PROVIDERS) {
  const apiKey = process.env[provider.credential];
  if (!apiKey) {
    results.push({ ...provider, status: "NO KEY", detail: `${provider.credential} is not set` });
    continue;
  }
  if (!knownWires().includes(provider.wire)) {
    results.push({ ...provider, status: "WIRE", detail: `no adapter registered for "${provider.wire}"` });
    continue;
  }

  // Checked before the call, not after: a cap that reports an overspend is an invoice.
  const family = Object.keys(PRICES).find((known) => provider.name.startsWith(known)) ?? provider.name;
  const already = spent.get(family) ?? 0;
  if (already >= CAP_USD) {
    results.push({
      ...provider,
      status: "CAPPED",
      detail: `${family} has spent $${already.toFixed(4)} of its $${CAP_USD} ceiling — not called`,
    });
    continue;
  }

  const started = Date.now();
  try {
    const reply = await adapterFor(provider.wire)({
      model: provider.model,
      baseUrl: provider.baseUrl,
      apiKey,
      system: "Answer with exactly one word.",
      messages: [{ role: "user", content: "Reply with the single word: ready" }],
      effort: 0,
      maxTokens: 256,
      fetch,
    });

    const text = String(reply.text ?? "").trim();
    // A reply we cannot read is a wire fault even when the call succeeded — reading the
    // answer out of the right field is half of what an adapter does.
    if (!text) {
      results.push({
        ...provider,
        status: "WIRE",
        detail: "the call succeeded and no text came back — the adapter is reading the wrong field",
      });
      continue;
    }
    const cost = costOf(provider.name, reply.usage);
    spent.set(family, already + cost);
    results.push({
      ...provider,
      status: "OK",
      detail:
        `"${text.slice(0, 24)}" · ${reply.usage.inputTokens}→${reply.usage.outputTokens} tokens · ` +
        `${Date.now() - started}ms · $${cost.toFixed(5)}`,
    });
  } catch (err) {
    const message = String(err?.message ?? err);
    const status = looksLikeAuth(message)
      ? "AUTH"
      : looksLikeUnknownModel(message)
        ? "BAD MODEL"
        : "WIRE";
    const detail =
      status === "AUTH"
        ? `${provider.credential} was refused — the wire is untested, not broken`
        : status === "BAD MODEL"
          ? `"${provider.model}" is not a model this account can reach — set ${provider.modelEnv} to a current id`
          : message.slice(0, 160);
    results.push({ ...provider, status, detail });
  }
}

const width = Math.max(...results.map((r) => r.name.length));
console.log("\n=== WIRES, AGAINST REAL ENDPOINTS ===\n");
for (const r of results) {
  const mark = { OK: "✓", "NO KEY": "·", AUTH: "·", CAPPED: "·", "BAD MODEL": "?", WIRE: "✗" }[r.status];
  console.log(`  ${mark} ${r.name.padEnd(width)}  ${r.status.padEnd(9)} ${r.detail}`);
}

const confirmed = new Set(results.filter((r) => r.status === "OK").map((r) => r.wire));
const broken = results.filter((r) => r.status === "WIRE");
const untested = knownWires().filter((wire) => !confirmed.has(wire));

const total = [...spent.values()].reduce((sum, n) => sum + n, 0);
console.log(`\n  spent: $${total.toFixed(5)} across ${spent.size} provider(s), ceiling $${CAP_USD} each`);
console.log(`  confirmed against a live endpoint: ${[...confirmed].join(", ") || "none"}`);
if (untested.length) console.log(`  still only confirmed against our own assumptions: ${untested.join(", ")}`);
if (broken.length) {
  console.log(`\n  ${broken.length} wire fault(s) — this is what the suite cannot catch.`);
}
console.log();

process.exit(broken.length ? 1 : 0);
