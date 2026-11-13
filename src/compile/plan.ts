/**
 * Specs in, runnable plans out.
 *
 * This is where the abstraction is actually paid for: an `AgentSpec` says what
 * an agent is for, and a `Plan` says which models to call in what order, with
 * what instructions, holding which credentials. Everything the runtime needs is
 * decided here so the runtime itself stays dumb.
 */

import type { CodeModeSpec } from "../harness/codemode.js";
import { planSelf, type SelfPlan } from "../harness/selves.js";
import type { Action, AgentSpec, Effect, FunctionRunOptions, FunctionSpec, Quality, Returns, Trust } from "../define.js";
import { resolveKnows, type Doc, type Project } from "../project/load.js";
import { resolveServices, type ResolvedService } from "./services.js";
import { planModels, unreachableEndpoints, type Env, type Rung } from "./models.js";
import { budgetFor, tokens } from "../harness/budget.js";
import type { Delegate } from "../harness/faculties.js";
import type { AskCaller, Message, NativeTool } from "../harness/types.js";
import { knowledgeTool, packKnowledge, READ_KNOWLEDGE } from "./outline.js";
import { READ_SKILL, skillsFor, skillsSection, skillTool } from "./skills.js";
import { shapeOf, uncheckedIn } from "../schema.js";
import type { AuthoredSkill } from "../project/skills.js";

/** Past exchanges recalled into context when the agent does not say. */
const DEFAULT_RECALL = 3;

/**
 * A function from `functions/`, ready to advertise to a model.
 *
 * These carry no namespace: an MCP tool is `service__refund`, and code the
 * developer wrote is just `refund`. The name is what the model reads first, and
 * there is nothing for a local function to be qualified against.
 */
export interface LocalTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** What the function said calling it does, where it said anything. */
  effect?: Effect;
  /** The action calling it would take, computed from the arguments. */
  action?(args: Record<string, unknown>): Action;
  /** Whether its output may steer later actions. */
  trust?: Trust;
  /** Set when this is a tool an endpoint may know natively. */
  native?: NativeTool;
  /**
   * `during` is where the call sits: the work so far and the request's own signal. A
   * function from `functions/` has no use for either; a tool the runtime contributes
   * sometimes does.
   */
  run(args: Record<string, unknown>, during?: ToolContext): unknown | Promise<unknown>;
}

/** Where a tool call sits when it is made. */
export interface ToolContext {
  /** The request's conversation up to and including the turn that made this call. */
  transcript: readonly Message[];
  signal?: AbortSignal;
  /** Who the request is for, and what the app sent with it. See `AskOptions`. */
  caller?: AskCaller;
  context?: unknown;
}

/** What a function is told of where a call sits: only what there is to tell. */
export function runOptionsFor(during: ToolContext): Pick<FunctionRunOptions, "signal" | "transcript" | "caller" | "context"> {
  return {
    signal: during.signal,
    transcript: during.transcript,
    ...(during.caller !== undefined ? { caller: during.caller } : {}),
    ...(during.context !== undefined ? { context: during.context } : {}),
  };
}

/** Tool round-trips one request may make when the agent does not say. */
export const DEFAULT_TURNS = 16;

/** Turn `input: { order: "the order id" }` into the schema a model is given. */
export function schemaFor(input: Record<string, string> | undefined): Record<string, unknown> {
  const entries = Object.entries(input ?? {});
  return {
    type: "object",
    properties: Object.fromEntries(
      entries.map(([key, hint]) => [key, { type: "string", description: hint }]),
    ),
    required: entries.map(([key]) => key),
  };
}

