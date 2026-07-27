/**
 * What fits in a request, decided in one place.
 *
 * Four things compete for the same room: what the agent was told up front, what
 * it was reminded of, what has already been said, and what a tool just handed
 * back. Each of them used to carry its own ceiling in its own file, so four
 * things sharing one limit each decided as though they were the only one
 * spending. Whichever ran first won, and nothing anywhere could answer how much
 * of a request was left.
 *
 * Counted in tokens rather than characters, because a token is what an endpoint
 * charges for and what its context is measured in — a budget in characters
 * means something different for prose, for code, and for a script that is not
 * Latin at all.
 *
 * Estimated rather than counted exactly. An exact count needs the endpoint's
 * own tokenizer: a dependency per endpoint, usually a download, and out of date
 * the moment the endpoint changes. The number here only has to be close enough
 * to decide what to leave out, and being a little pessimistic is the safe
 * direction to be wrong in.
 */

/**
 * Roughly how many tokens a piece of text costs.
 *
 * About four Latin characters to a token. Anything outside that range rarely
 * gets more than one character into a token and often less, so it is counted
 * one for one — which overestimates a little rather than promising room that is
 * not there.
 */
export function tokens(text: string): number {
  let wide = 0;
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) > 0x7f) wide++;
  }
  return Math.ceil((text.length - wide) / 4 + wide);
}

/**
 * The room a request has, divided.
 *
 * These are ceilings on what goes in, and they deliberately do not add up to
 * the whole context: what is left is what the agent answers into, plus the
 * question itself. A request that spends its entire context on input has
 * nowhere to put a reply.
 */
export interface Budget {
  /** Everything the agent is told before the conversation starts. */
  instructions: number;
  /** Exchanges recalled from earlier conversations. */
  recall: number;
  /** The conversation so far. */
  conversation: number;
  /** Any one tool's output. */
  toolOutput: number;
}

/**
 * Assumed context when the app has not said.
 *
 * Deliberately modest. The framework ships no list of models and so cannot look
 * this up; an app that knows its endpoint holds more says so, and everything
 * below scales with it.
 */
export const ROOM = 128_000;

const SHARE: Record<keyof Budget, number> = {
  instructions: 0.12,
  recall: 0.03,
  conversation: 0.1,
  toolOutput: 0.2,
};

export function budgetFor(room: number = ROOM): Budget {
  const usable = Math.max(room, 4_000);
  return {
    instructions: Math.floor(usable * SHARE.instructions),
    recall: Math.floor(usable * SHARE.recall),
    conversation: Math.floor(usable * SHARE.conversation),
    toolOutput: Math.floor(usable * SHARE.toolOutput),
  };
}

/**
 * How many characters of this text are worth about this many tokens.
 *
 * Calibrated against the text itself rather than against an average, so a page
 * of prose and a page of another script each get an answer that fits them.
 */
function charsFor(text: string, limit: number): number {
  const cost = tokens(text);
  if (cost <= limit) return text.length;
  return Math.max(0, Math.floor(text.length * (limit / cost)));
}

/** The opening of this text that fits, cut on a boundary where there is one. */
export function clip(text: string, limit: number): string {
  const room = charsFor(text, limit);
  if (room >= text.length) return text;
  const cut = text.slice(0, room);
  const breath = cut.lastIndexOf("\n");
  return breath > room * 0.8 ? cut.slice(0, breath) : cut;
}

/**
 * This text cut to fit, with the middle taken out rather than the end.
 *
 * A head carries the shape of the thing and a tail often carries the total or
 * the conclusion, and one chatty tool must not cost the rest of the
 * conversation. What is missing is said out loud, in the text, so that whatever
 * reads it knows it is holding a piece and can go and ask for the rest.
 */
export function trim(text: string, limit: number): string {
  if (tokens(text) <= limit) return text;
  // Room for the note that says what went.
  const keep = Math.floor(charsFor(text, limit) / 2) - 100;
  if (keep <= 0) return clip(text, limit);
  const gone = text.length - keep * 2;
  return (
    `${text.slice(0, keep)}\n\n` +
    `[${gone.toLocaleString()} characters omitted from the middle. ` +
    `Ask again more narrowly if you need what is missing.]\n\n` +
    `${text.slice(-keep)}`
  );
}
