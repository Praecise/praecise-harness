/**
 * What a published capability says about itself in a catalogue.
 *
 * An agent's `meta` is for whoever is choosing among agents rather than calling one: a
 * version to pin, tags to filter by, the languages it works in, examples of what to ask
 * it. It is worked out here once, so that the agent card, the MCP tool list and the
 * discovery documents all say the same thing about the same agent, and none of them has
 * to know how the others spell it.
 *
 * Two kinds of fact are kept apart. What the author STATED (`meta.inputModes`) is
 * repeated as stated. What the framework can SEE — which kinds of attachment the
 * agent's model endpoints can be sent — is reported as `takes`, and only on the
 * surfaces that can actually carry an attachment to the agent. A card for a protocol
 * surface that reads text does not advertise images because a model behind it could
 * read them.
 */

import type { App } from "../app.js";
import type { AgentMeta } from "../define.js";
import { takesOf } from "../harness/modality.js";

/** The media type each kind of attachment is advertised as. */
const MEDIA: Record<string, string> = {
  image: "image/*",
  audio: "audio/*",
  video: "video/*",
  document: "application/pdf",
};

export interface Listing {
  /** The group it is published in: its own `group`, else the kind of thing it is. */
  group: string;
  /** `meta.tags` for an agent that has any, else its group. */
  tags: string[];
  /** The agent's `meta`, as written. Absent for anything that is not an agent, or has none. */
  meta?: AgentMeta;
  /**
   * What can be sent with a question, as media types, on a surface that carries
   * attachments: text, and whatever the agent's model endpoints take. Text alone for
   * anything that is not an agent.
   */
  takes: string[];
  /** What comes back: text, and JSON where the agent declares `returns`. */
  gives: string[];
}

const strings = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const kept = value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
  return kept.length ? kept : undefined;
};

/** What a published agent, workflow or function says about itself. */
export function listingOf(app: App, name: string): Listing {
  const agent = app.plans[name] ? app.project.agents[name] : undefined;
  const plan = app.plans[name];
  if (!plan) {
    const workflow = app.project.workflows[name];
    const group = workflow ? (workflow.group ?? "workflows") : (app.project.functions[name]?.group ?? "functions");
    return { group, tags: [group], takes: ["text/plain"], gives: ["text/plain"] };
  }
  const group = agent?.group ?? "agents";
  const meta = typeof agent?.meta === "object" && agent.meta !== null ? agent.meta : undefined;
  const kinds = new Set<string>();
  for (const rung of plan.rungs) for (const kind of takesOf(rung.wire, rung.takes)) kinds.add(kind);
  return {
    group,
    tags: strings(meta?.tags) ?? [group],
    ...(meta ? { meta } : {}),
    takes: ["text/plain", ...Object.keys(MEDIA).filter((kind) => kinds.has(kind)).map((kind) => MEDIA[kind]!)],
    gives: plan.returns ? ["application/json", "text/plain"] : ["text/plain"],
  };
}

/**
 * The fields of an A2A skill that come from a listing.
 *
 * Tags are the skill's own. Modes are what the author stated, and text otherwise: the
 * A2A surface hands an agent the text and data parts of a message, so that is what it
 * says it takes unless the author says more.
 */
export function skillListing(app: App, name: string): {
  tags: string[];
  examples?: string[];
  inputModes: string[];
  outputModes: string[];
} {
  const listed = listingOf(app, name);
  const examples = strings(listed.meta?.examples);
  return {
    tags: listed.tags,
    ...(examples ? { examples } : {}),
    inputModes: strings(listed.meta?.inputModes) ?? ["text/plain"],
    outputModes: strings(listed.meta?.outputModes) ?? ["text/plain"],
  };
}

/** The key an agent's `meta` is carried under on an MCP tool. */
export const META_KEY = "com.praecise/meta";

/** An agent's `meta` as the `_meta` of its MCP tool, or nothing where it has none. */
export function toolMeta(app: App, name: string): { _meta?: Record<string, unknown> } {
  const meta = listingOf(app, name).meta;
  return meta && Object.keys(meta).length ? { _meta: { [META_KEY]: meta } } : {};
}

/** A listing as the short note a discovery document adds after a description. Empty where there is nothing to add. */
export function listingNote(app: App, name: string): string {
  const listed = listingOf(app, name);
  const meta = listed.meta;
  const media = listed.takes.filter((mode) => mode !== "text/plain");
  const parts = [
    meta && strings(meta.tags) ? `Tags: ${strings(meta.tags)!.join(", ")}.` : "",
    meta && strings(meta.languages) ? `Languages: ${strings(meta.languages)!.join(", ")}.` : "",
    media.length ? `Takes attachments: ${media.join(", ")}.` : "",
    typeof meta?.version === "string" && meta.version.trim() ? `Version ${meta.version.trim()}.` : "",
  ].filter(Boolean);
  return parts.length ? ` ${parts.join(" ")}` : "";
}
