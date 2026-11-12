/**
 * Tools the runtime itself gives an agent.
 *
 * An agent's tools are what its author named: functions and services. A few more are
 * consequences of how the agent is run rather than of what it is for — reading the rest
 * of a result that was too long to hand over, finding a tool among too many to list,
 * asking another agent, asking a stronger model. Each is a `LocalTool` like any other:
 * it has a name, a description and a schema, it passes the same guard, and the loop that
 * calls it does not know it is special. That is the whole design. A capability that
 * needed its own branch in the loop would be a second loop.
 *
 * Every one of them is advertised from the first turn or not at all. A tool list that
 * changes part-way through a conversation changes the front of every later request, and
 * an endpoint keeps nothing it has read past a change.
 */

import type { LocalTool } from "../compile/plan.js";
import { tokens, trim } from "./budget.js";
import { render } from "./context.js";
import type { ToolSchema } from "./types.js";

// ── Results too long to hand over ───────────────────────────────────────────

export const READ_RESULT = "read_result";

/** How much of a kept result one reading hands back, as a share of what a tool may return. */
const READING = 0.5;

/** Lines either side of a match, so a hit is read in its place. */
const AROUND = 2;

/**
 * Results that did not fit, kept whole for as long as the request lasts.
 *
 * Cutting the middle out of a long result is right for the transcript and wrong for the
 * work: the model is told something is missing and has no way to get it except to call
 * the tool again — which repeats the cost, may not be safe to repeat, and returns the
 * same too-long thing. So the whole result is put on a shelf under a short name, the
 * transcript gets the head and the tail and that name, and one tool reads the rest by
 * line or by search.
 */
export class Shelf {
  private readonly kept = new Map<string, string[]>();

  /** What goes in the transcript for a result: all of it if it fits, a piece and a name if not. */
  place(text: string, limit: number): string {
    if (tokens(text) <= limit) return text;
    const name = `r${this.kept.size + 1}`;
    const lines = text.split("\n");
    this.kept.set(name, lines);
    return (
      `${trim(text, limit)}\n\n` +
      `[The whole result is ${lines.length.toLocaleString()} lines and is kept as "${name}". ` +
      `Read more of it with ${READ_RESULT}: by line with \`from\`, or by \`search\`.]`
    );
  }

  get size(): number {
    return this.kept.size;
  }

  read(name: string, limit: number, from?: number, search?: string): string {
    const lines = this.kept.get(name);
    if (!lines) {
      const known = [...this.kept.keys()];
      return known.length
        ? `No result is kept as "${name}". Kept: ${known.join(", ")}.`
        : `No results are kept. A result is kept only when it was too long to hand over whole.`;
    }
    const numbered = (at: number): string => `${at + 1}: ${lines[at]}`;

    if (search) {
      const wanted = search.toLowerCase();
      const hits = lines.flatMap((line, at) => (line.toLowerCase().includes(wanted) ? [at] : []));
      if (!hits.length) return `Nothing in "${name}" contains "${search}".`;
      const shown = new Set<number>();
      for (const hit of hits) {
        for (let at = Math.max(0, hit - AROUND); at <= Math.min(lines.length - 1, hit + AROUND); at++) shown.add(at);
      }
      const body = [...shown].sort((a, b) => a - b).map(numbered).join("\n");
      return trim(`${hits.length} line(s) of "${name}" contain "${search}":\n${body}`, limit);
    }

    const start = Math.min(Math.max(0, Math.trunc((from ?? 1) - 1)), lines.length - 1);
    const out: string[] = [];
    let spent = 0;
    let at = start;
    for (; at < lines.length; at++) {
      const line = numbered(at);
      spent += tokens(line) + 1;
      if (spent > limit && out.length) break;
      out.push(line);
    }
    const more = at < lines.length ? `\n[${lines.length - at} more line(s); continue with from: ${at + 1}]` : "";
    return `${out.join("\n")}${more}`;
  }
}

