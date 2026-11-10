/**
 * The Praecise Cloud commands, run against a small stand-in for the service:
 * every command, `--json`, and every exit code a script can branch on.
 */

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EXIT, cloud, exitFor, isCloudCommand, parseCloudArgs, tokenFile, type CloudIo } from "../src/cli/cloud.js";
import { main } from "../src/cli/index.js";

const GOOD = "prc_cloud_good-token-good-token";
const READ_ONLY = "prc_cloud_read-only-read-only";
const REVOKED = "prc_cloud_revoked-revoked";
const JOB = "shop-20261110-101500";

interface Seen {
  method: string;
  path: string;
  token: string;
  key: string | undefined;
  body: unknown;
}

/** A stand-in for the service: one project, two kept releases, and switches for what can go wrong. */
function service() {
  const state = {
    seen: [] as Seen[],
    releases: ["20261109-090000", "20261108-080000"],
    live: "20261109-090000",
    looks: 0,
    deployEnds: "succeeded" as "succeeded" | "failed",
    deployRunning: false,
    rollbackBreaks: false,
    limited: false,
  };

  const releases = () => state.releases.map((id, index) => ({ id, released_at: 1_794_000_000 - index * 86_400, current: id === state.live }));
  const project = () => ({
    name: "shop",
    domains: ["shop.example.com"],
    url: "https://shop.example.app",
    release: state.live,
    released_at: 1_794_000_000,
    release_count: state.releases.length,
    service: { state: "active", detail: "running", since: 1_794_000_000, restarts: 0 },
  });
  const job = (status: string, error: string | null = null) => ({ id: JOB, project: "shop", by: "ada@example.com", started_at: 1_794_000_100, finished_at: null, status, commit: null, error });
  const no = (status: number, error: string, code: string, extra: Record<string, unknown> = {}) => ({ status, body: { error, code, ...extra } });

  function answer(seen: Seen): { status: number; body: unknown; headers?: Record<string, string> } {
    if (seen.token === REVOKED) return no(401, "this token was revoked", "token_revoked");
    if (seen.token !== GOOD && seen.token !== READ_ONLY) return no(401, "send a token", "unauthenticated");
    if (state.limited) return { ...no(429, "too many requests", "rate_limited"), headers: { "retry-after": "7" } };
    const url = new URL(seen.path, "http://stand-in");
    const route = `${seen.method} ${url.pathname}`;

    if (route === "GET /api/whoami") {
      const scopes = seen.token === GOOD ? ["read", "deploy", "rollback"] : ["read"];
      return { status: 200, body: { email: "ada@example.com", via: "token", token: { id: "tok_1", scopes, projects: "all", expires_at: "2027-02-08T00:00:00.000Z" } } };
    }
    if (route === "GET /api/projects") return { status: 200, body: { projects: [project()] } };

    const [, name, rest = ""] = /^\/api\/projects\/([^/]+)(\/.*)?$/.exec(url.pathname) ?? [];
    if (name !== "shop") return no(404, "no such project", "not_found");
    const changes = seen.method === "POST";
    if (changes && seen.token === READ_ONLY) return no(403, "this token may not do that", "scope_missing");

    switch (`${seen.method} ${rest}`) {
      case "GET ":
        return { status: 200, body: { project: { ...project(), releases: releases(), env: [], deploys: [job("succeeded")], domain_status: {} } } };
      case "GET /releases":
        return { status: 200, body: { project: "shop", current: state.live, releases: releases() } };
      case "GET /logs": {
        const lines = Number(url.searchParams.get("lines") ?? 200);
        return { status: 200, body: { project: "shop", lines: Array.from({ length: Math.min(lines, 3) }, (_, i) => `line ${i + 1}`), note: null } };
      }
      case "POST /deploy":
        if (state.deployRunning) return no(409, "a deploy is already running for this project", "deploy_running");
        return { status: 202, body: { job: job("running") } };
      case `GET /deploys/${JOB}`: {
        state.looks += 1;
        if (state.looks < 2) return { status: 200, body: { deploy: job("running"), log: "building\n" } };
        if (state.deployEnds === "failed") return { status: 200, body: { deploy: job("failed", "the build stopped"), log: "building\nstopped\n" } };
        state.releases.unshift("20261110-101500");
        state.live = "20261110-101500";
        return { status: 200, body: { deploy: job("succeeded"), log: "building\nlive\n" } };
      }
      case "POST /rollback": {
        if (state.deployRunning) return no(409, "a deploy is running for this project", "deploy_running");
        const asked = (seen.body as { release?: string }).release;
        const to = asked === "previous" ? state.releases[state.releases.indexOf(state.live) + 1] : asked;
        if (!to || !state.releases.includes(to)) return no(400, "that release is not kept for this project", "bad_release");
        if (state.rollbackBreaks) return no(500, "the rollback did not complete", "rollback_failed", { release: to, output: "the release did not become healthy" });
        const from = state.live;
        state.live = to;
        return { status: 200, body: { ok: true, project: "shop", release: to, from, output: "", service: null } };
      }
      default:
        return no(404, "no such deploy", "not_found");
    }
  }

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const seen: Seen = {
        method: req.method ?? "",
        path: req.url ?? "",
        token: String(req.headers.authorization ?? "").replace(/^Bearer /, ""),
        key: typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"] : undefined,
        body: raw ? JSON.parse(raw) : undefined,
      };
      state.seen.push(seen);
      const made = answer(seen);
      res.writeHead(made.status, { "content-type": "application/json", ...made.headers });
      res.end(JSON.stringify(made.body));
    });
  });

  return {
    state,
    start: () =>
      new Promise<string>((done) => {
        server.listen(0, "127.0.0.1", () => done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
      }),
    stop: () =>
      new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}

let fake: ReturnType<typeof service>;
let url = "";
let home = "";

beforeEach(async () => {
  fake = service();
  url = await fake.start();
  home = await mkdtemp(join(tmpdir(), "praecise-cloud-test-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fake.stop();
  await rm(home, { recursive: true, force: true });
});

/** Run one command the way the terminal would, and collect what it printed. */
async function run(argv: string[], options: { env?: Record<string, string | undefined>; typed?: string } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CloudIo = {
    out: (line) => {
      out.push(line);
    },
    err: (line) => {
      err.push(line);
    },
    env: { PRAECISE_CLOUD_URL: url, PRAECISE_CLOUD_TOKEN: GOOD, XDG_CONFIG_HOME: home, ...options.env },
    cwd: home,
    ask: async () => options.typed ?? "",
    sleep: async () => {},
  };
  const code = await cloud(argv, io);
  return { code, out: out.join("\n"), err: err.join("\n"), json: () => JSON.parse(out.join("\n")) as Record<string, unknown> };
}

const paths = () => fake.state.seen.map((s) => `${s.method} ${s.path}`);

describe("praecise login", () => {
  it("keeps a working token in a file only its owner can read, and never prints it", async () => {
    const done = await run(["login"], { env: { PRAECISE_CLOUD_TOKEN: undefined }, typed: `  ${GOOD}\n` });
    expect(done.code).toBe(EXIT.ok);
    expect(done.out).toContain("Signed in as ada@example.com");
    expect(done.out + done.err).not.toContain(GOOD);

    const file = tokenFile({ XDG_CONFIG_HOME: home });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ token: GOOD });
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);

    // The saved token is what the next command signs in with.
    const next = await run(["whoami"], { env: { PRAECISE_CLOUD_TOKEN: undefined } });
    expect(next.code).toBe(EXIT.ok);
    expect(next.out).toContain("ada@example.com");
  });

  it("does not keep a token the service refuses", async () => {
    const done = await run(["login"], { env: { PRAECISE_CLOUD_TOKEN: undefined }, typed: "prc_cloud_never-issued" });
    expect(done.code).toBe(EXIT.auth);
    await expect(stat(tokenFile({ XDG_CONFIG_HOME: home }))).rejects.toThrow();
  });

  it("asks for a token and takes nothing else", async () => {
    expect((await run(["login"], { typed: "" })).code).toBe(EXIT.usage);
    expect((await run(["login"], { typed: "hunter2" })).code).toBe(EXIT.usage);
    expect(fake.state.seen).toEqual([]);
  });
});

