/**
 * Signing a person in to a platform: the browser, the way back, and the exchange.
 *
 * An authorization-code flow with PKCE for a client the platform already knows by id.
 * The person is sent to the platform's own page, picks what the app may reach there, and
 * comes back to an address on this machine that only listens for that one answer.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";

import { challengeFor, randomString } from "../harness/oauth.js";

export interface Grant {
  access_token: string;
  refresh_token?: string;
  /** When the access token stops working, in milliseconds since the epoch. */
  expiresAt?: number;
  scope?: string[];
}

export interface AuthorizationCode {
  kind: "authorization_code";
  /** The id the platform knows this client by. */
  clientId: string;
  /** The NAME of the environment variable holding a client secret, for a platform that needs one. */
  clientSecret?: string;
  /** The platform's page a person signs in on. */
  authorize: string;
  /** Where a code is exchanged for a token. */
  token: string;
  /** Who the platform says it is in its answer (`iss`), where it says. Checked when present. */
  issuer?: string;
  /** The address on this machine the platform sends the person back to. */
  callback?: { port?: number; path?: string };
  /** Anything else the platform's page needs in its address. */
  params?: Record<string, string>;
}

export interface SignInTools {
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  /** Show the person the page. The default opens the browser and prints the address. */
  open?: (url: string) => void | Promise<void>;
  out?: (line: string) => void;
  /** How long to wait for the person, in milliseconds. */
  timeoutMs?: number;
}

function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(command as string, args as string[], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    // The address is printed as well, so a machine with no browser can still be used.
  }
}

const DONE_PAGE =
  "<!doctype html><meta charset=utf-8><title>Connected</title>" +
  "<body style=\"font:16px system-ui;margin:4rem auto;max-width:28rem\">" +
  "<h1 style=\"font-size:1.25rem\">Connected</h1><p>You can close this window and return to the terminal.</p>";

/** Wait on this machine for the platform to send the person back, once. */
function listen(
  port: number,
  path: string,
  timeoutMs: number,
): Promise<{ address: string; answer: Promise<URLSearchParams>; close(): void }> {
  return new Promise((resolve, reject) => {
    let settle: (params: URLSearchParams) => void = () => {};
    let fail: (err: Error) => void = () => {};
    const answer = new Promise<URLSearchParams>((yes, no) => {
      settle = yes;
      fail = no;
    });
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== path) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(DONE_PAGE);
      settle(url.searchParams);
    });
    const timer = setTimeout(() => fail(new Error("nobody finished signing in before the wait ended")), timeoutMs);
    const close = (): void => {
      clearTimeout(timer);
      server.close();
    };
    server.on("error", reject);
    // Loopback only: the answer carries a code, and nothing else on the network should be able to send one.
    server.listen(port, "127.0.0.1", () => {
      const bound = server.address();
      const actual = typeof bound === "object" && bound ? bound.port : port;
      resolve({ address: `http://localhost:${actual}${path}`, answer, close });
    });
  });
}

async function exchange(
  spec: AuthorizationCode,
  body: URLSearchParams,
  tools: Pick<SignInTools, "fetch" | "env">,
): Promise<Grant> {
  if (spec.clientSecret) {
    const secret = tools.env[spec.clientSecret];
    if (!secret) throw new Error(`${spec.clientSecret} is not set`);
    body.set("client_secret", secret);
  }
  const response = await tools.fetch(spec.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  const text = await response.text();
  let said: Record<string, unknown>;
  try {
    said = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${new URL(spec.token).host} did not answer the exchange with JSON (${response.status})`);
  }
  if (!response.ok || typeof said.access_token !== "string") {
    // The platform's own words, and never the request: the request carries the code.
    const why = typeof said.error_description === "string" ? said.error_description : JSON.stringify(said.error ?? response.status);
    throw new Error(`${new URL(spec.token).host} refused the exchange: ${why}`);
  }
  const seconds = typeof said.expires_in === "number" ? said.expires_in : Number(said.expires_in);
  return {
    access_token: said.access_token,
    ...(typeof said.refresh_token === "string" ? { refresh_token: said.refresh_token } : {}),
    ...(Number.isFinite(seconds) && seconds > 0 ? { expiresAt: Date.now() + seconds * 1000 } : {}),
    ...(typeof said.scope === "string" ? { scope: said.scope.split(/[\s,]+/).filter(Boolean) } : {}),
  };
}

/** Sign a person in and give back what the platform granted. */
export async function authorize(spec: AuthorizationCode, scope: string[], tools: SignInTools): Promise<Grant> {
  if (!spec.clientId) throw new Error("this environment has no client id to sign in with");
  const waiting = await listen(spec.callback?.port ?? 0, spec.callback?.path ?? "/callback", tools.timeoutMs ?? 300_000);
  try {
    const verifier = randomString();
    const state = randomString(16);
    const url = new URL(spec.authorize);
    for (const [key, value] of Object.entries(spec.params ?? {})) url.searchParams.set(key, value);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", spec.clientId);
    url.searchParams.set("redirect_uri", waiting.address);
    url.searchParams.set("code_challenge", await challengeFor(verifier));
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    if (scope.length) url.searchParams.set("scope", scope.join(" "));

    tools.out?.(`Sign in at: ${url.toString()}`);
    await (tools.open ?? openInBrowser)(url.toString());

    const params = await waiting.answer;
    // Checked before anything in the answer is believed, the error included.
    if (params.get("state") !== state) throw new Error("the answer does not belong to the sign-in that was started");
    const iss = params.get("iss");
    if (iss !== null && spec.issuer !== undefined && iss !== spec.issuer) {
      throw new Error(`the answer came from "${iss}" and was asked of "${spec.issuer}"`);
    }
    const error = params.get("error");
    if (error) throw new Error(`sign-in was refused: ${params.get("error_description") ?? error}`);
    const code = params.get("code");
    if (!code) throw new Error("the answer carried no code");

    return await exchange(
      spec,
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: waiting.address,
        client_id: spec.clientId,
        code_verifier: verifier,
      }),
      tools,
    );
  } finally {
    waiting.close();
  }
}

/** Renew a grant that came with the means to renew it. */
export async function renew(spec: AuthorizationCode, grant: Grant, tools: Pick<SignInTools, "fetch" | "env">): Promise<Grant> {
  if (!grant.refresh_token) throw new Error("this sign-in cannot be renewed without the person");
  const renewed = await exchange(
    spec,
    new URLSearchParams({ grant_type: "refresh_token", refresh_token: grant.refresh_token, client_id: spec.clientId }),
    tools,
  );
  return { ...renewed, refresh_token: renewed.refresh_token ?? grant.refresh_token, scope: renewed.scope ?? grant.scope };
}
