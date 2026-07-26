/**
 * What a stranger reads before deciding whether to call something.
 *
 * A description is not documentation. It is the entire basis on which a model
 * decides to act or to decline, and a caller shown a name and nothing else will
 * guess. The checks here are deliberately narrow: they catch the cases where
 * there is demonstrably nothing to read — no description, a description that
 * only says the name back, a role that leaked out of the app and is addressed
 * to the agent rather than to whoever is choosing it, a parameter with no hint.
 *
 * They cannot judge whether a description is *good*. Nothing mechanical can. So
 * they are warnings while you work and refusals when you publish, and they stop
 * well short of pretending to grade prose.
 */

export interface Describable {
  name: string;
  description?: string;
  /** Parameter name → the hint a caller reads. */
  parameters?: Record<string, string | undefined>;
}

/**
 * Words that carry no information about what a thing does. A description built
 * only from these and the thing's own name has told the reader nothing.
 */
const FILLER = new Set([
  "a", "an", "the", "this", "that", "it", "its",
  "is", "are", "be", "does", "do",
  "for", "of", "to", "and", "or", "with", "on", "in",
  "call", "calls", "run", "runs", "use", "uses", "used",
  "agent", "workflow", "function", "tool", "app", "step", "steps",
]);

const words = (text: string): string[] =>
  text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** Does the description say anything the name did not already say? */
function informative(name: string, description: string): boolean {
  const own = new Set(words(name));
  return words(description).some((word) => !FILLER.has(word) && !own.has(word));
}

/** Everything wrong with how a thing describes itself. Empty means nothing. */
export function faultsIn(thing: Describable): string[] {
  const faults: string[] = [];
  const description = thing.description?.trim();

  if (!description) {
    faults.push("no `description` — a caller sees the name and nothing else");
  } else if (/^(you\b|your\b)/i.test(description)) {
    // Prose addressed to the thing itself: instructions that escaped into the
    // published surface. Whoever is choosing between tools is not "you".
    faults.push(
      "`description` is addressed to the agent, not to whoever is choosing it — " +
        "say what it is for, not what it should do",
    );
  } else if (!informative(thing.name, description)) {
    faults.push(`\`description\` only says "${thing.name}" back — say what calling it is for`);
  }

  for (const [key, hint] of Object.entries(thing.parameters ?? {})) {
    if (!hint?.trim()) faults.push(`parameter "${key}" has no hint — say what goes in it`);
  }

  return faults;
}

/** Pull parameter hints back out of a JSON Schema, for checking a built tool. */
export function hintsIn(schema: Record<string, unknown> | undefined): Record<string, string | undefined> {
  const properties = (schema?.properties ?? {}) as Record<string, { description?: string }>;
  return Object.fromEntries(
    Object.entries(properties).map(([key, property]) => [key, property?.description]),
  );
}
