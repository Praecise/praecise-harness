/**
 * Praecise Cloud from the command line: sign in with a token, deploy a
 * project, see its releases, go back to an earlier one, and read its status
 * and logs.
 *
 * Every command is a small client of the Praecise Cloud API. It uses the
 * runtime's own `fetch`, adds no dependency, and never prints a token.
 */

import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { VERSION } from "./scaffold.js";

export const CLOUD_URL = "https://console.praecise.cloud";

/** What a command exits with, so a script can tell the outcomes apart. */
export const EXIT = { ok: 0, failed: 1, usage: 2, auth: 3, notFound: 4, conflict: 5 } as const;

/** Each command: its name, what it takes, and what it does. The help is built from this. */
export const CLOUD_HELP: readonly (readonly [name: string, takes: string, does: string])[] = [
  ["login", "", "sign in to Praecise Cloud with a token"],
  ["deploy", "[project]", "deploy a project; --wait follows it"],
  ["releases", "[project]", "the releases kept for a project"],
  ["rollback", "[release]", "serve an earlier release again"],
  ["status", "[project]", "how a project is doing, or all of yours"],
  ["logs", "[project]", "what the project wrote last; -n for more"],
  ["whoami", "", "who the token is and what it may do"],
];

export function isCloudCommand(name: string | undefined): boolean {
  return CLOUD_HELP.some(([known]) => known === name);
}

const HELP = `Praecise Cloud

${CLOUD_HELP.map(([name, takes, does]) => `  praecise ${`${name} ${takes}`.padEnd(20)} ${does}`).join("\n")}

Options
  --project <name>   the project (or set PRAECISE_PROJECT, or put
                     {"project": "name"} in praecise.json in the folder)
  --dir <path>       the folder to read praecise.json from (default: here)
  --wait             with deploy: stay until it has succeeded or failed
  -n, --lines <n>    with logs: how many lines, 1 to 2000 (default 200)
  --key <text>       with deploy and rollback: a name for this request, so
                     that running it again does not do the work twice
  --json             print the answer as JSON

A token comes from the Account page of the console. Paste it into
"praecise login", or set PRAECISE_CLOUD_TOKEN.

"praecise rollback" with no release goes back to the previous one.

Exit codes
  0  done
  1  the deploy or rollback failed, or the service could not be reached
  2  the command, or what it asked for, was not valid
  3  not signed in, or the token may not do that
  4  no such project, release or deploy
  5  a deploy is already running for the project
`;

/** Everything a command touches outside itself, so a test can stand in for it. */
export interface CloudIo {
  out(line: string): void;
  err(line: string): void;
  env: Record<string, string | undefined>;
  cwd: string;
  /** One line from the person, not echoed. */
  ask(question: string): Promise<string>;
  sleep(ms: number): Promise<void>;
}

const REQUEST_TIMEOUT_MS = 30_000;
// A rollback answers when the release is live and healthy, which takes minutes.
const ROLLBACK_TIMEOUT_MS = 290_000;
const DEPLOY_WAIT_MS = 30 * 60_000;
const POLL_MS = 3_000;
const RETRY_MS = 2_000;

const PROJECT = /^[a-z0-9][a-z0-9-]{0,62}$/;
const RELEASE = /^[A-Za-z0-9_-]{1,64}$/;
const KEY = /^[A-Za-z0-9_.:-]{1,128}$/;

