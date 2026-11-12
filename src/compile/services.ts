/**
 * Turning the names in an agent's `tools` list into endpoints it can call.
 *
 * Every name resolves to a `tools/` file in the project. The framework ships no
 * list of known providers: a hard-coded endpoint is someone else's URL, someone
 * else's credential name, and someone else's product to rename or retire, and
 * an app is better off saying out loud what it talks to.
 */

import type { ServiceOAuth, ToolSpec } from "../define.js";
import type { MachineGrant } from "../harness/oauth.js";
import type { Env } from "./models.js";

/** A `tools/` definition with its credential resolved. */
export interface ResolvedService {
  name: string;
  /** Set when this service is reached over HTTP. Exactly one of url/command is set. */
  url?: string;
  /** Set when this service is a local program to launch. */
  command?: string[];
  /** Set when this service is an HTTP API described by OpenAPI rather than an MCP server. */
  openapi?: string | Record<string, unknown>;
  /** Overrides the document's own server, when it has none or the wrong one. */
  baseUrl?: string;
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
  /** Listen for tool-list changes and list again when one arrives. */
  watch?: boolean;
  /** Offer this server's skills: all it lists, or the ones at these addresses. */
  skills?: true | string[];
  /**
   * The grant this service's token comes from, with its secrets read from the
   * environment. Absent when the service declared none, or declared one whose secrets
   * are not set: a grant that cannot be made is a problem reported, not a request sent.
   */
  oauth?: MachineGrant;
}

/** The names a grant gives for its secrets, each looked up in the environment. */
function grantFrom(name: string, spec: ServiceOAuth, env: Env, problems: string[]): MachineGrant | undefined {
  const read = (variable: string | undefined, what: string): string | undefined => {
    if (!variable) return undefined;
    const value = env[variable];
    if (!value) problems.push(`service "${name}" needs ${variable} in the environment (${what})`);
    return value || undefined;
  };
  if (!spec.issuer || !spec.clientId) {
    problems.push(`service "${name}": \`oauth\` needs \`issuer\`, the authorization server its credentials belong to, and \`clientId\``);
    return undefined;
  }

  if (spec.grant === "client_credentials") {
    if (!spec.secret === !spec.key) {
      problems.push(
        `service "${name}": \`oauth\` with grant "client_credentials" names exactly one of \`secret\` and \`key\`, ` +
          `each the name of an environment variable`,
      );
      return undefined;
    }
    const secret = read(spec.secret, "its client secret");
    const key = read(spec.key, "the private key its assertion is signed with");
    if (!secret && !key) return undefined;
    return {
      grant: "client_credentials",
      issuer: spec.issuer,
      clientId: spec.clientId,
      ...(secret ? { clientSecret: secret } : {}),
      ...(key ? { key } : {}),
      ...(spec.kid ? { kid: spec.kid } : {}),
      ...(spec.scope?.length ? { scope: spec.scope } : {}),
    };
  }

  if (spec.grant === "id-jag") {
    if (!spec.idp || !spec.assertion) {
      problems.push(
        `service "${name}": \`oauth\` with grant "id-jag" needs \`idp\`, the identity provider's token endpoint, ` +
          `and \`assertion\`, the name of the environment variable holding the ID token from sign-in`,
      );
      return undefined;
    }
    const assertion = read(spec.assertion, "the ID token from the person's sign-in");
    const secret = read(spec.secret, "its client secret at the authorization server");
    const idpSecret = read(spec.idpSecret, "its client secret at the identity provider");
    if (!assertion || (spec.secret && !secret) || (spec.idpSecret && !idpSecret)) return undefined;
    return {
      grant: "id-jag",
      issuer: spec.issuer,
      clientId: spec.clientId,
      ...(secret ? { clientSecret: secret } : {}),
      idp: spec.idp,
      assertion,
      ...(spec.idpClientId ? { idpClientId: spec.idpClientId } : {}),
      ...(idpSecret ? { idpClientSecret: idpSecret } : {}),
      ...(spec.scope?.length ? { scope: spec.scope } : {}),
    };
  }

  problems.push(
    `service "${name}": \`oauth.grant\` is ${JSON.stringify((spec as { grant?: unknown }).grant ?? null)}; ` +
      `the grants made without a person are "client_credentials" and "id-jag"`,
  );
  return undefined;
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
    const described = own.openapi !== undefined;
    const kinds = [launched && "command", Boolean(own.url) && "url", described && "openapi"].filter(Boolean);
    if (kinds.length > 1) {
      problems.push(`service "${name}" declares ${kinds.join(" and ")} — say which one it is`);
      continue;
    }
    if (!kinds.length) {
      problems.push(
        `service "${name}" needs a url, a command to launch a local server, or an openapi description`,
      );
      continue;
    }

    const credential = own.credential ?? `${name.toUpperCase()}_API_KEY`;
    const apiKey = env[credential];
    // A launched server takes its secrets from the environment it inherits, so a
    // missing credential is only a problem for one reached over the wire.
    // A launched server takes its secrets from the environment it inherits. An OpenAPI
    // service may legitimately be a public API, so a missing credential is a fact about
    // it rather than a fault — it simply calls without one.
    // A service that names a grant gets its token there, and is asked for the grant's
    // secrets instead of a key. A launched program or an API description has no token
    // endpoint to be sent to, so a grant on one is a mistake worth naming.
    let oauth: MachineGrant | undefined;
    if (own.oauth && (launched || described)) {
      problems.push(`service "${name}" declares \`oauth\`, which is for an MCP server reached by url`);
    } else if (own.oauth) {
      oauth = grantFrom(name, own.oauth, env, problems);
    } else if (!apiKey && !launched && !described) {
      problems.push(`service "${name}" needs ${credential} in the environment`);
    }

    const skills =
      own.skills === true
        ? true
        : Array.isArray(own.skills)
          ? own.skills.map((uri) => uri.trim()).filter(Boolean)
          : undefined;
    if ((own.skills || own.watch) && described) {
      problems.push(`service "${name}" is an HTTP API, which has no skills to offer and no changes to watch for`);
    }

    // An empty string is not a URI, and a list of them would become one failed read per
    // request with nothing to say about it. Dropped here, where the author can be told.
    const attached = (own.resources ?? []).map((uri) => uri.trim()).filter(Boolean);
    if (own.resources?.length && !attached.length) {
      problems.push(`service "${name}" lists resources, but none of them are URIs`);
    }

    services.push({
      name,
      url: own.url,
      openapi: own.openapi,
      baseUrl: own.baseUrl,
      command: launched ? own.command : undefined,
      env: own.env,
      resources: attached.length ? attached : undefined,
      description: own.description,
      apiKey,
      credential,
      auth: own.auth ?? "bearer",
      header: own.header,
      ...(own.watch && !described ? { watch: true } : {}),
      ...(skills !== undefined && !described && (skills === true || skills.length) ? { skills } : {}),
      ...(oauth ? { oauth } : {}),
    });
  }

  return { services, problems };
}