describe("praecise whoami", () => {
  it("says who the token is and what it may do", async () => {
    const done = await run(["whoami"]);
    expect(done.code).toBe(EXIT.ok);
    expect(done.out).toContain("ada@example.com");
    expect(done.out).toContain("read, deploy, rollback on all your projects, until 2027-02-08");
  });

  it("prints the service's answer as JSON with --json", async () => {
    const done = await run(["whoami", "--json"]);
    expect(done.code).toBe(EXIT.ok);
    expect(done.json()).toMatchObject({ email: "ada@example.com", token: { id: "tok_1" } });
  });

  it("exits 3 with no token, without asking the service", async () => {
    const done = await run(["whoami"], { env: { PRAECISE_CLOUD_TOKEN: undefined } });
    expect(done.code).toBe(EXIT.auth);
    expect(done.err).toContain("praecise login");
    expect(fake.state.seen).toEqual([]);
  });

  it("exits 3 for a revoked token, as JSON when asked", async () => {
    const done = await run(["whoami", "--json"], { env: { PRAECISE_CLOUD_TOKEN: REVOKED } });
    expect(done.code).toBe(EXIT.auth);
    expect(done.json()).toEqual({ error: "this token was revoked", code: "token_revoked" });
  });
});

describe("praecise status", () => {
  it("lists every project the token can see when none is named", async () => {
    const done = await run(["status"]);
    expect(done.code).toBe(EXIT.ok);
    expect(done.out).toContain("shop");
    expect(done.out).toContain("20261109-090000");
    expect(paths()).toEqual(["GET /api/projects"]);
  });

  it("describes one project", async () => {
    const done = await run(["status", "shop"]);
    expect(done.code).toBe(EXIT.ok);
    expect(done.out).toContain("https://shop.example.app");
    expect(done.out).toContain("active (running)");
    expect(done.out).toContain("2 releases");
    expect((await run(["status", "shop", "--json"])).json()).toMatchObject({ project: { name: "shop" } });
  });

  it("exits 4 for a project that is not there", async () => {
    const done = await run(["status", "nothing-here"]);
    expect(done.code).toBe(EXIT.notFound);
    expect(done.err).toContain("no such project");
  });
});

