/**
 * A page generated for whoever asked, from what this app actually knows.
 *
 * The web's answer to "show me something about X" is a page somebody wrote in advance,
 * and a search engine's job is to find the nearest one. That model breaks for an agent:
 * it does not want the nearest pre-written page, it wants THIS question answered from
 * THIS system's data, once, and then it will act on the answer.
 *
 * So this is the server-rendered page of an agentic app. A caller asks in natural
 * language; the app retrieves from its own knowledge and stores; a model renders what was
 * retrieved into an answer. Nothing is written in advance and nothing is cached by
 * default, for the same reason a dashboard is not cached — the value is that it is true
 * now.
 *
 * ── Following NLWeb rather than inventing a shape ─────────────────────────────
 *
 * There is already a protocol for exactly this, and it is the one Microsoft describes as
 * being "to MCP/A2A what HTML is to HTTP": a `/ask` endpoint taking a natural-language
 * `query`, with a `mode` of `list`, `summarize`, or `generate`, answering with results
 * carrying `url`, `name`, `score`, `description` and a `schema_object`. Inventing a
 * different shape would buy nothing and cost interoperability with every client that
 * already speaks it, so the field names here are theirs, spelled their way — including
 * the snake_case that sits oddly beside the rest of this codebase.
 *
 * ── Why the three modes are genuinely different ───────────────────────────────
 *
 * `list` costs NO model call. It retrieves and ranks and returns, which is the right
 * answer when the caller is an agent that will read the items itself — and it is the
 * default, because spending a model call to prose-wrap data for a machine that wanted the
 * data is the most common way this feature would waste money.
 *
 * `summarize` retrieves the same way and adds one call to say what the set amounts to.
 *
 * `generate` is retrieval-augmented answering: the question gets an answer rather than a
 * list. This is the expensive one, and it is the one a human-facing surface wants.
 *
 * ── Which model answers ───────────────────────────────────────────────────────
 *
 * The operator decides, not this file, and not the caller. A request may ask for a
 * cheaper rung than the operator allowed and never a more expensive one — otherwise
 * "generate at best quality" is an unauthenticated request that spends the operator's
 * money, which is a denial-of-wallet with extra steps.
 */

import type { App } from "../app.js";
import type { Caller } from "./mcp.js";
import { toolsOf } from "./mcp.js";
import type { Quality } from "../define.js";

/** What NLWeb calls the answering strategies. Spelled as that protocol spells them. */
export type AskMode = "list" | "summarize" | "generate";

/** One retrieved item, in NLWeb's result shape. */
export interface AskResult {
  url: string;
  name: string;
  site: string;
  score: number;
  description: string;
  /** The item itself, as data. A machine reads this rather than the prose. */
  schema_object: Record<string, unknown>;
}

export interface AskAnswer {
  query_id: string;
  query: string;
  mode: AskMode;
  results: AskResult[];
  /** Present for `summarize` and `generate`. Absent for `list`, which spends nothing. */
  answer?: string;
  /** Which rung answered, so a caller can see what it was given. */
  generated_by?: { quality: Quality; agent?: string };
  /** What could not be done, said out loud rather than returned as an empty answer. */
  notes?: string[];
}

/** What the operator allows this endpoint to spend. */
export interface AskPolicy {
  /**
   * The most expensive rung `/ask` may use. Default `"fast"`.
   *
   * Deliberately the cheapest tier by default. This endpoint is reachable by anything
   * that can reach the app, and a default of `"best"` would mean an unauthenticated
   * question spends the most expensive model available — the operator should have to say
   * yes to that rather than discover it on an invoice.
   */
  quality?: Quality;
  /** The most expensive mode allowed. Default `"summarize"`. */
  mode?: AskMode;
  /** Which agent renders an answer. Defaults to the first published one. */
  agent?: string;
  /** How many results to retrieve before answering. */
  limit?: number;
  /**
   * The store holding the CONTENT this app mirrors — the catalogue, the price list, the
   * articles, whatever the business already keeps in a database.
   *
   * This is what turns `/ask` from "what can this app do" into "what does this business
   * know", which is the difference between an API description and a website. The memory
   * layer is the point of contact: a store is backed by Postgres, SQLite, or whatever the
   * business already runs, so the mirror is not a copy of the data — it is the data,
   * answered live.
   *
   * Without it only capabilities are searched, which is the right default: an app that
   * has not said which store is public should not have one guessed at.
   */
  store?: string;
  /**
   * What the rows in that store ARE, as a schema.org type: `Product`, `Article`,
   * `FAQPage`, `Offer`, `Event`. Default `"Thing"`.
   *
   * Stated rather than inferred. A guess here is a lie in structured data, and structured
   * data is read by machines that will not notice it is wrong.
   */
  type?: string;
  /**
   * Roughly how much of a prompt the retrieved rows may occupy. Default 1200 tokens.
   *
   * A budget rather than a row count, because rows are not the same size and it is the
   * characters that cost. What does not fit is reported, never silently dropped.
   */
  budgetTokens?: number;
}