export function readResultTool(shelf: Shelf, toolOutput: number): LocalTool {
  const limit = Math.max(256, Math.floor(toolOutput * READING));
  return {
    name: READ_RESULT,
    description:
      "Read more of a tool result that was too long to show whole. Such a result ends with the " +
      "name it is kept under. Give that name, and either a line to start from or a phrase to search for.",
    parameters: {
      type: "object",
      properties: {
        result: { type: "string", description: 'The name the result is kept under, e.g. "r1".' },
        from: { type: "integer", description: "The line to start reading from. Default 1." },
        search: { type: "string", description: "Show the lines containing this, each with the lines around it." },
      },
      required: ["result"],
    },
    effect: "read",
    run: (args) =>
      shelf.read(
        String(args.result ?? ""),
        limit,
        typeof args.from === "number" ? args.from : Number(args.from) || undefined,
        typeof args.search === "string" && args.search ? args.search : undefined,
      ),
  };
}

// ── More tools than fit in a list ───────────────────────────────────────────

export const FIND_TOOLS = "find_tools";
export const USE_TOOL = "use_tool";

/** Tool definitions past this share of an endpoint's room are found rather than listed. */
const LISTED_SHARE = 0.1;

/** Below this many, a list is short enough to read whatever it weighs. */
const FEW = 12;

/** How many matches one search returns. */
const FOUND = 5;

/** What a tool's definition costs to list. */
export const weightOf = (schema: ToolSchema): number =>
  tokens(schema.name) + tokens(schema.description) + tokens(JSON.stringify(schema.parameters));

/**
 * Whether these tools should be found rather than listed.
 *
 * Every listed tool is read on every request whether or not it is used, and a model
 * choosing among two hundred definitions chooses worse than one choosing among five.
 * Past a tenth of the room, the list is costing more than the tools are worth.
 */
export function tooManyToList(schemas: readonly ToolSchema[], room: number): boolean {
  if (schemas.length <= FEW) return false;
  return schemas.reduce((total, schema) => total + weightOf(schema), 0) > room * LISTED_SHARE;
}

const words = (text: string): string[] =>
  text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1);

/**
 * The tools that best match a description of what is wanted.
 *
 * Ranked the way a search over short documents usually is: a word counts for more the
 * fewer tools mention it, and for more again in a name than in a description, because a
 * name is what its author thought the tool was.
 */
export function findTools(schemas: readonly ToolSchema[], query: string, limit = FOUND): ToolSchema[] {
  const asked = [...new Set(words(query))];
  if (!asked.length) return [];
  const docs = schemas.map((schema) => ({
    schema,
    name: new Set(words(schema.name)),
    body: words(`${schema.name} ${schema.description}`),
  }));
  const mentions = new Map<string, number>();
  for (const doc of docs) for (const word of new Set(doc.body)) mentions.set(word, (mentions.get(word) ?? 0) + 1);

  return docs
    .map((doc) => {
      let score = 0;
      for (const word of asked) {
        const count = doc.body.filter((have) => have === word || have.startsWith(word)).length;
        if (!count) continue;
        const rarity = Math.log(1 + docs.length / (mentions.get(word) ?? 1));
        score += rarity * (count / (count + 1.5)) * (doc.name.has(word) ? 3 : 1);
      }
      return { schema: doc.schema, score };
    })
    .filter((scored) => scored.score > 0)
    .sort((a, b) => b.score - a.score || a.schema.name.localeCompare(b.schema.name))
    .slice(0, limit)
    .map((scored) => scored.schema);
}

/**
 * The two tools that stand in for a list too long to send.
 *
 * `find_tools` answers a description with the definitions that match it. `use_tool`
 * calls one of them by name. The second is not run here: the loop reads it as a call to
 * the tool it names, so the guard, the authority, the trace and the record all see the
 * real tool and none of them can be walked around by going through this one.
 */