function localToolFor(name: string, spec: FunctionSpec): LocalTool {
  return {
    name,
    description: spec.description ?? `Call the ${name} function.`,
    parameters: spec.schema ?? schemaFor(spec.input),
    effect: spec.effect,
    ...(spec.action ? { action: (args: Record<string, unknown>) => spec.action!(args) } : {}),
    ...(spec.trust ? { trust: spec.trust } : {}),
    ...(spec.native ? { native: spec.native } : {}),
    // A function called from a model's tool loop is told where the call sits; one called
    // any other way is called as it always was, with nothing.
    run: (args, during) =>
      during ? spec.run(args, runOptionsFor(during)) : spec.run(args),
  };
}

export interface AgentPlan {
  name: string;
  description: string;
  quality: Quality;
  /** The fully composed system instructions. */
  instructions: string;
  /** Models to try, cheapest first. Empty ⇒ no credentials, offline mode. */
  rungs: Rung[];
  /**
   * When `rungs` is empty: the endpoints this app declared and could not reach.
   *
   * Empty means none were declared, which is a first run. Non-empty means the
   * app was pointed at something and the credential is not there — a runtime
   * that answered that with a placeholder would be inventing prose for a
   * production app whose key was typed wrong.
   */
  unreachable?: string[];
  services: ResolvedService[];
  /** Functions from `functions/` this agent may call. */
  locals: LocalTool[];
  /** Other agents this one may hand work to, named in `tools`. */
  delegates?: Delegate[];
  /** How many times it may go to its tools before it must answer. */
  turns?: number;
  /** Whether it may ask the strongest model on its ladder for advice. */
  advisor?: boolean;
  /** Whether it may start the agents it delegates to in the background. */
  background?: boolean;
  memory: boolean;
  /** A `stores/` name to remember into, instead of files in the state directory. */
  memoryStore?: string;
  /** How many past exchanges may come back into context. */
  memoryRecall?: number;
  returns?: Returns;
  /** The agent's own check on its structured result. See `AgentSpec.read`. */
  read?: (data: unknown) => string | undefined | void | Promise<string | undefined | void>;
  greeting?: string;
  /** The self this agent is, when it declares one. */
  self?: SelfPlan;
  /** Set when the agent runs in code mode. */
  code?: CodeModeSpec;
  /** Non-fatal issues to surface in the dashboard. */
  problems: string[];
  /**
   * The instructions in the parts they were composed from, so that what the agent knows
   * can be narrowed for one request without planning the agent again. See
   * `narrowKnowledge`. Absent on a plan made by hand, which is then never narrowed.
   */
  knowledge?: KnowledgePlan;
}

/** What an agent's instructions were composed from. */
export interface KnowledgePlan {
  /** Role, rules and skills: everything in front of the reference material. */
  opening: string;
  /** The examples, which follow it. The declared shape is written last, from `returns`. */
  examples: string;
  /** Every document the agent knows, in the order they are packed. */
  docs: Doc[];
  /** For each entry of `knows` the agent declared, which of `docs` it brought, by position. */
  sources: Record<string, number[]>;
  /** How many tokens the instructions may take. */
  limit: number;
}

function section(title: string, body: string): string {
  return `${title}\n${body}`;
}

/** A role is prose; a description has to fit on one line of a list. */
function summarize(role: string): string {
  const sentence = role.trim().replace(/\s+/g, " ");
  const stop = sentence.indexOf(". ");
  const cut = stop > 0 ? sentence.slice(0, stop + 1) : sentence;
  return cut.length > 110 ? `${cut.slice(0, 107)}…` : cut;
}

const SHAPE_HEADING = "Reply with JSON in exactly this shape, and nothing else:";
const SCHEMA_HEADING = "Reply with JSON that matches this JSON Schema, and nothing else:";
const JSON_HEADING = "Reply with a single JSON value, and nothing else. Its shape is checked once you have answered.";

