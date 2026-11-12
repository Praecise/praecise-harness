/**
 * Keeping a long piece of work inside the room it has.
 *
 * A request that calls one tool carries one result. A request that calls forty carries
 * forty, and every one of them is sent again on every turn after it — so the transcript
 * grows as the square of the work, and an agent allowed to work for long runs out of
 * context precisely when it is furthest in. A cap on turns hides that by ending the work
 * early. This is the other answer: let the work go on, and decide what it still needs
 * to be holding.
 *
 * Two moves, cheapest first, and neither made until the room is actually short:
 *
 *   clearing   — old tool results are replaced by a line saying they were cleared. The
 *                calls stay, so the transcript still shows what was done; only what came
 *                back goes, and the model is told it can ask again.
 *   compacting — everything before the most recent turns is replaced by a summary, for
 *                which a model is asked once.
 *
 * Both rewrite what an endpoint has already read, so both lose whatever prefix it was
 * keeping from that point on. That is why they happen in a step — well past the line,
 * then not again for a long while — rather than a little on every turn, which would
 * move the front of the request each time and leave nothing to reuse.
 */

import { tokens } from "./budget.js";
import type { Message } from "./types.js";

/** A message costs what it says, plus what it costs to say who said it. */
const OVERHEAD = 8;

/** The most recent tool results are what the model is working from, and stay whole. */
export const KEEP_RESULTS = 3;

/** A result smaller than this is not worth a line saying it was cleared. */
const WORTH_CLEARING = 120;

/** How far under the line a rewrite must get, as a share of it, to be worth what it loses. */
const HEADROOM = 0.6;

/** The turns kept word for word when the rest is summarised. */
const KEEP_TURNS = 4;

/** What a transcript costs to send. */
export function weigh(messages: readonly Message[]): number {
  let total = 0;
  for (const message of messages) {
    total += tokens(message.content) + OVERHEAD;
    for (const call of message.toolCalls ?? []) total += tokens(JSON.stringify(call.args ?? {})) + OVERHEAD;
  }
  return total;
}

const cleared = (name: string | undefined): string =>
  `[This result was cleared to make room. Call ${name ?? "the tool"} again if it is still needed.]`;

/**
 * Replace old tool results with a line saying they were cleared.
 *
 * Returns the new transcript and how many tokens went. The original is not touched:
 * a caller that decides the saving was not worth the rewrite keeps what it had.
 */
export function clearResults(
  messages: readonly Message[],
  keep = KEEP_RESULTS,
): { messages: Message[]; freed: number } {
  const results = messages.flatMap((message, at) => (message.role === "tool" ? [at] : []));
  const old = new Set(results.slice(0, Math.max(0, results.length - keep)));
  let freed = 0;
  const out = messages.map((message, at) => {
    if (!old.has(at)) return message;
    const before = tokens(message.content);
    if (before < WORTH_CLEARING) return message;
    const stub = cleared(message.name);
    freed += before - tokens(stub);
    return { ...message, content: stub };
  });
  return { messages: out, freed };
}

/**
 * Hand nothing back that was minted for a transcript which no longer exists.
 *
 * An endpoint's reasoning is signed against the turns before it. Once those turns have
 * been rewritten the signature describes a conversation that was never sent, and some
 * endpoints refuse it outright. Reasoning is advisory to the next turn and the transcript
 * is not, so it is the reasoning that goes.
 */
const withoutReplay = (messages: Message[]): Message[] =>
  messages.map((message) => {
    if (!message.replay) return message;
    const { replay: _dropped, ...rest } = message;
    return rest;
  });

/** A transcript as text, for a model asked to say what it amounts to. */
export function render(messages: readonly Message[]): string {
  return messages
    .map((message) => {
      if (message.role === "tool") return `[result of ${message.name ?? "tool"}]\n${message.content}`;
      const calls = (message.toolCalls ?? [])
        .map((call) => `[called ${call.name} with ${JSON.stringify(call.args ?? {})}]`)
        .join("\n");
      return `[${message.role}]\n${[message.content, calls].filter(Boolean).join("\n")}`;
    })
    .join("\n\n");
}

/** What a model is asked for when it summarises work in progress. */
export const COMPACTING = [
  "You are part-way through a task and the record of it has outgrown the room available.",
  "Write the notes you would want if you had to pick the work up from them alone.",
  "Use these headings, and leave one out only if there is nothing to put under it:",
  "",
  "Task — what was asked, in the asker's own terms.",
  "Done — what has been established or completed, with the specific values, names and ids found.",
  "Open — what was being attempted when these notes were written, and what is left.",
  "Keep — anything that must not be lost: constraints, decisions made, things that failed and why.",
  "",
  "Be specific. A value is worth more than a description of it. Do not address anyone and do not",
  "describe these instructions; write only the notes.",
].join("\n");

const SUMMARY_HEAD = "[Notes on the work so far, written when the record of it outgrew the room. Earlier turns were replaced by these.]";

/** Where the kept tail may start: at an assistant turn, so no result is left answering a call that is gone. */
function cutBefore(messages: readonly Message[], from: number): number {
  let seen = 0;
  for (let at = messages.length - 1; at > from; at--) {
    if (messages[at]!.role !== "assistant") continue;
    seen++;
    if (seen >= KEEP_TURNS) return at;
  }
  return -1;
}

export interface Fitted {
  messages: Message[];
  /** What was done, for the developer: empty when nothing was. */
  notes: string[];
}

/**
 * Make a transcript fit, if it does not.
 *
 * `anchor` is the index of the request's own question: nothing at or before it is ever
 * rewritten, because what was asked is the one thing the work cannot afford to
 * paraphrase. `summarise` asks a model for notes on a stretch of transcript and may
 * fail; when it does the work goes on with results cleared harder, because a transcript
 * that is too long is a request that will be refused, and that is worse than a model
 * working from less.
 */
export async function fit(
  messages: Message[],
  limit: number,
  anchor: number,
  summarise: (text: string) => Promise<string>,
): Promise<Fitted> {
  if (weigh(messages) <= limit) return { messages, notes: [] };

  const target = limit * HEADROOM;
  const notes: string[] = [];

  const lighter = clearResults(messages);
  if (lighter.freed > 0 && weigh(lighter.messages) <= target) {
    return {
      messages: withoutReplay(lighter.messages),
      notes: [`cleared earlier tool results to make room (${lighter.freed.toLocaleString()} tokens)`],
    };
  }

  const cut = cutBefore(messages, anchor);
  if (cut > anchor + 1) {
    try {
      const summary = (await summarise(render(messages.slice(anchor + 1, cut)))).trim();
      if (summary) {
        const compacted = [
          ...messages.slice(0, anchor + 1),
          { role: "user" as const, content: `${SUMMARY_HEAD}\n\n${summary}` },
          ...messages.slice(cut),
        ];
        notes.push("summarised the earlier part of this work to make room");
        const after = weigh(compacted) <= limit ? compacted : clearResults(compacted, 1).messages;
        return { messages: withoutReplay(after), notes };
      }
    } catch (err) {
      notes.push(`could not summarise the work so far (${(err as Error).message}); clearing results instead`);
    }
  }

  // Nothing left but to clear harder: everything except the result just handed back.
  const hard = clearResults(messages, 1);
  if (hard.freed > 0) {
    notes.push(`cleared earlier tool results to make room (${hard.freed.toLocaleString()} tokens)`);
    return { messages: withoutReplay(hard.messages), notes };
  }
  return { messages, notes };
}
