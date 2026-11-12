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

import type { LocalTool, ToolContext } from "../compile/plan.js";
import { tokens, trim } from "./budget.js";
import { render } from "./context.js";
import type { Progress, ToolSchema } from "./types.js";

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
 *
 * `start`, where it is given, lets the same tool be called with `background: true`: the
 * agent is started and a handle comes back at once instead of an answer. It is one tool
 * and not two on purpose. A guard that refuses this agent by name refuses it however it
 * was asked, and nothing is reachable in the background that was refused in front.
 */
export function delegateTool(
  delegate: Delegate,
  ask: (task: string) => Promise<string>,
  start?: (task: string, during?: ToolContext) => string,
): LocalTool {
  return {
    name: delegate.name,
    description:
      `${delegate.description} This is another agent. It sees nothing of this conversation, so the ` +
      `task you give it must stand on its own: say what you want, what you already know that it ` +
      `needs, and what form the answer should take.` +
      (start
        ? ` With \`background: true\` it starts working and you get a handle back at once, so you can ` +
          `carry on and use ${AGENT_CHECK}, ${AGENT_STEER}, ${AGENT_CANCEL} and ${AGENT_COLLECT} on it.`
        : ""),
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "The whole task, self-contained." },
        ...(start
          ? { background: { type: "boolean", description: "Start it and return a handle instead of waiting for the answer." } }
          : {}),
      },
      required: ["task"],
    },
    effect: delegate.effect,
    run: (args, during) =>
      start && (args.background === true || args.background === "true")
        ? start(String(args.task ?? ""), during)
        : ask(String(args.task ?? "")),
  };
}

// ── Another agent, working while this one carries on ─────────────────────────

export const AGENT_CHECK = "check_agent";
export const AGENT_STEER = "steer_agent";
export const AGENT_CANCEL = "cancel_agent";
export const AGENT_COLLECT = "collect_agent";

/** How many agents one request may have working in the background at once. */
export const MAX_RUNNING = 4;

/** What a background agent is handed besides its task: how it is stopped, steered and watched. */
export interface Work {
  /** Aborted when it is cancelled, and when the request that started it ends. */
  signal: AbortSignal;
  /** What it has been told since it last looked. Reading it takes it. */
  steer: () => string[];
  onProgress: (event: Progress) => void;
}

interface Running {
  handle: string;
  agent: string;
  state: "running" | "done" | "failed" | "cancelled";
  answer?: string;
  error?: string;
  inbox: string[];
  stop: AbortController;
  /** Resolves when it is no longer running, however that came about. Never rejects. */
  settled: Promise<void>;
  started: number;
  ended?: number;
  calls: number;
  last?: string;
}

const seconds = (ms: number): string => `${Math.max(0, Math.round(ms / 1000))}s`;

/** What a model reads when it is steered: who is speaking, so it is not mistaken for the task's own text. */
const steering = (message: string): string =>
  `[A message from the agent that gave you this task, sent while you were working: ${message}]`;

/**
 * The agents one request has working in the background.
 *
 * A delegated agent normally runs to completion inside the call that asked it, which
 * is right for a piece of work the asker is waiting on and wrong for three it could
 * have had running at once. Started here instead, an agent works while the one that
 * started it carries on, and is held by a short handle through which it can be checked,
 * told something more, cancelled, and collected from.
 *
 * It belongs to the request and ends with it. An agent still working when the request
 * that started it answers is stopped: nothing would read what it came back with, and
 * work nobody will read is still paid for.
 */
export class Crew {
  private readonly all = new Map<string, Running>();

  /** Start an agent on its work. What comes back is what the model is told: a handle, or why not. */
  start(agent: string, work: (during: Work) => Promise<string>, parent?: AbortSignal): string {
    const busy = [...this.all.values()].filter((running) => running.state === "running");
    if (busy.length >= MAX_RUNNING) {
      return (
        `Not started: ${busy.length} agents are already working in the background (${busy.map((r) => r.handle).join(", ")}) ` +
        `and ${MAX_RUNNING} is the limit. Collect or cancel one first, or ask ${agent} without \`background\`.`
      );
    }
    const stop = new AbortController();
    const linked = (): void => stop.abort(parent?.reason);
    if (parent?.aborted) linked();
    else parent?.addEventListener("abort", linked, { once: true });

    const running: Running = {
      handle: `a${this.all.size + 1}`,
      agent,
      state: "running",
      inbox: [],
      stop,
      settled: Promise.resolve(),
      started: Date.now(),
      calls: 0,
    };
    const finish = (state: Running["state"], fill: Partial<Running>): void => {
      // Cancelling is final: an answer that arrives after it is not the outcome.
      if (running.state !== "running") return;
      Object.assign(running, fill, { state, ended: Date.now() });
    };
    running.settled = work({
      signal: stop.signal,
      steer: () => running.inbox.splice(0).map(steering),
      onProgress: (event) => {
        if (event.kind !== "tool") return;
        running.calls++;
        running.last = event.name;
      },
    })
      .then(
        (answer) => finish("done", { answer }),
        (err: unknown) => finish(stop.signal.aborted ? "cancelled" : "failed", { error: (err as Error)?.message ?? String(err) }),
      )
      .finally(() => parent?.removeEventListener("abort", linked));
    this.all.set(running.handle, running);
    return (
      `Started ${agent} as "${running.handle}". It is working in the background and you can carry on. ` +
      `${AGENT_CHECK} says how it is getting on, ${AGENT_STEER} tells it something more, ` +
      `${AGENT_CANCEL} stops it, and ${AGENT_COLLECT} waits for its answer.`
    );
  }