const ORDER: Record<Quality, number> = { fast: 0, balanced: 1, best: 2 };
const MODE_COST: Record<AskMode, number> = { list: 0, summarize: 1, generate: 2 };

/**
 * The rung to answer at: what was asked for, capped by what the operator allowed.
 *
 * A ceiling and not an override, so a caller may economise but never escalate.
 */
export function qualityFor(asked: Quality | undefined, policy: AskPolicy): Quality {
  const ceiling = policy.quality ?? "fast";
  if (!asked) return ceiling;
  return ORDER[asked] <= ORDER[ceiling] ? asked : ceiling;
}

/** The same rule for how much work the answer may involve. */
export function modeFor(asked: AskMode | undefined, policy: AskPolicy): AskMode {
  const ceiling = policy.mode ?? "summarize";
  if (!asked) return "list";
  return MODE_COST[asked] <= MODE_COST[ceiling] ? asked : ceiling;
}

/** Words worth matching on: everything that is not punctuation or a stop word. */
const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "is", "are", "for", "on", "with",
  "what", "which", "how", "do", "does", "can", "i", "you", "it", "this", "that",
]);

export function termsOf(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 1 && !STOP.has(word)),
  );
}

/**
 * Rank what this app publishes against a question.
 *
 * Lexical overlap, normalised by how much was asked. This is deliberately not a vector
 * search: an app's published surface is tens of items with hand-written descriptions, and
 * at that size an embedding round trip costs more than it can possibly buy. An app whose
 * DATA needs semantic search has a vector store for exactly that, and `list` is where
 * that would be plugged in.
 */
export function rank(query: string, items: { name: string; description: string }[]): AskResult[] {
  const asked = termsOf(query);
  if (!asked.size) return [];

  return items
    .map((item) => {
      const words = termsOf(`${item.name} ${item.description}`);
      let hits = 0;
      for (const word of asked) if (words.has(word)) hits += 1;
      return { item, score: hits / asked.size };
    })
    .filter((scored) => scored.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ item, score }) => ({
      url: `/api/agents/${item.name}`,
      name: item.name,
      site: "",
      score: Number(score.toFixed(3)),
      description: item.description,
      schema_object: {
        "@type": "Action",
        name: item.name,
        description: item.description,
      },
    }));
}

let counter = 0;
const newQueryId = (): string => {
  counter += 1;
  return `q-${Date.now().toString(36)}-${counter.toString(36)}`;
};

/**
 * Rows from the app's own content store, as schema.org objects.
 *
 * `search` rather than `recall`: a visitor asking about a product wants the row that
 * mentions it, not the row that mentions it and is also recent. Recency is what memory
 * wants; a catalogue does not have a recency preference and pretending otherwise buries
 * the older half of the inventory.
 *
 * A store that cannot be opened is a note, never a throw: the capability results are
 * still real, and an endpoint that returns nothing because one backend was down is worse
 * than one that returns less and says why.
 */
export async function fromStore(
  app: App,
  query: string,
  policy: AskPolicy,
  notes: string[],
): Promise<AskResult[]> {
  if (!policy.store) return [];
  try {
    const store = await app.store(policy.store);
    const found = await store.search(query, { limit: policy.limit ?? 10 });
    return found.map((item) => ({
      url: typeof item.meta?.url === "string" ? item.meta.url : `/api/store/${policy.store}/${item.id}`,
      name: typeof item.meta?.name === "string" ? item.meta.name : item.text.slice(0, 60),
      site: policy.store ?? "",
      score: Number((item.score ?? 0).toFixed(3)),
      description: item.text.slice(0, 400),
      // The row as DATA. Everything the app kept alongside it travels too, because the
      // caller is a machine and the fields it needs are not ones this file can predict.
      schema_object: {
        "@context": "https://schema.org",
        "@type": policy.type ?? "Thing",
        identifier: item.id,
        name: typeof item.meta?.name === "string" ? item.meta.name : undefined,
        description: item.text,
        ...item.meta,
      },
    }));
  } catch (err) {
    notes.push(`could not read the content store "${policy.store}": ${(err as Error).message}`);
    return [];
  }
}