const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Seconds since 1970, as the API gives times, in words a person reads. */
function when(seconds: unknown): string {
  if (typeof seconds !== "number" || !(seconds > 0)) return "";
  return `${new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

interface Flags {
  positional: string[];
  json: boolean;
  wait: boolean;
  help: boolean;
  project?: string;
  dir?: string;
  lines?: string;
  key?: string;
}

const TAKES_VALUE: Record<string, "project" | "dir" | "lines" | "key"> = {
  "--project": "project",
  "--dir": "dir",
  "--lines": "lines",
  "-n": "lines",
  "--key": "key",
};

export function parseCloudArgs(argv: string[]): Flags | { problem: string } {
  const flags: Flags = { positional: [], json: false, wait: false, help: false };
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index]!;
    if (!item.startsWith("-") || item === "-") {
      flags.positional.push(item);
    } else if (item === "--json") {
      flags.json = true;
    } else if (item === "--wait") {
      flags.wait = true;
    } else if (item === "--help" || item === "-h") {
      flags.help = true;
    } else {
      const cut = item.startsWith("--") ? item.indexOf("=") : -1;
      const name = cut === -1 ? item : item.slice(0, cut);
      const slot = TAKES_VALUE[name];
      if (!slot) return { problem: `unknown option: ${name}` };
      const value = cut === -1 ? argv[++index] : item.slice(cut + 1);
      if (value === undefined || value === "") return { problem: `${name} needs a value` };
      flags[slot] = value;
    }
  }
  return flags;
}

/** The exit code for an answer of the API. */
export function exitFor(httpStatus: number): number {
  if (httpStatus >= 200 && httpStatus < 300) return EXIT.ok;
  if (httpStatus === 400 || httpStatus === 422) return EXIT.usage;
  if (httpStatus === 401 || httpStatus === 403) return EXIT.auth;
  if (httpStatus === 404) return EXIT.notFound;
  if (httpStatus === 409) return EXIT.conflict;
  return EXIT.failed;
}

/** Where the token is kept: one file only its owner can read. */
export function tokenFile(env: Record<string, string | undefined>): string {
  const base = env.XDG_CONFIG_HOME ? env.XDG_CONFIG_HOME : join(homedir(), ".config");
  return join(base, "praecise", "cloud.json");
}

async function savedToken(env: Record<string, string | undefined>): Promise<string | undefined> {
  const fromEnv = env.PRAECISE_CLOUD_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    return text(record(JSON.parse(await readFile(tokenFile(env), "utf8"))).token);
  } catch {
    return undefined;
  }
}

async function saveToken(env: Record<string, string | undefined>, token: string): Promise<string> {
  const file = tokenFile(env);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify({ token }, null, 2)}\n`, { mode: 0o600 });
  // The mode above only applies to a new file; an older one is tightened here.
  await chmod(file, 0o600);
  return file;
}

/** The API's address. Plain http is accepted only for this machine, so a token never crosses a network unprotected. */
function baseUrl(env: Record<string, string | undefined>): string | undefined {
  const raw = (env.PRAECISE_CLOUD_URL?.trim() || CLOUD_URL).replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const thisMachine = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol === "https:" || (url.protocol === "http:" && thisMachine)) return raw;
  return undefined;
}

interface Context {
  io: CloudIo;
  base: string;
  token: string;
  json: boolean;
}

interface Answer {
  /** The HTTP status, or 0 when no answer arrived. */
  status: number;
  body: Record<string, unknown>;
  retryAfter: string | null;
}