describe("which project a command is about", () => {
  it("reads praecise.json in the folder", async () => {
    await writeFile(join(home, "praecise.json"), JSON.stringify({ project: "shop" }));
    expect((await run(["releases"])).code).toBe(EXIT.ok);
    expect(paths()).toEqual(["GET /api/projects/shop/releases"]);
  });

  it("prefers the command line, then the environment, then the file", async () => {
    await writeFile(join(home, "praecise.json"), JSON.stringify({ project: "from-file" }));
    await run(["releases"], { env: { PRAECISE_PROJECT: "from-env" } });
    await run(["releases", "--project", "from-flag"], { env: { PRAECISE_PROJECT: "from-env" } });
    await run(["releases", "named", "--project=from-flag"]);
    expect(paths()).toEqual(["GET /api/projects/from-env/releases", "GET /api/projects/from-flag/releases", "GET /api/projects/named/releases"]);
  });

  it("exits 2 when there is none, when the name is not one, or when the file is broken", async () => {
    expect((await run(["releases"])).code).toBe(EXIT.usage);
    expect((await run(["releases", "Not_A_Name"])).code).toBe(EXIT.usage);
    await writeFile(join(home, "praecise.json"), "{ nope");
    expect((await run(["deploy"])).code).toBe(EXIT.usage);
    expect(fake.state.seen).toEqual([]);
  });
});

describe("praecise releases", () => {
  it("lists the kept releases and marks the live one", async () => {
    const done = await run(["releases", "shop"]);
    expect(done.code).toBe(EXIT.ok);
    const [first, second] = done.out.split("\n");
    expect(first).toMatch(/^\* 20261109-090000 .* live$/);
    expect(second).toMatch(/^ {2}20261108-080000/);
  });

  it("prints them as JSON with --json", async () => {
    const done = await run(["releases", "shop", "--json"]);
    expect(done.json()).toMatchObject({ project: "shop", current: "20261109-090000" });
  });
});