/**
 * A declared `returns` shape, as JSON Schema.
 *
 * Three of the endpoints this framework speaks to will CONSTRAIN decoding to a schema —
 * a reply outside it is unreachable, not merely unlikely, and one vendor states no retry
 * is needed for a violation. None of that was reachable while a shape existed only as
 * English in the prompt, so it is derived here.
 *
 * What the derivation can and cannot promise, said plainly. `Returns` maps a field to a
 * HINT, not a type, so every property is typed `string` and the hint becomes its
 * description. That constrains the STRUCTURE exactly — these keys, no others, all
 * present — and leaves the VALUE to the hint, so "one of: refund, shipping" is still
 * prose the model may miss. An author who needs the value constrained too supplies a
 * real schema, which is passed through untouched.
 *
 * Structure alone is most of the benefit: the failures that actually break a caller are
 * a missing field, an extra one, and a reply that is not an object at all.
 */
export function schemaFromReturns(returns: Record<string, string>): Record<string, unknown>;
export function schemaFromReturns(returns: Returns): Record<string, unknown> | undefined;
export function schemaFromReturns(returns: Returns): Record<string, unknown> | undefined {
  // A real schema is passed through untouched, and a validator describes itself where it can.
  const shape = shapeOf(returns);
  if (shape.kind !== "fields") return shape.schema;
  const properties: Record<string, unknown> = {};
  for (const [field, hint] of Object.entries(returns as Record<string, string>)) {
    properties[field] = { type: "string", description: hint };
  }
  return {
    type: "object",
    additionalProperties: false,
    required: Object.keys(returns),
    properties,
  };
}

function shapeSection(returns: Returns): string {
  const declared = shapeOf(returns);
  if (declared.kind !== "fields") {
    // A model on an endpoint that does not constrain decoding has only this to go on.
    return declared.schema ? section(SCHEMA_HEADING, JSON.stringify(declared.schema, null, 2)) : JSON_HEADING;
  }
  const shape = Object.entries(returns as Record<string, string>)
    .map(([field, hint]) => `  "${field}": ${hint}`)
    .join(",\n");
  return section(SHAPE_HEADING, `{\n${shape}\n}`);
}

/**
 * Re-shape a plan for one step.
 *
 * An agent's `returns` is a default, not a property of the agent. The same
 * agent is often asked for a judgement at one step and for prose at another,
 * and an output shape declared once on the agent silently reaches both — which
 * turns the prose step into a form to fill in without anything reporting that
 * it did. So the shape section is written last and replaced here rather than
 * appended to, and a step that declares no shape gets the agent's.
 */
export function shapedFor(plan: AgentPlan, returns: Returns | undefined): AgentPlan {
  if (!returns) return plan;
  // Whichever way the agent's own shape was written, it is the last thing in its instructions.
  const cut = Math.max(...[SHAPE_HEADING, SCHEMA_HEADING, JSON_HEADING].map((heading) => plan.instructions.lastIndexOf(heading)));
  const without = cut === -1 ? plan.instructions : plan.instructions.slice(0, cut).trimEnd();
  return { ...plan, returns, instructions: [without, shapeSection(returns)].join("\n\n") };
}

/**
 * Compose instructions from role, rules, knowledge, examples, and output shape.
 *
 * Knowledge is the part that gives when there is not enough room. Everything
 * else here was written by hand a line at a time; a document arrives by the
 * megabyte, and it is the only part of this that a developer can grow without
 * noticing they have grown it.
 */
function instructionsFor(
  spec: AgentSpec,
  docs: Doc[],
  problems: string[],
  room?: number,
  skills: AuthoredSkill[] = [],
): { text: string; outlined: boolean; parts: Pick<KnowledgePlan, "opening" | "examples" | "limit"> } {
  const opening: string[] = [spec.role.trim()];

  if (spec.rules?.length) {
    opening.push(
      section(
        "Rules you must follow, without exception:",
        spec.rules.map((r) => `- ${r}`).join("\n"),
      ),
    );
  }

  // Authored skills: names and descriptions only. Hand-written and short, so they are
  // counted before knowledge is, and knowledge is what gives if the two do not fit.
  if (skills.length) opening.push(skillsSection(skills));

  const examples = spec.examples?.length
    ? section(
        "Examples of the expected response:",
        spec.examples
          .map((e) => `Input: ${e.input}\nOutput: ${e.output}`)
          .join("\n\n"),
      )
    : "";

  const parts = { opening: opening.join("\n\n"), examples, limit: budgetFor(room).instructions };
  return { ...composed(parts, docs, spec.returns, problems), parts };
}

