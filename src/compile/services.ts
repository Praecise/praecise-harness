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
  /** Set when this service is reached over HTTP. Exactly one of url/command is set. */
  url?: string;
  /** Set when this service is a local program to launch. */
  command?: string[];
  /** Extra environment for a launched server. */
  env?: Record<string, string>;
  /**
   * Resource URIs this service was told to attach, `"*"` meaning everything it lists.
   *
   * Carried rather than resolved here: what a server actually holds is only knowable by
   * asking it, and compiling a plan must not require a network round trip. Reading them
   * is `collectResources`, at request time.
   */
  resources?: string[];
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

    // One or the other, never both and never neither. Guessing which was meant when
    // both are present would make the file lie about what the app talks to.
    const launched = Array.isArray(own.command) && own.command.length > 0;
    if (launched && own.url) {
      problems.push(`service "${name}" declares both a url and a command — say which one it is`);
      continue;
    }
    if (!launched && !own.url) {
      problems.push(`service "${name}" needs a url, or a command to launch a local server`);
      continue;
    }

    const credential = own.credential ?? `${name.toUpperCase()}_API_KEY`;
    const apiKey = env[credential];
    // A launched server takes its secrets from the environment it inherits, so a
    // missing credential is only a problem for one reached over the wire.
    if (!apiKey && !launched) problems.push(`service "${name}" needs ${credential} in the environment`);

    // An empty string is not a URI, and a list of them would become one failed read per
    // request with nothing to say about it. Dropped here, where the author can be told.
    const attached = (own.resources ?? []).map((uri) => uri.trim()).filter(Boolean);
    if (own.resources?.length && !attached.length) {
      problems.push(`service "${name}" lists resources, but none of them are URIs`);
    }

    services.push({
      name,
      url: own.url,
      command: launched ? own.command : undefined,
      env: own.env,
      resources: attached.length ? attached : undefined,
      description: own.description,
      apiKey,
      credential,
      auth: own.auth ?? "bearer",
      header: own.header,
    });
  }

  return { services, problems };
}