  private find(handle: string): Running | string {
    const running = this.all.get(handle);
    if (running) return running;
    const known = [...this.all.keys()];
    return known.length
      ? `No agent was started as "${handle}". Started: ${known.join(", ")}.`
      : `No agent has been started in the background. Call an agent with \`background: true\` to start one.`;
  }

  private describe(running: Running): string {
    const who = `${running.handle} (${running.agent})`;
    const tools = running.calls
      ? `${running.calls} tool call(s)${running.last ? `, most recently ${running.last}` : ""}`
      : "no tool calls yet";
    if (running.state === "running") return `${who}: working for ${seconds(Date.now() - running.started)}, ${tools}.`;
    const took = seconds((running.ended ?? Date.now()) - running.started);
    if (running.state === "done") return `${who}: finished after ${took}. Its answer is ready; read it with ${AGENT_COLLECT}.`;
    if (running.state === "cancelled") return `${who}: cancelled after ${took}.`;
    return `${who}: failed after ${took}: ${running.error ?? "no reason given"}`;
  }

  /** How one agent is getting on, or all of them when none is named. */
  check(handle?: string): string {
    if (!handle) {
      const every = [...this.all.values()];
      return every.length ? every.map((running) => this.describe(running)).join("\n") : (this.find("") as string);
    }
    const running = this.find(handle);
    return typeof running === "string" ? running : this.describe(running);
  }

  /** Leave a message the agent reads before its next step. */
  steer(handle: string, message: string): string {
    const running = this.find(handle);
    if (typeof running === "string") return running;
    if (!message.trim()) return "Nothing was sent: the message was empty.";
    if (running.state !== "running") return `Not sent: ${this.describe(running)}`;
    running.inbox.push(message.trim());
    return `Sent. ${running.handle} will read it before its next step.`;
  }

  cancel(handle: string): string {
    const running = this.find(handle);
    if (typeof running === "string") return running;
    if (running.state !== "running") return `Nothing to cancel: ${this.describe(running)}`;
    running.stop.abort(new Error("cancelled by the agent that started it"));
    Object.assign(running, { state: "cancelled", ended: Date.now() });
    return `Cancelled ${running.handle} (${running.agent}). Whatever it had found is discarded.`;
  }

  /** Wait for an agent to finish and hand over what it concluded. */
  async collect(handle: string, signal?: AbortSignal): Promise<string> {
    const running = this.find(handle);
    if (typeof running === "string") return running;
    if (running.state === "running") {
      // Waits for the agent, and no longer than the request that is waiting on it.
      let given = (): void => undefined;
      const hungUp = new Promise<void>((resolve) => {
        given = resolve;
        signal?.addEventListener("abort", given, { once: true });
      });
      await Promise.race([running.settled, hungUp]);
      signal?.removeEventListener("abort", given);
    }
    if (running.state === "done") return running.answer ?? "";
    return this.describe(running);
  }

  /** Stop whatever is still working, and say which those were. */
  stopAll(): string[] {
    const stopped: string[] = [];
    for (const running of this.all.values()) {
      if (running.state !== "running") continue;
      running.stop.abort(new Error("the request that started it ended"));
      Object.assign(running, { state: "cancelled", ended: Date.now() });
      stopped.push(`${running.handle} (${running.agent})`);
    }
    return stopped;
  }
}

/**
 * The four tools that go with an agent started in the background.
 *
 * Starting is not among them — that is the agent's own tool, called with
 * `background: true` — so these only ever act on a handle that tool gave out.
 */
export function crewTools(crew: Crew): LocalTool[] {
  const handle = { type: "string", description: 'The handle the agent was started as, e.g. "a1".' };
  return [
    {
      name: AGENT_CHECK,
      description:
        "See how an agent you started in the background is getting on: whether it is still working, " +
        "how long it has been, and how many tools it has used. Leave the handle out to see them all. Does not wait.",
      parameters: { type: "object", properties: { handle } },
      effect: "read",
      run: (args) => crew.check(typeof args.handle === "string" && args.handle ? args.handle : undefined),
    },
    {
      name: AGENT_STEER,
      description:
        "Tell an agent that is working in the background something more: a correction, a narrower " +
        "scope, something you have learned since. It reads the message before its next step.",
      parameters: {
        type: "object",
        properties: { handle, message: { type: "string", description: "What to tell it. It still sees nothing else of this conversation." } },
        required: ["handle", "message"],
      },
      run: (args) => crew.steer(String(args.handle ?? ""), String(args.message ?? "")),
    },
    {
      name: AGENT_CANCEL,
      description: "Stop an agent that is working in the background. What it had found so far is discarded.",
      parameters: { type: "object", properties: { handle }, required: ["handle"] },
      run: (args) => crew.cancel(String(args.handle ?? "")),
    },
    {
      name: AGENT_COLLECT,
      description:
        "Wait for an agent you started in the background to finish, and read its answer. " +
        "Collect several in one turn to wait for them together.",
      parameters: { type: "object", properties: { handle }, required: ["handle"] },
      effect: "read",
      run: (args, during) => crew.collect(String(args.handle ?? ""), during?.signal),
    },
  ];
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