/**
 * Put instructions together around a set of documents.
 *
 * Separate from working out the parts, because the documents are the one part a
 * request may narrow: the same role, rules and examples, around fewer documents.
 */
function composed(
  parts: Pick<KnowledgePlan, "opening" | "examples" | "limit">,
  docs: Doc[],
  returns: Returns | undefined,
  problems: string[],
): { text: string; outlined: boolean } {
  // The role and the rules, exactly as they were written: nothing below shortens them.
  const opening = [parts.opening];
  const closing = [parts.examples, returns ? shapeSection(returns) : ""].filter(Boolean);
  const reference: string[] = [];
  let outlined = false;
  if (docs.length) {
    const limit = parts.limit;
    const left = limit - tokens([...opening, ...closing].join("\n\n"));
    if (left <= 0) {
      problems.push(
        `knowledge does not fit in ${limit.toLocaleString()} tokens of instructions; ` +
          `"${docs[0]!.name}" and later documents were left out`,
      );
    } else {
      const packed = packKnowledge(docs, left);
      outlined = packed.outlined;
      if (packed.omitted.length) {
        problems.push(
          `the outline of knowledge does not fit in ${limit.toLocaleString()} tokens of instructions; ` +
            `${packed.omitted.map((n) => `"${n}"`).join(", ")} are not listed`,
        );
      }
      reference.push(
        section(
          "Reference material. Ground your answers in this, and say so when it does not cover the question:",
          packed.text,
        ),
      );
    }
  }

  return { text: [...opening, ...reference, ...closing].join("\n\n"), outlined };
}

/**
 * The same agent, knowing only what one request allows it to.
 *
 * `names` are entries of the agent's own `knows`, as it declared them, or the names of
 * documents it knows. The instructions are put together again around the documents that
 * are left — role, rules, examples and shape untouched — and the tool that reads
 * documents reads only those. Narrowing can only take away: a name the agent does not
 * know is an error where `strict`, and ignored otherwise, never a way to learn more.
 */
export function narrowKnowledge(
  plan: AgentPlan,
  names: readonly string[],
  strict = true,
): { plan: AgentPlan; notes: string[] } {
  const known = plan.knowledge;
  const keep = new Set<number>();
  for (const name of names) {
    const brought = known?.sources[name];
    const called = known ? known.docs.flatMap((doc, at) => (doc.name === name ? [at] : [])) : [];
    if (!brought && !called.length) {
      if (!strict) continue;
      const has = known ? [...new Set([...Object.keys(known.sources), ...known.docs.map((doc) => doc.name)])] : [];
      throw new Error(
        `agent "${plan.name}" does not know "${name}", so a request cannot narrow it to that. ` +
          (has.length ? `It knows: ${has.join(", ")}.` : "It knows no documents."),
      );
    }
    for (const at of [...(brought ?? []), ...called]) keep.add(at);
  }
  if (!known) return { plan, notes: [] };

  const docs = known.docs.filter((_, at) => keep.has(at));
  // Where each kept document now sits, so a second narrowing reads the first one's result.
  const moved = new Map<number, number>();
  known.docs.forEach((_, at) => {
    if (keep.has(at)) moved.set(at, moved.size);
  });
  const sources = Object.fromEntries(
    Object.entries(known.sources).map(([entry, ats]) => [entry, ats.flatMap((at) => (moved.has(at) ? [moved.get(at)!] : []))]),
  );
  const notes: string[] = [];
  const made = composed(known, docs, plan.returns, notes);
  return {
    plan: {
      ...plan,
      instructions: made.text,
      knowledge: { ...known, docs, sources },
      locals: [
        ...plan.locals.filter((local) => local.name !== READ_KNOWLEDGE),
        ...(made.outlined ? [knowledgeTool(docs)] : []),
      ],
    },
    notes,
  };
}