/**
 * Fit what was retrieved into what a prompt can hold, without lying about the rest.
 *
 * Between the database and the model there has to be a layer that decides what survives,
 * and the obvious implementation — summarise everything until it fits — is the wrong one.
 * A summary gets SMOOTHER as it gets shorter: the distinctive rows, which are exactly the
 * ones that answer a specific question, are the first to be averaged away, and what
 * arrives is a fluent paragraph with the answer missing. Compressing again compounds it.
 *
 * So this selects rather than summarises, in three passes:
 *
 * **Supersede.** Two rows about the same thing that cannot both be current — a price
 * changed, a policy replaced — are not both included. The newer wins and the older is
 * closed off at the moment the newer was written, so the record still says what was true
 * before and the prompt carries one answer instead of two that disagree.
 *
 * **Deduplicate.** A catalogue kept over time holds near-identical rows. They cost budget
 * and add nothing, because the second copy carries no information the first did not.
 *
 * **Fit, and say what was left out.** What remains is taken in score order until the
 * budget is spent, and the count of what did not fit is REPORTED. A model told "these 8
 * of 340 matched, ranked" answers differently from one handed 8 rows as though they were
 * everything — the second will happily say "the catalogue contains" about 2% of it.
 */
export interface Compacted {
  kept: AskResult[];
  /** Rows a newer row replaced. Kept, not deleted — the archive is still the archive. */
  superseded: AskResult[];
  /** Near-duplicates dropped, which carried nothing the kept row did not. */
  duplicates: number;
  /** Matched, ranked, and did not fit the budget. */
  omitted: number;
}

/** Roughly four characters to a token. Close enough to budget with, cheap to compute. */
const PER_TOKEN = 4;

/** What two rows are "about", for deciding whether they can both be current. */
function subjectOf(result: AskResult): string {
  const meta = result.schema_object as { identifier?: unknown; sku?: unknown; name?: unknown };
  // An explicit business key first — a SKU or an id is the only reliable statement that
  // two rows describe one thing. A name is a fallback and a weaker one.
  for (const key of [meta.sku, meta.identifier, meta.name]) {
    if (typeof key === "string" && key.trim()) return key.trim().toLowerCase();
  }
  return result.name.trim().toLowerCase();
}

/** When a row was written, for deciding which of two rivals is current. */
function writtenAt(result: AskResult): number {
  const meta = result.schema_object as { at?: unknown; dateModified?: unknown };
  for (const value of [meta.at, meta.dateModified]) {
    if (typeof value === "number") return value;
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return 0;
}

export function compact(results: AskResult[], budgetTokens = 1_200): Compacted {
  const superseded: AskResult[] = [];
  const current = new Map<string, AskResult>();

  for (const result of results) {
    const subject = subjectOf(result);
    const rival = current.get(subject);
    if (!rival) {
      current.set(subject, result);
      continue;
    }
    // Newer wins; the loser is recorded rather than discarded, and marked with when it
    // stopped being true.
    const [winner, loser] = writtenAt(result) >= writtenAt(rival) ? [result, rival] : [rival, result];
    current.set(subject, winner);
    superseded.push({
      ...loser,
      schema_object: { ...loser.schema_object, supersededAt: writtenAt(winner) || undefined },
    });
  }

  // Near-duplicates: rows that differ in id and say the same thing, which a catalogue
  // imported twice is full of.
  //
  // A row carrying an explicit business key is NEVER dropped this way, and that
  // distinction was a bug worth catching: two products can legitimately share a
  // description and differ only by SKU — a size, a colour, a region — and collapsing them
  // makes half an inventory invisible. Only rows with nothing to tell them apart but
  // their text are treated as duplicates of each other.
  const seen = new Set<string>();
  const distinct: AskResult[] = [];
  let duplicates = 0;
  for (const result of [...current.values()].sort((a, b) => b.score - a.score)) {
    const meta = result.schema_object as { sku?: unknown; identifier?: unknown };
    const keyed = typeof meta.sku === "string" || typeof meta.identifier === "string";
    if (keyed) {
      distinct.push(result);
      continue;
    }
    const fingerprint = result.description.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 200);
    if (seen.has(fingerprint)) {
      duplicates += 1;
      continue;
    }
    seen.add(fingerprint);
    distinct.push(result);
  }

  // Fit, in score order.
  const budget = budgetTokens * PER_TOKEN;
  const kept: AskResult[] = [];
  let spent = 0;
  for (const result of distinct) {
    const cost = result.name.length + result.description.length + 8;
    if (spent + cost > budget && kept.length) break;
    kept.push(result);
    spent += cost;
  }

  return {
    kept: edgeFirst(kept),
    superseded,
    duplicates,
    omitted: distinct.length - kept.length,
  };
}

/**
 * Put the best matches where a model will actually read them.
 *
 * Attention over a long context is not uniform — it is strongest at the beginning and the
 * end and weakest in the middle, which is the "lost in the middle" result, and it is why
 * Microsoft's LongLLMLingua reorders by relevance rather than only pruning. Handing a
 * model a strictly descending list buries everything after the first few items in the
 * region it reads least.
 *
 * So a ranked list is dealt to both ends: best first, second-best LAST, third second, and
 * so on inward. The weakest matches end up in the middle, which is exactly where losing
 * something matters least. This costs one pass and no tokens.
 */
