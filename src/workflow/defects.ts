/**
 * What is wrong with a workflow before any of it runs.
 *
 * The loader could already see all of this — a step id used twice, an `after`
 * that names no sibling, two steps waiting on each other — and it wrote what it
 * found into `project.warnings`, which nothing on the run path ever read. A
 * diagnosis nobody acts on is worse than no diagnosis at all: the run goes
 * ahead, the scheduler finds nothing runnable, and the caller is handed
 * `{"status":"done","outputs":{}}` by the one component that knew better.
 *
 * So the check lives here, between the loader and the runner, and both use it.
 * The loader reports what it finds and keeps loading, because a broken workflow
 * must not take down the agent in the next folder. The runner refuses to start
 * on it, because there is no honest result to report from a graph that cannot
 * be walked.
 *
 * The line between the two lists is whether running would produce a lie.
 * A missing description is worth saying and costs nothing at run time; a cycle
 * makes every subsequent status field wrong.
 */

import { isEach, isRepeat, isWhen, type Step, type WorkflowSpec } from "../define.js";

/** Walk a step's nested steps, whatever kind it is. */
export function childrenOf(step: Step): Step[][] {
  if (isEach(step)) return [step.do];
  if (isRepeat(step)) return [step.repeat];
  if (isWhen(step)) return [...Object.values(step.is), step.otherwise ?? []];
  return [];
}

/** Every step in a workflow, including the ones nested inside branches and loops. */
export function walkSteps(steps: Step[] | undefined, visit: (step: Step) => void): void {
  for (const step of steps ?? []) {
    visit(step);
    for (const branch of childrenOf(step)) walkSteps(branch, visit);
  }
}

/** Depth-first search for a cycle in the `after` graph, returning the loop. */
export function findCycle(steps: Step[]): string[] | undefined {
  const edges = new Map(steps.map((step) => [step.id, step.after ?? []]));
  const state = new Map<string, "open" | "done">();
  const stack: string[] = [];

  const visit = (id: string): string[] | undefined => {
    const mark = state.get(id);
    if (mark === "done") return undefined;
    if (mark === "open") return [...stack.slice(stack.indexOf(id)), id];

    state.set(id, "open");
    stack.push(id);
    for (const next of edges.get(id) ?? []) {
      if (!edges.has(next)) continue;
      const found = visit(next);
      if (found) return found;
    }
    stack.pop();
    state.set(id, "done");
    return undefined;
  };

  for (const step of steps) {
    const found = visit(step.id);
    if (found) return found;
  }
  return undefined;
}

export interface Known {
  /**
   * The agents that exist. Left out, `agent:` references are not checked at
   * all — a caller driving a spec directly may hold no registry to check them
   * against, and inventing a refusal from an empty set would refuse everything.
   */
  agents?: Iterable<string>;
}

/**
 * Everything about a workflow that makes it unrunnable as written.
 *
 * Each message names the workflow, so the same sentence reads correctly whether
 * it lands in a loader warning or in the error that refused a run.
 */
export function defectsIn(spec: WorkflowSpec, known: Known = {}): string[] {
  const where = `workflow "${spec.name ?? "workflow"}"`;
  const agents = known.agents ? new Set(known.agents) : undefined;
  const found: string[] = [];

  if (!spec.steps?.length) {
    found.push(`${where}: needs at least one step`);
    return found;
  }

  const check = (steps: Step[]): void => {
    const seen = new Set<string>();
    for (const step of steps) {
      if (!step.id) {
        found.push(`${where}: every step needs an \`id\``);
        continue;
      }
      if (seen.has(step.id)) found.push(`${where}: duplicate step id "${step.id}"`);
      seen.add(step.id);
      if (agents && "ask" in step && step.agent && !agents.has(step.agent)) {
        found.push(`${where}: step "${step.id}" references unknown agent "${step.agent}"`);
      }
      if (isRepeat(step) && !(step.max > 0)) {
        found.push(
          `${where}: step "${step.id}" needs a positive \`max\` — a loop without one cannot end`,
        );
      }
      for (const branch of childrenOf(step)) check(branch);
    }

    // An `after` naming no sibling is NOT here, deliberately. The scheduler
    // defines it — such a dependency is dropped and the step runs — so the
    // workflow has a meaning, it runs, and what comes back is what the graph
    // says. It is still worth mentioning, so it is advice: see `danglingAfterIn`.
    const cycle = findCycle(steps);
    if (cycle) found.push(`${where}: steps wait on each other in a circle — ${cycle.join(" → ")}`);
  };

  check(spec.steps);
  return found;
}

