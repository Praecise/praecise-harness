/**
 * Specs in, runnable plans out.
 *
 * This is where the abstraction is actually paid for: an `AgentSpec` says what
 * an agent is for, and a `Plan` says which models to call in what order, with
 * what instructions, holding which credentials. Everything the runtime needs is
 * decided here so the runtime itself stays dumb.
 */

import type { AgentSpec, Effect, FunctionSpec, Quality, Returns } from "../define.js";
import { resolveKnows, type Doc, type Project } from "../project/load.js";
import { resolveServices, type ResolvedService } from "./services.js";
import { planModels, type Env, type Rung } from "./models.js";

/** Total characters of knowledge allowed into instructions before truncating. */
const KNOWLEDGE_BUDGET = 60_000;

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
  run(args: Record<string, unknown>): unknown | Promise<unknown>;
}

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
    parameters: schemaFor(spec.input),
    effect: spec.effect,
    run: (args) => spec.run(args),
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
  services: ResolvedService[];
  /** Functions from `functions/` this agent may call. */
  locals: LocalTool[];
  memory: boolean;
  /** A `stores/` name to remember into, instead of files in the state directory. */
  memoryStore?: string;
  /** How many past exchanges may come back into context. */
  memoryRecall?: number;
  returns?: Returns;
  greeting?: string;
  /** Non-fatal issues to surface in the dashboard. */
  problems: string[];
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

/** Compose instructions from role, rules, knowledge, examples, and output shape. */
function instructionsFor(spec: AgentSpec, docs: Doc[], problems: string[]): string {
  const parts: string[] = [spec.role.trim()];

  if (spec.rules?.length) {
    parts.push(
      section(
        "Rules you must follow, without exception:",
        spec.rules.map((r) => `- ${r}`).join("\n"),
      ),
    );
  }

  if (docs.length) {
    let budget = KNOWLEDGE_BUDGET;
    const chunks: string[] = [];
    for (const doc of docs) {
      if (budget <= 0) {
        problems.push(
          `knowledge exceeds ${KNOWLEDGE_BUDGET.toLocaleString()} characters; ` +
            `"${doc.name}" and later documents were left out`,
        );
        break;
      }
      const content = doc.content.slice(0, budget);
      budget -= content.length;
      chunks.push(`--- ${doc.name} ---\n${content.trim()}`);
    }
    parts.push(
      section(
        "Reference material. Ground your answers in this, and say so when it does not cover the question:",
        chunks.join("\n\n"),
      ),
    );
  }

  if (spec.examples?.length) {
    parts.push(
      section(
        "Examples of the expected response:",
        spec.examples
          .map((e) => `Input: ${e.input}\nOutput: ${e.output}`)
          .join("\n\n"),
      ),
    );
  }

  if (spec.returns) {
    const shape = Object.entries(spec.returns)
      .map(([field, hint]) => `  "${field}": ${hint}`)
      .join(",\n");
    parts.push(
      section(
        "Reply with JSON in exactly this shape, and nothing else:",
        `{\n${shape}\n}`,
      ),
    );
  }

  return parts.join("\n\n");
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
  const docs = spec.knows?.length
    ? await resolveKnows(project, spec.knows)
    : project.knowledge;
  if (spec.knows?.length && !docs.length) {
    problems.push(`\`knows\` matched no files: ${spec.knows.join(", ")}`);
  }

  // A name in `tools` is a local function if `functions/` claims it, and an MCP
  // service otherwise. Own code wins: it is the one the author can see.
  const named = spec.tools ?? [];
  const locals = named
    .filter((name) => project.functions[name])
    .map((name) => localToolFor(name, project.functions[name]!));
  const { services, problems: serviceProblems } = resolveServices(
    named.filter((name) => !project.functions[name]),
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
  if (!rungs.length) {
    problems.push(
      "no model endpoint configured — set PRAECISE_API_KEY to run on Praecise Cloud, " +
        "or add `models` to praecise.config.ts to point at your own",
    );
  }

  const name = spec.name ?? "agent";
  const remembers = typeof spec.memory === "object" && spec.memory !== null ? spec.memory : undefined;
  return {
    name,
    description: spec.description ?? summarize(spec.role),
    quality,
    instructions: instructionsFor(spec, docs, problems),
    rungs,
    services,
    locals,
    // Off unless asked for: memory is a way to stop replaying a long thread,
    // not a way to make an agent better at answering.
    memory: spec.memory === true || remembers !== undefined,
    memoryStore: remembers?.store,
    memoryRecall: Math.max(1, Math.trunc(remembers?.recall ?? DEFAULT_RECALL)),
    returns: spec.returns,
    greeting: spec.greeting,
    problems,
  };
}

/** Plan every agent in a project, keyed by name. */
export async function planProject(
  project: Project,
  options: PlanOptions = {},
): Promise<Record<string, AgentPlan>> {
  const entries = await Promise.all(
    Object.entries(project.agents).map(
      async ([name, spec]) => [name, await planAgent(project, spec, options)] as const,
    ),
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