export function finderTools(deferred: readonly ToolSchema[]): LocalTool[] {
  const services = [...new Set(deferred.map((schema) => schema.name.split("__")[0]))].filter(Boolean);
  return [
    {
      name: FIND_TOOLS,
      description:
        `Find a tool for a job. ${deferred.length} tools are available that are not listed here` +
        (services.length ? ` (from: ${services.slice(0, 20).join(", ")})` : "") +
        `. Describe what you need to do and the best matches come back with their arguments; ` +
        `then call one with ${USE_TOOL}.`,
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "What you need to do, in a few words." } },
        required: ["query"],
      },
      effect: "read",
      run: (args) => {
        const found = findTools(deferred, String(args.query ?? ""));
        if (!found.length) return `No tool matches "${String(args.query ?? "")}". Try other words for the same job.`;
        return found
          .map(
            (schema) =>
              `${schema.name}\n${schema.description}\narguments: ${JSON.stringify(schema.parameters)}`,
          )
          .join("\n\n");
      },
    },
    {
      name: USE_TOOL,
      description: `Call a tool that ${FIND_TOOLS} returned, by its exact name, with the arguments it takes.`,
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: `The tool's name, exactly as ${FIND_TOOLS} gave it.` },
          args: { type: "object", description: "The arguments for that tool." },
        },
        required: ["name"],
      },
      // Never run: the loop redirects the call. Reaching this means the name was not a tool.
      run: (args) =>
        `Error: no tool is called "${String(args.name ?? "")}". Use ${FIND_TOOLS} and copy a name from what it returns.`,
    },
  ];
}

/** The call a `use_tool` call stands for, or nothing if it names no tool that was held back. */
export function redirected(
  call: { name: string; args: Record<string, unknown> },
  deferred: ReadonlySet<string>,
): { name: string; args: Record<string, unknown> } | undefined {
  if (call.name !== USE_TOOL) return undefined;
  const name = String(call.args.name ?? "");
  if (!deferred.has(name)) return undefined;
  const args = call.args.args;
  return { name, args: typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {} };
}

// ── Another agent ───────────────────────────────────────────────────────────

/** An agent this one may hand a piece of work to. */
export interface Delegate {
  name: string;
  description: string;
  /** What asking it may do, as its author declared. */
  effect?: LocalTool["effect"];
}

/**
 * An agent, as a tool another agent can call.
 *
 * The one asked starts from its own role and tools and sees nothing of the conversation
 * that led to it — which is the point. A piece of work handed over whole comes back as
 * one answer, and the dozens of results it took to get there never enter the context of
 * the agent that asked. The description says so, because a model that assumes shared
 * context writes "look into that" and gets back a question.
 */
export function delegateTool(delegate: Delegate, ask: (task: string) => Promise<string>): LocalTool {
  return {
    name: delegate.name,
    description:
      `${delegate.description} This is another agent. It sees nothing of this conversation, so the ` +
      `task you give it must stand on its own: say what you want, what you already know that it ` +
      `needs, and what form the answer should take.`,
    parameters: {
      type: "object",
      properties: { task: { type: "string", description: "The whole task, self-contained." } },
      required: ["task"],
    },
    effect: delegate.effect,
    // Another agent's answer is model output built from whatever that agent read.
    trust: "untrusted",
    run: (args) => ask(String(args.task ?? "")),
  };
}

// ── A stronger model ────────────────────────────────────────────────────────

export const CONSULT = "consult";

/** What an advisor may say in one consultation. Advice that needs more than this is the job itself. */
export const ADVICE_ROOM = 2_048;

export const ADVISING = [
  "You are advising another model that is part-way through a task. You are shown its instructions,",
  "the work so far, and what it wants to know. You are not doing the task: say what you would do",
  "next and why, name anything in the work so far that is wrong, and stop. Be brief and concrete.",
].join("\n");

/**
 * Advice from the strongest model on the ladder, for an agent answering on a cheaper one.
 *
 * Climbing the ladder hands the whole job to a dearer model, which is right when the
 * cheap one could not do it and wasteful when it only needed pointing in the right
 * direction once. This is the other use of a strong model: it reads what has been done,
 * says what it would do next, and the cheap model carries on.
 */
export function consultTool(advise: (question: string, transcript: string) => Promise<string>): LocalTool {
  return {
    name: CONSULT,
    description:
      "Ask a stronger model for advice. It sees your instructions and everything done so far. " +
      "Worth it before committing to an approach on a hard task, when stuck, and before giving an " +
      "answer you are unsure of. It advises; it does not do the work.",
    parameters: {
      type: "object",
      properties: { question: { type: "string", description: "What you want advice on." } },
      required: ["question"],
    },
    effect: "read",
    run: (args, during) => advise(String(args.question ?? ""), render(during?.transcript ?? [])),
  };
}
