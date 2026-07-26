/**
 * Turning the names in an agent's `tools` list into endpoints it can call.
 *
 * Every name resolves to a `tools/` file in the project. The framework ships no
 * list of known providers: a hard-coded endpoint is someone else's URL, someone
 * else's credential name, and someone else's product to rename or retire, and
 * an app is better off saying out loud what it talks to.
 */

import type { ToolSpec } from "../define.js";
import type { Env } from "./models.js";

/** A `tools/` definition with its credential resolved. */
export interface ResolvedService {
  name: string;
  url: string;
  description?: string;
  /** Absent when the credential is not in the environment. */
  apiKey?: string;
  credential: string;
  auth: "bearer" | "header";
  header?: string;
}

export interface ResolveServicesResult {
  services: ResolvedService[];
  /** Names that matched nothing, and names missing their credential. */
  problems: string[];
}

/**
 * Resolve an agent's `tools` list. A service whose credential is missing is
 * still returned — the dashboard shows it as unconfigured rather than the agent
 * silently losing an ability.
 */
export function resolveServices(
  names: string[],
  custom: Record<string, ToolSpec>,
  env: Env,
): ResolveServicesResult {
  const services: ResolvedService[] = [];
  const problems: string[] = [];

  for (const name of names) {
    const own = custom[name];
    if (!own) {
      problems.push(
        `unknown service "${name}" — add \`tools/${name}.ts\` with \`tool({ url })\``,
      );
      continue;
    }

    const credential = own.credential ?? `${name.toUpperCase()}_API_KEY`;
    const apiKey = env[credential];
    if (!apiKey) problems.push(`service "${name}" needs ${credential} in the environment`);

    services.push({
      name,
      url: own.url,
      description: own.description,
      apiKey,
      credential,
      auth: own.auth ?? "bearer",
      header: own.header,
    });
  }

  return { services, problems };
}