describe("praecise deploy", () => {
  it("starts a deploy and says how to follow it", async () => {
    const done = await run(["deploy", "shop"]);
    expect(done.code).toBe(EXIT.ok);
    expect(done.out).toContain(JOB);
    const [sent] = fake.state.seen;
    expect(sent).toMatchObject({ method: "POST", path: "/api/projects/shop/deploy", token: GOOD });
    expect(sent?.key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("sends the key it is given, so a second run is the same request", async () => {
    await run(["deploy", "shop", "--key", "build-4021"]);
    expect(fake.state.seen[0]?.key).toBe("build-4021");
    expect((await run(["deploy", "shop", "--key", "not a key"])).code).toBe(EXIT.usage);
  });

  it("with --wait, follows the deploy to the end and prints its log once", async () => {
    const done = await run(["deploy", "shop", "--wait"]);
    expect(done.code).toBe(EXIT.ok);
    expect(done.out.split("\n")).toEqual(["building", "live", "Deployed shop."]);
    expect(paths()).toEqual(["POST /api/projects/shop/deploy", `GET /api/projects/shop/deploys/${JOB}`, `GET /api/projects/shop/deploys/${JOB}`]);
  });

  it("with --wait, exits 1 when the deploy fails and says why", async () => {
    fake.state.deployEnds = "failed";
    const done = await run(["deploy", "shop", "--wait"]);
    expect(done.code).toBe(EXIT.failed);
    expect(done.err).toContain("the deploy failed: the build stopped");
  });

  it("with --wait --json, prints only the finished deploy", async () => {
    const done = await run(["deploy", "shop", "--wait", "--json"]);
    expect(done.code).toBe(EXIT.ok);
    expect(done.json()).toMatchObject({ deploy: { id: JOB, status: "succeeded" } });
  });

  it("exits 5 when a deploy is already running", async () => {
    fake.state.deployRunning = true;
    const done = await run(["deploy", "shop"]);
    expect(done.code).toBe(EXIT.conflict);
    expect(done.err).toContain("already running");
  });

  it("exits 3 when the token may only read", async () => {
    const done = await run(["deploy", "shop", "--json"], { env: { PRAECISE_CLOUD_TOKEN: READ_ONLY } });
    expect(done.code).toBe(EXIT.auth);
    expect(done.json()).toMatchObject({ code: "scope_missing" });
  });
});

describe("praecise rollback", () => {
  it("goes back to the previous release when none is named", async () => {
    const done = await run(["rollback", "--project", "shop"]);
    expect(done.code).toBe(EXIT.ok);
    expect(done.out).toBe("shop is now serving 20261108-080000 (was 20261109-090000).");
    expect(fake.state.seen[0]).toMatchObject({ method: "POST", path: "/api/projects/shop/rollback", body: { release: "previous" } });
    expect(fake.state.seen[0]?.key).toBeTruthy();
  });

  it("goes back to a named release", async () => {
    const done = await run(["rollback", "20261108-080000", "--project", "shop", "--json"]);
    expect(done.code).toBe(EXIT.ok);
    expect(done.json()).toMatchObject({ ok: true, release: "20261108-080000", from: "20261109-090000" });
    expect(fake.state.seen[0]?.body).toEqual({ release: "20261108-080000" });
  });

  it("exits 2 for a release that is not kept", async () => {
    const done = await run(["rollback", "20200101-000000", "--project", "shop"]);
    expect(done.code).toBe(EXIT.usage);
    expect(done.err).toContain("praecise releases");
  });

  it("exits 2 for something that is not a release, without asking the service", async () => {
    expect((await run(["rollback", "../etc", "--project", "shop"])).code).toBe(EXIT.usage);
    expect(fake.state.seen).toEqual([]);
  });

  it("exits 1 when the rollback does not complete, and shows what happened", async () => {
    fake.state.rollbackBreaks = true;
    const done = await run(["rollback", "--project", "shop"]);
    expect(done.code).toBe(EXIT.failed);
    expect(done.err).toContain("the release did not become healthy");
  });

  it("exits 5 while a deploy is running", async () => {
    fake.state.deployRunning = true;
    expect((await run(["rollback", "--project", "shop"])).code).toBe(EXIT.conflict);
  });
});

describe("praecise logs", () => {
  it("prints the last lines", async () => {
    const done = await run(["logs", "shop"]);
    expect(done.code).toBe(EXIT.ok);
    expect(done.out.split("\n")).toEqual(["line 1", "line 2", "line 3"]);
    expect(paths()).toEqual(["GET /api/projects/shop/logs"]);
  });

  it("asks for as many lines as -n says", async () => {
    await run(["logs", "shop", "-n", "2"]);
    await run(["logs", "shop", "--lines=50", "--json"]);
    expect(paths()).toEqual(["GET /api/projects/shop/logs?lines=2", "GET /api/projects/shop/logs?lines=50"]);
  });

  it("exits 2 for a number of lines that is not one", async () => {
    expect((await run(["logs", "shop", "-n", "0"])).code).toBe(EXIT.usage);
    expect((await run(["logs", "shop", "-n", "lots"])).code).toBe(EXIT.usage);
    expect((await run(["logs", "shop", "-n"])).code).toBe(EXIT.usage);
    expect(fake.state.seen).toEqual([]);
  });
});

describe("what every command shares", () => {
  it("exits 2 for an option or an argument it does not take", async () => {
    expect((await run(["status", "--loud"])).code).toBe(EXIT.usage);
    expect((await run(["whoami", "extra"])).code).toBe(EXIT.usage);
    expect((await run(["deploy", "shop", "again"])).code).toBe(EXIT.usage);
    expect(fake.state.seen).toEqual([]);
  });

  it("prints a refusal as JSON on stdout with --json", async () => {
    const done = await run(["status", "nothing-here", "--json"]);
    expect(done.code).toBe(EXIT.notFound);
    expect(done.json()).toEqual({ error: "no such project", code: "not_found" });
    expect(done.err).toBe("");
  });

  it("says how long to wait when the service asks it to slow down", async () => {
    fake.state.limited = true;
    const done = await run(["status"]);
    expect(done.code).toBe(EXIT.failed);
    expect(done.err).toContain("Try again in 7 seconds");
  });

  it("exits 1 when the service cannot be reached, after trying once more", async () => {
    const gone = service();
    const closed = await gone.start();
    await gone.stop();
    const done = await run(["status"], { env: { PRAECISE_CLOUD_URL: closed } });
    expect(done.code).toBe(EXIT.failed);
    expect(done.err).toContain("could not reach Praecise Cloud");
  });

  it("will not send a token over plain http to another machine", async () => {
    const done = await run(["whoami"], { env: { PRAECISE_CLOUD_URL: "http://cloud.example.com" } });
    expect(done.code).toBe(EXIT.usage);
    expect(fake.state.seen).toEqual([]);
  });

  it("explains itself with --help", async () => {
    const done = await run(["deploy", "--help"]);
    expect(done.code).toBe(EXIT.ok);
    expect(done.out).toContain("praecise rollback");
    expect(done.out).toContain("Exit codes");
    expect(fake.state.seen).toEqual([]);
  });

  it("maps each kind of answer to its own exit code", () => {
    expect([200, 202, 400, 401, 403, 404, 409, 422, 429, 500, 0].map(exitFor)).toEqual([0, 0, 2, 3, 3, 4, 5, 2, 1, 1, 1]);
  });

  it("reads its options wherever they are put", () => {
    expect(parseCloudArgs(["--json", "logs", "-n", "5", "shop", "--project=other"])).toMatchObject({ positional: ["logs", "shop"], json: true, lines: "5", project: "other" });
    expect(parseCloudArgs(["deploy", "--wait", "shop"])).toMatchObject({ positional: ["deploy", "shop"], wait: true });
    expect(parseCloudArgs(["deploy", "--project"])).toEqual({ problem: "--project needs a value" });
    expect(isCloudCommand("rollback")).toBe(true);
    expect(isCloudCommand("init")).toBe(false);
  });
});

describe("the praecise command", () => {
  it("runs the cloud commands", async () => {
    vi.stubEnv("PRAECISE_CLOUD_URL", url);
    vi.stubEnv("PRAECISE_CLOUD_TOKEN", GOOD);
    const lines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => (lines.push(String(chunk)), true));
    expect(await main(["whoami", "--json"])).toBe(EXIT.ok);
    expect(JSON.parse(lines.join(""))).toMatchObject({ email: "ada@example.com" });
    expect(await main(["status", "nothing-here", "--json"])).toBe(EXIT.notFound);
  });

  it("lists them in its help", async () => {
    const lines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => (lines.push(String(chunk)), true));
    expect(await main(["help"])).toBe(0);
    for (const name of ["login", "deploy", "releases", "rollback", "status", "logs", "whoami"]) expect(lines.join("")).toContain(`praecise ${name}`);
  });
});
