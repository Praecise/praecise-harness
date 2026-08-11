/**
 * W3C PROV-DM provenance, derived from a run.
 *
 * A read-side derivation of the Article-12 audit substrate: which Activity (step)
 * generated which Entity (output), under which Agent (the workflow), and — for gated
 * steps — on whose behalf a human approver acted. It reads only what the run already
 * records (outputs, events, the approvals ledger) and never changes execution.
 *
 * Honest scope: `used` (input-consumption) edges are omitted. praecise's scope
 * exposes every prior output to a step, so which inputs a step actually read is not
 * recorded; asserting `used` edges would overstate the provenance.
 */
import type { Run } from "./store.js";

export interface ProvGraph {
  entities: { id: string; value?: unknown }[];
  activities: { id: string; endedAt?: number }[];
  agents: { id: string; kind: "workflow" | "human" }[];
  wasGeneratedBy: { entity: string; activity: string }[];
  wasAssociatedWith: { activity: string; agent: string }[];
  wasAttributedTo: { entity: string; agent: string }[];
  actedOnBehalfOf: { delegate: string; responsible: string }[];
}

export function provenanceOf(run: Run): ProvGraph {
  const workflowAgent = `workflow:${run.workflow}`;
  const agents: ProvGraph["agents"] = [{ id: workflowAgent, kind: "workflow" }];
  const activities: ProvGraph["activities"] = [];
  const entities: ProvGraph["entities"] = [];
  const wasGeneratedBy: ProvGraph["wasGeneratedBy"] = [];
  const wasAssociatedWith: ProvGraph["wasAssociatedWith"] = [];
  const wasAttributedTo: ProvGraph["wasAttributedTo"] = [];
  const actedOnBehalfOf: ProvGraph["actedOnBehalfOf"] = [];

  const endedAt = new Map<string, number>();
  for (const e of run.events) if (e.kind === "done") endedAt.set(e.step, e.at);

  for (const [step, value] of Object.entries(run.outputs)) {
    const ent = `${step}#out`;
    activities.push({ id: step, endedAt: endedAt.get(step) });
    entities.push({ id: ent, value });
    wasGeneratedBy.push({ entity: ent, activity: step });
    wasAssociatedWith.push({ activity: step, agent: workflowAgent });
    wasAttributedTo.push({ entity: ent, agent: workflowAgent });
  }

  for (const a of run.approvals ?? []) {
    const human = `human:${a.approver ?? "anonymous"}`;
    if (!agents.some((g) => g.id === human)) agents.push({ id: human, kind: "human" });
    if (!activities.some((x) => x.id === a.step)) activities.push({ id: a.step, endedAt: a.at });
    wasAssociatedWith.push({ activity: a.step, agent: human });
    actedOnBehalfOf.push({ delegate: workflowAgent, responsible: human });
  }

  return { entities, activities, agents, wasGeneratedBy, wasAssociatedWith, wasAttributedTo, actedOnBehalfOf };
}
