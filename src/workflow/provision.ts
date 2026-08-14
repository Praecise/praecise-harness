/**
 * Turning a brief into a graph.
 *
 * This is the one place a model is allowed to decide the shape of the work. It
 * is asked once, given the app's own manifest as its palette, and what comes
 * back is checked before any of it runs: ids must be unique, `after` may only
 * name a step declared earlier in the same batch, an agent must be one that
 * exists, and a tool must be one the app actually has. A plan that references
 * something imaginary is repaired by dropping the reference, not by trusting it.
 *
 * Deciding what to do next on every step is itself a model call, so the plan is
 * produced whole and then executed structurally. What that buys is not just
 * speed: independent steps come back with no `after` between them, and the
 * scheduler runs them at once, which is where research fans out.
 */

import type { AgentPlan } from "../compile/plan.js";
import type { Step } from "../define.js";
import type { Harness } from "../harness/types.js";
import type { ProvisionRequest, ProvisionResult } from "./run.js";

/** What the planner is allowed to build from. */
export interface Manifest {
  agents: { name: string; description: string }[];
  tools: { name: string; description?: string }[];
}

export interface ProvisionerDeps {
  harness: Harness;
  /** A plan to think with. The workflow's general-purpose agent will do. */
  planner(): Promise<AgentPlan>;
  manifest(): Manifest | Promise<Manifest>;
}

const RULES = `You are laying out the work for a task, as a list of steps that will be run for you.

Reply with a JSON array and nothing else. Each step is one of:

  {"id": "...", "ask": "what to do, in plain language", "agent": "<name>", "after": ["id", ...]}
  {"id": "...", "use": "<tool>", "with": { ... }, "after": ["id", ...]}

Rules:
- "id" is a short lowercase identifier, unique in this list.
- "after" lists ids of steps from THIS list that must finish first. Omit it when
  the step does not depend on anything.
- Steps that do not depend on each other run AT THE SAME TIME. Leave "after" off
  wherever you can: it is what makes the work parallel. Only add it when a step
  genuinely needs an earlier step's result.
- Refer to an earlier step's output inside a later step with {{id}}.
- "agent" must be one of the agents listed. Leave it out for general work.
- "use" must be one of the tools listed. Never invent one.
- Prefer few, substantial steps over many small ones.`;

function slug(value: unknown, fallback: string): string {
  const text = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return text || fallback;
}

/** Pull the JSON array out of a reply, whether or not it was fenced or wrapped. */
function parseSteps(text: string): unknown[] {
  const unfenced = text.replace(/^\s*```(?:json)?\s*\n?/, "").replace(/\n?\s*```\s*$/, "");
  const start = unfenced.indexOf("[");
  const end = unfenced.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const value: unknown = JSON.parse(unfenced.slice(start, end + 1));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

/**
 * Keep what is runnable and say what was dropped.
 *
 * Everything here is a repair rather than a rejection: one bad reference should
 * cost that reference, not the whole plan.
 */
export function checkSteps(
  raw: unknown[],
  allowed: { agents: Set<string>; tools: Set<string>; max: number },
): { steps: Step[]; notes: string[] } {
  const steps: Step[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();

  for (const candidate of raw.slice(0, allowed.max)) {
    if (!candidate || typeof candidate !== "object") continue;
    const item = candidate as Record<string, unknown>;

    let id = slug(item.id, `step_${steps.length + 1}`);
    while (seen.has(id)) id = `${id}_${seen.size}`;

    // `after` may only look backwards, which is what rules out a cycle.
    const after = (Array.isArray(item.after) ? item.after : [])
      .map((need) => slug(need, ""))
      .filter((need) => seen.has(need));

    if (typeof item.use === "string") {
      const tool = item.use;
      if (!allowed.tools.has(tool)) {
        notes.push(`dropped step "${id}": there is no tool called "${tool}"`);
        continue;
      }
      steps.push({ id, use: tool, with: item.with, ...(after.length ? { after } : {}) });
    } else if (typeof item.ask === "string" && item.ask.trim()) {
      const agent = typeof item.agent === "string" ? item.agent : undefined;
      if (agent && !allowed.agents.has(agent)) {
        notes.push(`step "${id}" asked for agent "${agent}", which does not exist — using a general one`);
      }
      steps.push({
        id,
        ask: item.ask,
        ...(agent && allowed.agents.has(agent) ? { agent } : {}),
        ...(after.length ? { after } : {}),
      });
    } else {
      notes.push(`dropped step "${id}": it is neither an ask nor a use`);
      continue;
    }

    seen.add(id);
  }

  if (raw.length > allowed.max) {
    notes.push(`the plan had ${raw.length} steps; only the first ${allowed.max} were kept`);
  }
  return { steps, notes };
}

function describe(manifest: Manifest): string {
  const agents = manifest.agents.length
    ? manifest.agents.map((a) => `- ${a.name}: ${a.description}`).join("\n")
    : "- (none; leave \"agent\" out of every step)";
  const tools = manifest.tools.length
    ? manifest.tools.map((t) => `- ${t.name}${t.description ? `: ${t.description}` : ""}`).join("\n")
    : "- (none; do not use \"use\" steps)";
  return `Agents you may delegate to:\n${agents}\n\nTools you may call:\n${tools}`;
}

/** Build the `provision` function a workflow runner needs for its `plan` steps. */
export function provisioner(deps: ProvisionerDeps) {
  return async function provision(request: ProvisionRequest): Promise<ProvisionResult> {
    const manifest = await deps.manifest();
    const palette = request.from.length
      ? manifest.agents.filter((a) => request.from.includes(a.name))
      : manifest.agents;
    // Least privilege, and no escalation. A plan builds only from tools it was
    // granted, and an author who said nothing about tools granted none — the
    // opposite reading handed a model-authored graph every tool the app has,
    // `effect: "destructive"` included, as the reward for not thinking about it.
    // Naming them is cheap; discovering afterwards which one a planner reached
    // for is not.
    const grantedTools = request.tools
      ? manifest.tools.filter((t) => request.tools!.includes(t.name))
      : [];

    const known = Object.keys(request.scope);
    const question = [
      RULES,
      describe({ agents: palette, tools: grantedTools }),
      known.length ? `Already available to refer to with {{name}}: ${known.join(", ")}` : "",
      `Use at most ${request.max} steps.`,
      request.because
        ? `A previous attempt at this failed with: ${request.because}\nLay out a different approach that avoids it.`
        : "",
      `The task:\n${request.brief}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    // The runner's harness, not this provisioner's: it is metered against the
    // run's budget and bounded by the run's timeout, and a planning call is the
    // one completion in a run that must be neither free nor unbounded.
    const answer = await (request.harness ?? deps.harness).ask(await deps.planner(), question);
    const { steps, notes } = checkSteps(parseSteps(answer.text), {
      agents: new Set(palette.map((a) => a.name)),
      tools: new Set(grantedTools.map((t) => t.name)),
      max: request.max,
    });

    if (!steps.length) notes.push("the planner did not return a runnable step");
    return { steps, notes };
  };
}