export function edgeFirst<T>(ranked: T[]): T[] {
  const front: T[] = [];
  const back: T[] = [];
  ranked.forEach((item, index) => (index % 2 === 0 ? front.push(item) : back.unshift(item)));
  return [...front, ...back];
}

/**
 * Answer a question against this app.
 *
 * `list` never reaches a model. The other two render the retrieved set through an agent,
 * which means the app's own guard, memory and access rules apply to the answer — an
 * endpoint that bypassed them to "just generate something" would be a second, unguarded
 * way into the same system.
 */
export async function ask(
  app: App,
  request: { query?: unknown; mode?: unknown; quality?: unknown; site?: unknown },
  caller: Caller = {},
  policy: AskPolicy = {},
): Promise<AskAnswer> {
  const query = typeof request.query === "string" ? request.query.trim() : "";
  const query_id = newQueryId();
  const notes: string[] = [];

  if (!query) {
    return { query_id, query: "", mode: "list", results: [], notes: ["`query` is required"] };
  }

  const mode = modeFor(request.mode as AskMode | undefined, policy);
  const quality = qualityFor(request.quality as Quality | undefined, policy);
  if (request.mode && request.mode !== mode) {
    notes.push(`mode "${String(request.mode)}" is above what this deployment allows; answered as "${mode}"`);
  }
  if (request.quality && request.quality !== quality) {
    notes.push(`quality "${String(request.quality)}" is above what this deployment allows; answered at "${quality}"`);
  }

  // Retrieval is over what this caller may actually reach, so an answer never mentions a
  // capability the same caller would be refused.
  const published = toolsOf(app, caller);
  const limit = policy.limit ?? 10;

  // Content first, then capabilities. A visitor asking about a product wants the product;
  // the ways to ACT on it are useful and secondary, and a list that led with them would
  // read like an API reference to someone who asked a question about a business.
  const content = await fromStore(app, query, policy, notes);
  const capabilities = rank(query, published);

  // The layer between the database and the prompt. Supersede, deduplicate, then fit —
  // and report what did not, rather than handing over a subset as though it were the set.
  const packed = compact([...content, ...capabilities], policy.budgetTokens ?? 1_200);
  const results = packed.kept.slice(0, limit);

  if (packed.superseded.length) {
    notes.push(
      `${packed.superseded.length} row(s) were replaced by newer ones and left out of the answer`,
    );
  }
  if (packed.duplicates) notes.push(`${packed.duplicates} near-duplicate row(s) carried nothing new`);
  if (packed.omitted) notes.push(`${packed.omitted} more matched and did not fit; ask more narrowly to see them`);

  if (mode === "list") return { query_id, query, mode, results, ...(notes.length ? { notes } : {}) };

  const agent = policy.agent ?? published[0]?.name;
  if (!agent) {
    notes.push("this app publishes nothing that could answer, so there is only the (empty) list");
    return { query_id, query, mode, results, notes };
  }

  // What the model is given: the question and what retrieval actually found. Not the
  // whole app, and nothing invented — if retrieval found nothing, the model is told that
  // in those words rather than left to fill the silence.
  const found = results.length
    ? results.map((r) => `- ${r.name}: ${r.description}`).join("\n")
    : "(nothing in this application matched)";
  const kind = content.length ? "What this business has that matched" : "What this application publishes that matched";
  // The model is told the shape of what it was given. Without this it will say "the
  // catalogue contains" about whatever fraction happened to fit.
  const scope = packed.omitted
    ? `These are the ${results.length} best matches of ${results.length + packed.omitted}. Do not describe them as everything.`
    : `These are all the matches.`;

  const instruction =
    mode === "summarize"
      ? `Say what this set amounts to, in two or three sentences. Do not invent anything beyond it.\n\n` +
        `Question: ${query}\n\n${scope}\n\n${kind}:\n${found}`
      : `Answer the question using only what is listed below. If it does not contain the answer, ` +
        `say so plainly and say what would be needed.\n\n` +
        `Question: ${query}\n\n${scope}\n\n${kind}:\n${found}`;

  try {
    const said = await app.ask(agent, instruction, { ceiling: quality });
    return {
      query_id,
      query,
      mode,
      results,
      answer: said.text,
      generated_by: { quality, agent },
      ...(notes.length ? { notes } : {}),
    };
  } catch (err) {
    // A model that would not answer must not turn into a silent empty page. The retrieved
    // list is still real and still useful, so it is returned with the reason attached.
    notes.push(`could not generate an answer: ${(err as Error).message}`);
    return { query_id, query, mode, results, notes };
  }
}