async function request(
  ctx: Context,
  method: "GET" | "POST",
  path: string,
  options: { body?: unknown; key?: string; timeoutMs?: number } = {},
): Promise<Answer> {
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${ctx.token}`,
    "user-agent": `praecise-cli/${VERSION}`,
  };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.key) headers["idempotency-key"] = options.key;

  const once = async (): Promise<Answer> => {
    let response: Response;
    try {
      const init: RequestInit = { method, headers, signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS) };
      if (options.body !== undefined) init.body = JSON.stringify(options.body);
      response = await fetch(`${ctx.base}${path}`, init);
    } catch (error) {
      const late = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      return {
        status: 0,
        body: late
          ? { error: "Praecise Cloud did not answer in time", code: "timeout" }
          : { error: "could not reach Praecise Cloud", code: "unreachable" },
        retryAfter: null,
      };
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      parsed = undefined;
    }
    const body = record(parsed);
    if (!response.ok && !text(body.error)) {
      return { status: response.status, body: { error: `Praecise Cloud answered ${response.status}`, code: "failed" }, retryAfter: null };
    }
    return { status: response.status, body, retryAfter: response.headers.get("retry-after") };
  };

  // A request that never arrived is sent once more. A change carries its key,
  // so the second attempt cannot do the work twice.
  const first = await once();
  if (first.body.code !== "unreachable") return first;
  await ctx.io.sleep(RETRY_MS);
  return once();
}

function refuse(io: CloudIo, json: boolean, exit: number, message: string, code: string): number {
  if (json) io.out(JSON.stringify({ error: message, code }, null, 2));
  else io.err(`praecise: ${message}`);
  return exit;
}

const NEXT: Record<string, string> = {
  unauthenticated: "Create a token on the Account page of the console, then run: praecise login",
  token_revoked: "Create a new token on the Account page of the console, then run: praecise login",
  token_expired: "Create a new token on the Account page of the console, then run: praecise login",
  scope_missing: "This token was not given that permission. Create one that has it on the Account page of the console.",
  not_found: "See the projects this token can reach with: praecise status",
  deploy_running: "See how it is going with: praecise status",
  bad_release: "See the releases you can go back to with: praecise releases",
};

/** Say what the API refused and why, and answer the exit code for it. */
function fail(ctx: Context, answer: Answer): number {
  const message = text(answer.body.error) ?? `Praecise Cloud answered ${answer.status}`;
  const code = text(answer.body.code) ?? "failed";
  if (ctx.json) {
    ctx.io.out(JSON.stringify({ ...answer.body, error: message, code }, null, 2));
  } else {
    ctx.io.err(`praecise: ${message}`);
    const output = text(answer.body.output);
    if (output) ctx.io.err(output);
    if (code === "rate_limited" && answer.retryAfter) ctx.io.err(`Try again in ${answer.retryAfter} seconds.`);
    const next = NEXT[code];
    if (next) ctx.io.err(next);
  }
  return exitFor(answer.status);
}

/** The project a command is about: named on the line, in the environment, or in praecise.json. */
async function projectOf(io: CloudIo, flags: Flags, named: string | undefined): Promise<{ project?: string; problem?: string }> {
  let project = named ?? flags.project ?? io.env.PRAECISE_PROJECT?.trim();
  if (!project) {
    const file = join(resolve(io.cwd, flags.dir ?? "."), "praecise.json");
    let contents: string | undefined;
    try {
      contents = await readFile(file, "utf8");
    } catch {
      contents = undefined;
    }
    if (contents !== undefined) {
      try {
        project = text(record(JSON.parse(contents)).project);
      } catch {
        return { problem: "praecise.json is not valid JSON" };
      }
      if (!project) return { problem: 'praecise.json has no "project"' };
    }
  }
  if (!project) return {};
  if (!PROJECT.test(project)) return { problem: `"${project}" is not a project name: lower-case letters, digits and dashes` };
  return { project };
}

const WHICH_PROJECT = 'which project? Name it, set PRAECISE_PROJECT, or put {"project": "name"} in praecise.json in this folder';

function describeToken(token: Record<string, unknown>): string {
  const scopes = list(token.scopes).map(String).join(", ") || "read";
  const projects = Array.isArray(token.projects) ? token.projects.map(String).join(", ") : "all your projects";
  const expires = text(token.expires_at);
  return `It may ${scopes} on ${projects}${expires ? `, until ${expires.slice(0, 10)}` : ""}.`;
}

async function login(io: CloudIo, base: string, json: boolean): Promise<number> {
  const token = (await io.ask("Paste your Praecise Cloud token: ")).trim();
  if (!token) return refuse(io, json, EXIT.usage, "no token given", "bad_request");
  if (!token.startsWith("prc_")) return refuse(io, json, EXIT.usage, "that is not a Praecise Cloud token: they start with prc_cloud_", "bad_request");
  const ctx: Context = { io, base, token, json };
  const me = await request(ctx, "GET", "/api/whoami");
  if (me.status !== 200) return fail(ctx, me);
  const file = await saveToken(io.env, token);
  if (json) {
    io.out(JSON.stringify({ ...me.body, saved: file }, null, 2));
  } else {
    io.out(`Signed in as ${text(me.body.email) ?? "you"}.`);
    io.out(describeToken(record(me.body.token)));
    io.out(`The token is kept in ${file}, readable only by you.`);
  }
  return EXIT.ok;
}

async function whoami(ctx: Context): Promise<number> {
  const me = await request(ctx, "GET", "/api/whoami");
  if (me.status !== 200) return fail(ctx, me);
  if (ctx.json) {
    ctx.io.out(JSON.stringify(me.body, null, 2));
  } else {
    ctx.io.out(text(me.body.email) ?? "");
    ctx.io.out(describeToken(record(me.body.token)));
  }
  return EXIT.ok;
}

function serviceOf(project: Record<string, unknown>): string {
  const service = record(project.service);
  const state = text(service.state);
  if (!state) return "no service";
  const detail = text(service.detail);
  return detail ? `${state} (${detail})` : state;
}

async function statusAll(ctx: Context): Promise<number> {
  const answer = await request(ctx, "GET", "/api/projects");
  if (answer.status !== 200) return fail(ctx, answer);
  if (ctx.json) {
    ctx.io.out(JSON.stringify(answer.body, null, 2));
    return EXIT.ok;
  }
  const projects = list(answer.body.projects).map(record);
  if (!projects.length) {
    ctx.io.out("This token can see no projects yet.");
    return EXIT.ok;
  }
  const width = Math.max(...projects.map((p) => (text(p.name) ?? "").length));
  for (const p of projects) {
    ctx.io.out(`${(text(p.name) ?? "").padEnd(width)}  ${(text(p.release) ?? "no release").padEnd(18)}  ${serviceOf(p).padEnd(18)}  ${text(p.url) ?? ""}`.trimEnd());
  }
  return EXIT.ok;
}

async function status(ctx: Context, project: string): Promise<number> {
  const answer = await request(ctx, "GET", `/api/projects/${project}`);
  if (answer.status !== 200) return fail(ctx, answer);
  if (ctx.json) {
    ctx.io.out(JSON.stringify(answer.body, null, 2));
    return EXIT.ok;
  }
  const p = record(answer.body.project);
  const last = record(list(p.deploys)[0]);
  const rows: [string, string][] = [
    ["address", text(p.url) ?? ""],
    ["domains", list(p.domains).map(String).join(", ")],
    ["release", [text(p.release) ?? "none yet", when(p.released_at)].filter(Boolean).join(", since ")],
    ["service", serviceOf(p)],
    ["kept", `${list(p.releases).length} releases`],
    ["last deploy", text(last.id) ? `${String(last.id)}  ${text(last.status) ?? ""}  ${when(last.started_at)}`.trimEnd() : ""],
  ];
  ctx.io.out(text(p.name) ?? project);
  for (const [label, value] of rows) if (value) ctx.io.out(`  ${label.padEnd(12)} ${value}`);
  return EXIT.ok;
}

async function releases(ctx: Context, project: string): Promise<number> {
  const answer = await request(ctx, "GET", `/api/projects/${project}/releases`);
  if (answer.status !== 200) return fail(ctx, answer);
  if (ctx.json) {
    ctx.io.out(JSON.stringify(answer.body, null, 2));
    return EXIT.ok;
  }
  const kept = list(answer.body.releases).map(record);
  if (!kept.length) {
    ctx.io.out(`${project} has no releases yet. Make one with: praecise deploy`);
    return EXIT.ok;
  }
  for (const r of kept) ctx.io.out(`${r.current === true ? "*" : " "} ${(text(r.id) ?? "").padEnd(24)} ${when(r.released_at)}${r.current === true ? "  live" : ""}`);
  if (kept.length > 1) ctx.io.out("Go back to one with: praecise rollback <release>");
  return EXIT.ok;
}

async function logs(ctx: Context, project: string, asked: string | undefined): Promise<number> {
  let query = "";
  if (asked !== undefined) {
    const lines = /^\d{1,4}$/.test(asked) ? Number(asked) : 0;
    if (lines < 1 || lines > 2000) return refuse(ctx.io, ctx.json, EXIT.usage, "-n takes a number from 1 to 2000", "bad_request");
    query = `?lines=${lines}`;
  }
  const answer = await request(ctx, "GET", `/api/projects/${project}/logs${query}`);
  if (answer.status !== 200) return fail(ctx, answer);
  if (ctx.json) {
    ctx.io.out(JSON.stringify(answer.body, null, 2));
    return EXIT.ok;
  }
  for (const line of list(answer.body.lines)) ctx.io.out(String(line));
  const note = text(answer.body.note);
  if (note) ctx.io.err(note);
  return EXIT.ok;
}

async function rollback(ctx: Context, project: string, asked: string, key: string): Promise<number> {
  if (asked !== "previous" && !RELEASE.test(asked)) return refuse(ctx.io, ctx.json, EXIT.usage, `"${asked}" is not a release: give one from praecise releases, or "previous"`, "bad_release");
  if (!ctx.json) ctx.io.err(`Going back to ${asked === "previous" ? "the previous release" : asked} of ${project}. This can take a few minutes.`);
  const answer = await request(ctx, "POST", `/api/projects/${project}/rollback`, { body: { release: asked }, key, timeoutMs: ROLLBACK_TIMEOUT_MS });
  if (answer.body.code === "timeout") {
    return refuse(ctx.io, ctx.json, EXIT.failed, "no answer yet, and the rollback may still finish. See which release is live with: praecise releases", "timeout");
  }
  if (answer.status !== 200) return fail(ctx, answer);
  if (ctx.json) {
    ctx.io.out(JSON.stringify(answer.body, null, 2));
  } else {
    const from = text(answer.body.from);
    ctx.io.out(`${project} is now serving ${text(answer.body.release) ?? asked}${from ? ` (was ${from})` : ""}.`);
  }
  return EXIT.ok;
}

/** Print what a growing log has gained since the last look, whole lines only. */
function follower(io: CloudIo) {
  let seen = "";
  let held = "";
  const print = (added: string) => {
    const lines = (held + added).split("\n");
    held = lines.pop() ?? "";
    for (const line of lines) io.out(line);
  };
  return {
    take(log: string) {
      if (log.startsWith(seen)) {
        print(log.slice(seen.length));
      } else {
        // The log is long enough that its start was dropped: carry on from where the two overlap.
        const tail = seen.slice(-200);
        const at = tail ? log.lastIndexOf(tail) : -1;
        print(at === -1 ? log : log.slice(at + tail.length));
      }
      seen = log;
    },
    end() {
      if (held) io.out(held);
      held = "";
    },
  };
}

async function deploy(ctx: Context, project: string, wait: boolean, key: string): Promise<number> {
  const started = await request(ctx, "POST", `/api/projects/${project}/deploy`, { key });
  if (exitFor(started.status) !== EXIT.ok) return fail(ctx, started);
  const id = text(record(started.body.job).id);
  if (!wait || !id) {
    if (ctx.json) {
      ctx.io.out(JSON.stringify(started.body, null, 2));
    } else {
      ctx.io.out(`Deploy started for ${project}: ${id ?? ""}`.trimEnd());
      ctx.io.out("Stay until it is done with --wait, or see how it is going with: praecise status");
    }
    return EXIT.ok;
  }

  if (!ctx.json) ctx.io.err(`Deploying ${project} (${id}).`);
  const log = follower(ctx.io);
  const until = Date.now() + DEPLOY_WAIT_MS;
  let missed = 0;
  for (;;) {
    const seen = await request(ctx, "GET", `/api/projects/${project}/deploys/${encodeURIComponent(id)}`);
    if (seen.status !== 200) {
      // One bad answer while waiting is not the deploy failing: look again a few times first.
      const passing = seen.status === 0 || seen.status === 429 || seen.status >= 500;
      if (!passing || ++missed > 5) return fail(ctx, seen);
    } else {
      missed = 0;
      const state = text(record(seen.body.deploy).status);
      if (!ctx.json) log.take(text(seen.body.log) ?? "");
      if (state === "succeeded" || state === "failed") {
        if (ctx.json) {
          ctx.io.out(JSON.stringify(seen.body, null, 2));
        } else {
          log.end();
          const why = text(record(seen.body.deploy).error);
          if (state === "succeeded") ctx.io.out(`Deployed ${project}.`);
          else ctx.io.err(`praecise: the deploy failed${why ? `: ${why}` : ""}`);
        }
        return state === "succeeded" ? EXIT.ok : EXIT.failed;
      }
    }
    if (Date.now() > until) {
      if (!ctx.json) log.end();
      return refuse(ctx.io, ctx.json, EXIT.failed, "the deploy is still running after 30 minutes. See how it is going with: praecise status", "timeout");
    }
    await ctx.io.sleep(POLL_MS);
  }
}

/** Read one line without showing it, from a terminal or from whatever was piped in. */
function askHidden(question: string): Promise<string> {
  const input = process.stdin;
  process.stderr.write(question);
  if (!input.isTTY) {
    return new Promise((done) => {
      const lines = createInterface({ input });
      let answered = false;
      lines.once("line", (line) => {
        answered = true;
        lines.close();
        done(line);
      });
      lines.once("close", () => {
        if (!answered) done("");
      });
    });
  }
  return new Promise((done) => {
    let typed = "";
    const finish = (value: string) => {
      input.setRawMode(false);
      input.pause();
      input.off("data", onData);
      process.stderr.write("\n");
      done(value);
    };
    const onData = (chunk: Buffer | string) => {
      for (const ch of String(chunk)) {
        if (ch === "\r" || ch === "\n") {
          finish(typed);
          return;
        }
        if (ch === "\u0003") {
          finish("");
          return;
        }
        if (ch === "\u007f" || ch === "\b") typed = typed.slice(0, -1);
        else if (ch >= " ") typed += ch;
      }
    };
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

function systemIo(): CloudIo {
  return {
    out: (line) => {
      process.stdout.write(`${line}\n`);
    },
    err: (line) => {
      process.stderr.write(`${line}\n`);
    },
    env: process.env,
    cwd: process.cwd(),
    ask: askHidden,
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  };
}

/** Run one cloud command. `argv` starts with the command's name. */
export async function cloud(argv: string[], io: CloudIo = systemIo()): Promise<number> {
  const flags = parseCloudArgs(argv);
  if ("problem" in flags) return refuse(io, argv.includes("--json"), EXIT.usage, flags.problem, "bad_request");
  const [command, ...rest] = flags.positional;
  if (flags.help) {
    io.out(HELP);
    return EXIT.ok;
  }
  const usage = (message: string) => refuse(io, flags.json, EXIT.usage, message, "bad_request");
  if (!isCloudCommand(command)) return usage(`unknown command: ${command ?? ""}`);
  const takes = command === "login" || command === "whoami" ? 0 : 1;
  if (rest.length > takes) return usage(`${command} was given more than it takes: ${rest.slice(takes).join(" ")}`);
  if (flags.key !== undefined && !KEY.test(flags.key)) return usage("--key takes up to 128 letters, digits, dots, dashes, colons or underscores");

  const base = baseUrl(io.env);
  if (!base) return usage("PRAECISE_CLOUD_URL must be an https address");
  if (command === "login") return login(io, base, flags.json);

  const token = await savedToken(io.env);
  if (!token) return refuse(io, flags.json, EXIT.auth, "not signed in. Run praecise login, or set PRAECISE_CLOUD_TOKEN", "unauthenticated");
  const ctx: Context = { io, base, token, json: flags.json };
  if (command === "whoami") return whoami(ctx);

  // rollback names a release on the line; every other command names the project there.
  const found = await projectOf(io, flags, command === "rollback" ? undefined : rest[0]);
  if (found.problem) return usage(found.problem);
  const project = found.project;
  if (!project) return command === "status" ? statusAll(ctx) : usage(WHICH_PROJECT);

  switch (command) {
    case "deploy":
      return deploy(ctx, project, flags.wait, flags.key ?? randomUUID());
    case "rollback":
      return rollback(ctx, project, rest[0] ?? "previous", flags.key ?? randomUUID());
    case "releases":
      return releases(ctx, project);
    case "logs":
      return logs(ctx, project, flags.lines);
    default:
      return status(ctx, project);
  }
}