export interface PlanOptions {
  env?: Env;
  /** Override the provider chosen by credential precedence. */
  prefer?: string;
}

/** Build the plan for one agent. */
export async function planAgent(
  project: Project,
  spec: AgentSpec,
  options: PlanOptions = {},
): Promise<AgentPlan> {
  const env = options.env ?? process.env;
  const problems: string[] = [];

  // `knows` narrows; absent, an agent sees everything in `memory/`.
  // Resolved an entry at a time, so that which documents each entry brought is known
  // and a request can later be narrowed to some of them.
  const sources: Record<string, number[]> = {};
  let docs: Doc[] = project.knowledge;
  if (spec.knows?.length) {
    docs = [];
    for (const entry of spec.knows) {
      const brought = await resolveKnows(project, [entry]);
      sources[entry] = [...(sources[entry] ?? []), ...brought.map((_, at) => docs.length + at)];
      docs.push(...brought);
    }
  }
  if (spec.knows?.length && !docs.length) {
    problems.push(`\`knows\` matched no files: ${spec.knows.join(", ")}`);
  }

  // A name in `tools` is a local function if `functions/` claims it, another agent if
  // `agents/` does, and an MCP service otherwise. Own code wins, then own agents: both
  // are things the author can see, and a service is the one that is somebody else's.
  const named = spec.tools ?? [];
  const locals = named
    .filter((name) => project.functions[name])
    .map((name) => localToolFor(name, project.functions[name]!));
  const isAgent = (name: string): boolean =>
    !project.functions[name] && !project.tools[name] && Boolean(project.agents[name]) && name !== spec.name;
  const delegates: Delegate[] = named.filter(isAgent).map((name) => {
    const other = project.agents[name]!;
    return {
      name,
      description: other.description ?? summarize(String(other.role ?? name)),
      effect: other.effect,
    };
  });
  const { services, problems: serviceProblems } = resolveServices(
    named.filter((name) => !project.functions[name] && !isAgent(name)),
    project.tools,
    env,
  );
  problems.push(...serviceProblems);

  const quality = spec.quality ?? project.config.quality ?? "balanced";
  const rungs = planModels({
    env,
    quality,
    providers: project.config.models,
    prefer: options.prefer,
  });
  const unreachable = rungs.length
    ? []
    : unreachableEndpoints(project.config.models, env as Record<string, string | undefined>);
  if (!rungs.length) {
    problems.push(
      unreachable.length
        ? `no model endpoint could be reached: ${unreachable.join("; ")}`
        : "no model endpoint configured — set PRAECISE_API_KEY to run on Praecise Cloud, " +
            "or add `models` to praecise.config.ts to point at your own",
    );
  }

  const skills = skillsFor(project.skills, spec, problems);
  if (skills.length && named.includes(READ_SKILL)) {
    problems.push(`\`${READ_SKILL}\` is the tool that reads this app's skills; rename the one in tools`);
  }

  if (spec.background && !delegates.length) {
    problems.push("`background` is set and `tools` names no other agent, so there is nothing to start in the background");
  }

  const instructions = instructionsFor(spec, docs, problems, rungs[0]?.room, skills);
  if (instructions.outlined && named.includes(READ_KNOWLEDGE)) {
    problems.push(`\`${READ_KNOWLEDGE}\` is the tool that reads this app's documents; rename the one in tools`);
  }

  // What a declared shape will and will not be held to, said where an author will see it.
  if (spec.returns) {
    const declared = shapeOf(spec.returns);
    const skipped = declared.kind === "schema" ? uncheckedIn(spec.returns) : [];
    if (skipped.length) {
      problems.push(
        `\`returns\` uses ${skipped.map((keyword) => `\`${keyword}\``).join(", ")}, which an answer is not checked against here; ` +
          `an endpoint that constrains decoding may still enforce it`,
      );
    }
    if (declared.kind === "standard" && !declared.schema) {
      problems.push(
        "`returns` is a schema that cannot describe itself as JSON Schema, so the model is asked for JSON without " +
          "being shown a shape and the answer is checked afterwards; say what shape is wanted in `role`",
      );
    }
  } else if (spec.read) {
    problems.push("`read` is set and `returns` is not, so there is no structured result for it to read");
  }

  const name = spec.name ?? "agent";
  const remembers = typeof spec.memory === "object" && spec.memory !== null ? spec.memory : undefined;
  return {
    name,
    description: spec.description ?? summarize(spec.role),
    quality,
    instructions: instructions.text,
    rungs,
    unreachable,
    services,
    locals: [
      ...locals,
      ...(instructions.outlined ? [knowledgeTool(docs)] : []),
      ...(skills.length ? [skillTool(skills, budgetFor(rungs[0]?.room).toolOutput)] : []),
    ],
    // Off unless asked for: memory is a way to stop replaying a long thread,
    // not a way to make an agent better at answering.
    memory: spec.memory === true || remembers !== undefined,
    memoryStore: remembers?.store,
    memoryRecall: Math.max(1, Math.trunc(remembers?.recall ?? DEFAULT_RECALL)),
    returns: spec.returns,
    ...(spec.read && spec.returns ? { read: (data: unknown) => spec.read!(data) } : {}),
    greeting: spec.greeting,
    self: planSelf(spec.self),
    code: spec.code === true ? {} : spec.code || undefined,
    ...(delegates.length ? { delegates } : {}),
    turns: Math.max(1, Math.trunc(spec.turns ?? DEFAULT_TURNS)),
    ...(spec.advisor ? { advisor: true } : {}),
    ...(spec.background && delegates.length ? { background: true } : {}),
    problems,
    knowledge: { ...instructions.parts, docs, sources },
  };
}

/** Plan every agent in a project, keyed by name. */
export async function planProject(
  project: Project,
  options: PlanOptions = {},
): Promise<Record<string, AgentPlan>> {
  // An agent with no role is not plannable, and `validate` has already recorded exactly
  // that as a fault. Planning it anyway dereferenced the missing role and threw a raw
  // TypeError out of `App.load` — which destroyed the very report that said what was
  // wrong, and named no agent while doing it. Every command that surfaces problems
  // rather than crashing (`dev`, `check`, the dashboard) depends on this not happening.
  //
  // So an unplannable agent is skipped, and the fault stands as the explanation.
  const plannable = Object.entries(project.agents).filter(
    ([, spec]) => typeof spec?.role === "string" && spec.role.trim(),
  );
  const entries = await Promise.all(
    plannable.map(async ([name, spec]) => [name, await planAgent(project, spec, options)] as const),
  );
  return Object.fromEntries(entries);
}

/**
 * A workflow's `ask` steps that name no agent still need one. This builds a
 * general-purpose plan carrying the workflow's own knowledge.
 */
export async function planWorkflowAgent(
  project: Project,
  workflowName: string,
  knows: string[] | undefined,
  quality: Quality | undefined,
  options: PlanOptions = {},
): Promise<AgentPlan> {
  return planAgent(
    project,
    {
      kind: "agent",
      name: `${workflowName}:step`,
      role:
        "You are completing one step of a larger task. Do exactly what the step asks, " +
        "using the results of earlier steps. Be concise and concrete.",
      knows,
      quality,
    },
    options,
  );
}

export type { Rung } from "./models.js";
export type { ResolvedService } from "./services.js";
