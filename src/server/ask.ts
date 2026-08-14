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
  const results = rank(query, published).slice(0, policy.limit ?? 10);

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

  const instruction =
    mode === "summarize"
      ? `Say what this set amounts to, in two or three sentences. Do not invent anything beyond it.\n\n` +
        `Question: ${query}\n\nWhat this application publishes that matched:\n${found}`
      : `Answer the question using only what is listed below. If it does not contain the answer, ` +
        `say so plainly and say what would be needed.\n\n` +
        `Question: ${query}\n\nWhat this application publishes that matched:\n${found}`;

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