/**
 * `after` entries naming nothing beside them.
 *
 * Advice rather than a defect: the scheduler drops such a dependency and runs
 * the step, which is a defined and reasonable answer to a graph that mentions a
 * step it does not contain. What it is not is what the author meant — an
 * ordering constraint has quietly gone missing — so it is said out loud.
 */
export function danglingAfterIn(spec: WorkflowSpec): string[] {
  const where = `workflow "${spec.name ?? "workflow"}"`;
  const found: string[] = [];

  const check = (steps: Step[]): void => {
    const beside = new Set(steps.map((step) => step.id));
    for (const step of steps) {
      for (const need of step.after ?? []) {
        if (!beside.has(need)) {
          found.push(
            `${where}: step "${step.id}" waits for "${need}", which is not a step beside it — that wait is dropped`,
          );
        }
      }
      for (const branch of childrenOf(step)) check(branch);
    }
  };

  check(spec.steps ?? []);
  return found;
}

/**
 * The names a step binds on top of what is already visible.
 *
 * These are in scope for the step's own checks as well as for the steps inside
 * it: a `repeat` reads `{{last}}` and `{{attempt}}` in its `until`, which is
 * written on the loop rather than in it.
 */
function bindingsOf(step: Step): string[] {
  if (isEach(step)) return [step.as ?? "item", "index"];
  if (isRepeat(step)) return ["attempt", "prior", "last"];
  return [];
}

/** `{{a.b}}` and `{{a[0].b}}` are both about `a`. */
function headOf(path: string): string {
  return path.replace(/\[(\d+)\]/g, ".$1").split(".").find(Boolean) ?? path;
}

const REFERENCE = /\{\{\s*([\w.[\]-]+)\s*\}\}/g;

/** Every `{{ref}}` written anywhere inside a value, at any depth. */
function referencesIn(value: unknown, into: Set<string>): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(REFERENCE)) into.add(match[1]!);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) referencesIn(item, into);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) referencesIn(item, into);
  }
}

/** The references one step writes, without descending into the steps nested in it. */
function ownReferences(step: Step): string[] {
  const found = new Set<string>();
  for (const [key, value] of Object.entries(step)) {
    if (key === "do" || key === "repeat" || key === "is" || key === "otherwise") continue;
    referencesIn(value, found);
  }
  return [...found];
}

/**
 * `{{ref}}`s that name nothing the step could see — caught before the run.
 *
 * This is only checkable for a workflow that declares its `input`, and that is
 * the whole rule: without a declaration there is no way to tell a typo from an
 * argument the caller will supply, and guessing would fill the dashboard with
 * warnings about references that are perfectly fine. Declaring inputs is what
 * buys the static check; the runtime refusal in `interpolate` catches the rest.
 *
 * Reported as advice rather than as a defect, because a caller may pass more
 * than was declared and being wrong here should cost a warning, not a run.
 */
export function looseReferencesIn(spec: WorkflowSpec): string[] {
  if (!spec.input || !Object.keys(spec.input).length) return [];
  const where = `workflow "${spec.name ?? "workflow"}"`;
  const found: string[] = [];

  const check = (steps: Step[], visible: Set<string>): void => {
    // A step may refer to any sibling, not only an earlier one: `after` reorders
    // the list, and a wrong order is a different diagnosis from a wrong name.
    const scope = new Set([...visible, ...steps.map((step) => step.id)]);
    for (const step of steps) {
      const here = new Set([...scope, ...bindingsOf(step)]);
      for (const ref of ownReferences(step)) {
        const head = headOf(ref);
        if (!here.has(head)) {
          found.push(
            `${where}: step "${step.id}" refers to \`{{${ref}}}\`, and nothing by that name is in scope there`,
          );
        }
      }
      for (const branch of childrenOf(step)) check(branch, here);
    }
  };

  check(spec.steps ?? [], new Set(Object.keys(spec.input)));
  return found;
}
