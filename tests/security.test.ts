/**
 * The assumptions a published framework is not allowed to make.
 *
 * Every test here stands for one thing that used to be true because of where the
 * code was expected to run — only I can reach this port, the operator is the only
 * caller, the file is on my laptop, the archive is the size it says it is. A
 * framework cannot know any of that, so each of them is either gone or loud, and
 * each test is the sentence that says which.
 */

import { mkdtemp, rm, stat } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync, deflateSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentPlan } from "../src/compile/plan.js";
import { num } from "../src/codec.js";
import { workflow } from "../src/define.js";
import type { Answer, Harness } from "../src/harness/types.js";
import { pdfToText } from "../src/ingest/pdf.js";
import { unzip } from "../src/ingest/unzip.js";
import { redact } from "../src/redact.js";
import { serve, type DevServer } from "../src/server/index.js";
import { escapeHtml } from "../src/server/ui.js";
import { provisioner } from "../src/workflow/provision.js";
import { provenanceOf } from "../src/workflow/provenance.js";
import { resumeRun, startRun, type ApprovalClaim, type WorkflowDeps } from "../src/workflow/run.js";
import { RunStore } from "../src/workflow/store.js";
import {
  FRAMEWORK,
  MODEL_ENV,
  TEST_ENDPOINT,
  TEST_TOKEN,
  authed,
  cleanup,
  makeProject,
  stubModel,
} from "./helpers.js";

const plan: AgentPlan = {
  name: "test",
  description: "test",
  quality: "fast",
  instructions: "",
  rungs: [],
  services: [],
  locals: [],
  memory: false,
  problems: [],
};

function answer(text: string, usage = { inputTokens: 0, outputTokens: 0 }): Answer {
  return {
    text,
    path: ["stub"],
    usage: { ...usage, cachedTokens: 0, decidingTokens: 0 },
    toolCalls: [],
    harness: "stub",
  };
}

let dir: string;
let store: RunStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "praecise-sec-"));
  store = new RunStore(join(dir, "runs"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The smallest set of deps a run needs, with everything optional left out. */
function deps(
  reply: (input: string) => Answer = () => answer("ok"),
  extra: Partial<WorkflowDeps> = {},
): WorkflowDeps {
  const harness: Harness = { name: "stub", async ask(_p, input) { return reply(input); } };
  return {
    harness,
    store,
    planFor: async () => plan,
    callTool: async () => ({ ok: true }),
    ...extra,
  };
}

/** A verifier for tests: a signature reads `signed:<who>` and proves `<who>`. */
const verify = async (_claim: ApprovalClaim, signature: string) =>
  signature.startsWith("signed:") ? signature.slice("signed:".length) : undefined;

// ── 1.1 the stamp was not a signature ──────────────────────────────────────

describe("1.1 an approval is signed or it says it is not", () => {
  const gated = workflow({ name: "gate", steps: [{ id: "ok", approve: "Ship?" }, { id: "after", ask: "done" }] });

  it("invents no signature when no signer is wired, and says the entry is unsigned", async () => {
    const started = await startRun(gated, {}, deps());
    const done = await resumeRun(started.id, { approved: true, approver: "cfo@acme" }, gated, deps());

    const entry = done.approvals?.[0];
    // The old stamp was `sig-stub:<32-bit hash of runId:step:approver>` — every
    // input public, so anyone holding a run id could produce any approver's.
    expect(entry?.signature).toBeUndefined();
    expect(entry?.unsigned).toBe(true);
    expect(JSON.stringify(done)).not.toContain("sig-stub");
  });

  it("records what an injected signer produced, and the subject the verifier proved", async () => {
    const signed = deps(() => answer("ok"), {
      sign: async (claim) => `signed:${claim.approver}`,
      verify,
    });
    const started = await startRun(gated, {}, signed);
    const done = await resumeRun(started.id, { approved: true, approver: "cfo@acme" }, gated, signed);

    expect(done.approvals?.[0]).toMatchObject({
      signature: "signed:cfo@acme",
      subject: "cfo@acme",
    });
    expect(done.approvals?.[0]?.unsigned).toBeUndefined();
    // And a proved identity is marked as such in the provenance graph, where an
    // unverified one is not.
    expect(provenanceOf(done).agents).toContainEqual({
      id: "human:cfo@acme",
      kind: "human",
      verified: true,
    });
  });

  it("signs the whole claim, not just the parts a caller can guess", async () => {
    const seen: ApprovalClaim[] = [];
    const signed = deps(() => answer("ok"), {
      sign: async (claim) => {
        seen.push(claim);
        return "signed:x";
      },
      verify,
    });
    const started = await startRun(gated, {}, signed);
    await resumeRun(started.id, { approved: true, approver: "a@acme", at: 1700 }, gated, signed);

    expect(seen[0]).toEqual({
      runId: started.id,
      step: "ok",
      approver: "a@acme",
      approved: true,
      at: 1700,
    });
  });
});

// ── 1.2 a signature is verified or it is refused ───────────────────────────

describe("1.2 a presented signature is checked before it is stored", () => {
  const gated = workflow({ name: "gate", steps: [{ id: "ok", approve: "Ship?" }, { id: "after", ask: "done" }] });

  it("refuses a signature that does not verify, and records nothing", async () => {
    const governed = () => deps(() => answer("ok"), { verify });
    const started = await startRun(gated, {}, governed());

    await expect(
      resumeRun(
        started.id,
        { approved: true, approver: "cfo@acme", signature: "TOTALLY-NOT-A-SIGNATURE" },
        gated,
        governed(),
      ),
    ).rejects.toThrow(/does not verify/);

    const after = await store.load(started.id);
    expect(after?.status).toBe("waiting");
    expect(after?.approvals ?? []).toHaveLength(0);
  });

  it("refuses a signature outright when nothing is wired that could check one", async () => {
    const started = await startRun(gated, {}, deps());
    await expect(
      resumeRun(started.id, { approved: true, approver: "a", signature: "anything" }, gated, deps()),
    ).rejects.toThrow(/no `verify` to check it/);
  });

  it("takes a signature that does verify", async () => {
    const governed = () => deps(() => answer("ok"), { verify });
    const started = await startRun(gated, {}, governed());
    const done = await resumeRun(
      started.id,
      { approved: true, approver: "cfo@acme", signature: "signed:cfo@acme" },
      gated,
      governed(),
    );
    expect(done.status).toBe("done");
    expect(done.approvals?.[0]?.subject).toBe("cfo@acme");
  });
});

// ── 1.3 one caller is not two people ───────────────────────────────────────

describe("1.3 a quorum counts verified identities", () => {
  const twoPerson = workflow({
    name: "wire",
    steps: [{ id: "big", approve: "Wire $50k?", requires: { quorum: 2 } }, { id: "after", ask: "done" }],
  });

  it("refuses to start a quorum gate at all when no verifier is wired", async () => {
    await expect(startRun(twoPerson, {}, deps())).rejects.toThrow(/no `verify`/);
    // Refused before anything was spent, not at the gate after a paid run.
    expect(await store.list()).toHaveLength(0);
  });

  it("does not let one caller clear a two-person rule by typing two names", async () => {
    const governed = () => deps(() => answer("ok"), { verify });
    const started = await startRun(twoPerson, {}, governed());

    // "alice" then "bob", both unsigned, exactly as two POSTs from one socket.
    for (const who of ["alice", "bob"]) {
      await expect(
        resumeRun(started.id, { approved: true, approver: who }, twoPerson, governed()),
      ).rejects.toThrow(/proved WHO made it/);
    }

    const after = await store.load(started.id);
    expect(after?.status).toBe("waiting");
    expect(after?.approvals ?? []).toHaveLength(0);
  });

  it("counts two distinct proved subjects, and not the same one twice", async () => {
    const governed = () => deps(() => answer("ok"), { verify });
    const started = await startRun(twoPerson, {}, governed());

    const one = await resumeRun(
      started.id,
      { approved: true, approver: "alice", signature: "signed:alice" },
      twoPerson,
      governed(),
    );
    expect(one.status).toBe("waiting");

    // The same proved subject under a different display name is still one person.
    await expect(
      resumeRun(
        started.id,
        { approved: true, approver: "definitely-bob", signature: "signed:alice" },
        twoPerson,
        governed(),
      ),
    ).rejects.toThrow(/distinct approvers/);

    const two = await resumeRun(
      started.id,
      { approved: true, approver: "bob", signature: "signed:bob" },
      twoPerson,
      governed(),
    );
    expect(two.status).toBe("done");
  });
});

// ── 1.4 which door the approval came through ───────────────────────────────

describe("1.4 an approval says where it arrived from", () => {
  const gated = workflow({ name: "gate", steps: [{ id: "ok", approve: "Ship?" }, { id: "after", ask: "done" }] });

  it("records the channel, so a run approved through the API agents can reach is legible", async () => {
    const started = await startRun(gated, {}, deps());
    const done = await resumeRun(
      started.id,
      { approved: true, approver: "someone", channel: "http" },
      gated,
      deps(),
    );
    expect(done.approvals?.[0]?.channel).toBe("http");
  });

  it("refuses an approval on a channel the gate does not answer to", async () => {
    const offline = () => deps(() => answer("ok"), { approvalChannels: ["cli"] });
    const started = await startRun(gated, {}, offline());

    await expect(
      resumeRun(started.id, { approved: true, approver: "agent", channel: "http" }, gated, offline()),
    ).rejects.toThrow(/only answers to approvals arriving on "cli"/);

    // An approval naming no channel at all is refused the same way.
    await expect(
      resumeRun(started.id, { approved: true, approver: "agent" }, gated, offline()),
    ).rejects.toThrow(/no named channel/);

    const done = await resumeRun(
      started.id,
      { approved: true, approver: "operator", channel: "cli" },
      gated,
      offline(),
    );
    expect(done.status).toBe("done");
  });
});

// ── 1.5 a plan starts with nothing ─────────────────────────────────────────

describe("1.5 a plan step is granted the tools it names and no others", () => {
  it("offers the planner no tools when the author declared none", async () => {
    const asked: string[] = [];
    const harness: Harness = {
      name: "stub",
      async ask(_p, input) {
        asked.push(input);
        return answer('[{"id":"s1","use":"wipe_everything"}]');
      },
    };
    const provision = provisioner({
      harness,
      planner: async () => plan,
      manifest: () => ({
        agents: [{ name: "a", description: "an agent" }],
        tools: [{ name: "wipe_everything", description: "deletes the account" }],
      }),
    });

    const result = await provision({
      brief: "tidy up",
      from: [],
      max: 4,
      depth: 0,
      scope: {},
      harness,
    });

    expect(result.steps).toHaveLength(0);
    expect(asked[0]).not.toContain("wipe_everything");
    expect(asked[0]).toContain("do not use");
  });
});

// ── 2. the server is a control plane ───────────────────────────────────────

const SERVER_FILES = {
  "praecise.config.ts": `import { defineConfig } from "${FRAMEWORK}";
    export default defineConfig({ name: "acme", quality: "fast", ${TEST_ENDPOINT} });`,
  "agents/support.ts": `import { agent } from "${FRAMEWORK}";
    export default agent({ role: "Support.", description: "Answers questions." });`,
  "functions/leaky.ts": `import { fn } from "${FRAMEWORK}";
    export default fn({
      description: "Throws something that quotes a credential.",
      http: "POST /hooks/leaky",
      run: () => { throw new Error("connect failed: postgres://admin:hunter2-s3cret@db.internal/prod"); },
    });`,
};

/** Start a server for one block of tests, and always take it down again. */
async function withServer(
  options: Parameters<typeof serve>[0],
  body: (server: DevServer) => Promise<void>,
): Promise<void> {
  const root = await makeProject(SERVER_FILES);
  const stub = stubModel(Array.from({ length: 8 }, () => ({ text: "ok" })));
  let server: DevServer | undefined;
  try {
    server = await serve({ root, port: 0, watch: false, env: MODEL_ENV, fetch: stub.fetch, ...options });
    await body(server);
  } finally {
    await server?.close();
    await cleanup(root);
  }
}

describe("2.1 the control plane needs a credential", () => {
  it("refuses /api and /mcp without the token, and answers with it", async () => {
    await withServer({ token: TEST_TOKEN }, async (server) => {
      const at = `http://127.0.0.1:${server.port}`;

      const bare = await fetch(`${at}/api/runs`);
      expect(bare.status).toBe(401);
      expect(bare.headers.get("www-authenticate")).toContain("Bearer");

      const wrong = await fetch(`${at}/api/runs`, { headers: { authorization: "Bearer nope" } });
      expect(wrong.status).toBe(401);

      const right = await fetch(`${at}/api/runs`, { headers: authed() });
      expect(right.status).toBe(200);

      // The MCP endpoint is the same control plane by another name.
      const mcp = await fetch(`${at}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(mcp.status).toBe(401);
    });
  });

  it("mints its own token when none was given, and prints it", async () => {
    await withServer({}, async (server) => {
      expect(server.token).toBeTruthy();
      expect(server.token!.length).toBeGreaterThanOrEqual(32);
      expect(server.banner()).toContain(server.token!);

      const refused = await fetch(`http://127.0.0.1:${server.port}/api/runs`);
      expect(refused.status).toBe(401);
    });
  });

  it("takes the token in a query string too, because EventSource cannot set a header", async () => {
    await withServer({ token: TEST_TOKEN }, async (server) => {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/runs?token=${TEST_TOKEN}`);
      expect(res.status).toBe(200);
    });
  });

  it("refuses to start unauthenticated on a bind the network can see", async () => {
    const root = await makeProject(SERVER_FILES);
    try {
      await expect(
        serve({ root, port: 0, watch: false, env: MODEL_ENV, host: "0.0.0.0", token: false }),
      ).rejects.toThrow(/control plane to the network with no credential/);
    } finally {
      await cleanup(root);
    }
  });

  it("still allows an explicitly open server on loopback", async () => {
    await withServer({ token: false }, async (server) => {
      expect(server.token).toBeUndefined();
      const res = await fetch(`http://127.0.0.1:${server.port}/api/runs`);
      expect(res.status).toBe(200);
      expect(server.banner()).toContain("OPEN");
    });
  });
});

describe("2.2 a visited web page cannot drive it", () => {
  it("refuses a mutating request from an origin it does not know", async () => {
    await withServer({ token: TEST_TOKEN }, async (server) => {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/agents/support`, {
        method: "POST",
        headers: authed({ "content-type": "application/json", origin: "https://evil.example" }),
        body: JSON.stringify({ input: "hi" }),
      });
      expect(res.status).toBe(403);
    });
  });

  it("refuses a POST that did not say application/json — the shape with no preflight", async () => {
    await withServer({ token: TEST_TOKEN }, async (server) => {
      for (const type of ["text/plain;charset=UTF-8", "application/x-www-form-urlencoded", ""]) {
        const res = await fetch(`http://127.0.0.1:${server.port}/api/agents/support`, {
          method: "POST",
          headers: type ? authed({ "content-type": type }) : authed(),
          body: JSON.stringify({ input: "hi" }),
        });
        expect(res.status).toBe(415);
      }
    });
  });

  it("holds a function's own http: route to the same two rules", async () => {
    await withServer({ token: TEST_TOKEN }, async (server) => {
      const crossOrigin = await fetch(`http://127.0.0.1:${server.port}/hooks/leaky`, {
        method: "POST",
        headers: authed({ "content-type": "application/json", origin: "https://evil.example" }),
        body: "{}",
      });
      expect(crossOrigin.status).toBe(403);

      const noToken = await fetch(`http://127.0.0.1:${server.port}/hooks/leaky`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(noToken.status).toBe(401);
    });
  });
});

/**
 * A request with a chosen `Host`.
 *
 * `fetch` treats Host as a forbidden header and rewrites it, which is exactly
 * what a rebinding attacker's browser does NOT do — the browser sends the name
 * that was dialled. So the test speaks HTTP directly, the way the attack does.
 */
function withHost(
  port: number,
  path: string,
  host: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: "GET", headers: { ...headers, host }, setHost: false },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => done({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", fail);
    req.end();
  });
}

describe("2.3 a name that is not ours is not answered", () => {
  it("refuses a request whose Host it was never told to serve", async () => {
    await withServer({ token: TEST_TOKEN }, async (server) => {
      const res = await withHost(server.port, "/api/runs", "attacker.example", authed());
      expect(res.status).toBe(403);
      expect(res.body).toContain("loopback only");
    });
  });

  it("refuses a rebound page the pages themselves, so the token cannot be read out of one", async () => {
    await withServer({ token: TEST_TOKEN }, async (server) => {
      const res = await withHost(server.port, "/", "attacker.example");
      expect(res.status).toBe(403);
    });
  });

  it("answers loopback under every spelling of it", async () => {
    await withServer({ token: TEST_TOKEN }, async (server) => {
      for (const host of [`localhost:${server.port}`, `127.0.0.1:${server.port}`]) {
        expect((await withHost(server.port, "/api/runs", host, authed())).status).toBe(200);
      }
    });
  });

  it("answers a host the author named", async () => {
    await withServer({ token: TEST_TOKEN, hosts: ["praecise.internal"] }, async (server) => {
      const res = await withHost(server.port, "/api/runs", "praecise.internal", authed());
      expect(res.status).toBe(200);
    });
  });
});

describe("2.4 an error tells the caller nothing it did not need", () => {
  it("does not put a credential from an internal exception on the wire", async () => {
    await withServer({ token: TEST_TOKEN }, async (server) => {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/functions/leaky`, {
        method: "POST",
        headers: authed({ "content-type": "application/json" }),
        body: "{}",
      });
      const body = await res.text();
      expect(body).not.toContain("hunter2-s3cret");
      expect(body).toContain("[redacted]");
    });
  });

  it("says only that a declared route failed, with the detail left in the log", async () => {
    await withServer({ token: TEST_TOKEN }, async (server) => {
      const res = await fetch(`http://127.0.0.1:${server.port}/hooks/leaky`, {
        method: "POST",
        headers: authed({ "content-type": "application/json" }),
        body: "{}",
      });
      expect(res.status).toBe(500);
      const body = await res.text();
      expect(body).not.toContain("hunter2-s3cret");
      expect(body).not.toContain("db.internal");
      expect(body).toContain("server log");
    });
  });
});

describe("2.5 the dashboard escapes what it interpolates", () => {
  it("escapes an apostrophe, which an unquoted attribute ends on", () => {
    expect(escapeHtml(`it's "quoted" <b>&`)).toBe("it&#39;s &quot;quoted&quot; &lt;b&gt;&amp;");
  });
});

// ── 3. bounds and data ─────────────────────────────────────────────────────

/** A zip holding one entry that inflates far past what it weighs. */
function bombZip(name: string, bytes: number): Buffer {
  const payload = Buffer.alloc(bytes, 0x41);
  const body = deflateRawSync(payload);
  const nameBuf = Buffer.from(name, "utf8");

  const local = Buffer.alloc(30 + nameBuf.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(payload.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  nameBuf.copy(local, 30);

  const central = Buffer.alloc(46 + nameBuf.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(payload.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42); // local header offset
  nameBuf.copy(central, 46);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length + body.length, 16);

  return Buffer.concat([local, body, central, end]);
}

describe("3.1 a compressed file does not get to say how much memory to use", () => {
  it("drops a zip entry that would inflate past the ceiling, and keeps the rest", () => {
    // Just over the per-entry ceiling, from an archive that weighs almost nothing.
    const bomb = bombZip("bomb.xml", 40 * 1024 * 1024);
    expect(bomb.length).toBeLessThan(100_000);

    const files = unzip(bomb);
    expect(files.has("bomb.xml")).toBe(false);
  });

  it("still reads an ordinary archive", () => {
    const ok = bombZip("word/document.xml", 4096);
    expect(unzip(ok).get("word/document.xml")?.length).toBe(4096);
  });

  it("drops a PDF stream that would inflate past the ceiling", () => {
    // Real show-text operators, so an unbounded reader finds text and returns it.
    // The only thing standing between 40KB on the wire and 20MB of latin1 in the
    // heap is the ceiling.
    const huge = deflateSync(Buffer.from("(A) Tj ".repeat(3_000_000), "latin1"));
    const pdf = Buffer.concat([
      Buffer.from("%PDF-1.4\n<< /Filter /FlateDecode >>\nstream\n", "latin1"),
      huge,
      Buffer.from("\nendstream\n", "latin1"),
    ]);
    expect(pdf.length).toBeLessThan(200_000);
    expect(pdfToText(pdf)).toBe("");
  });

  it("still reads an ordinary PDF stream", () => {
    const small = deflateSync(Buffer.from("(hello) Tj ", "latin1"));
    const pdf = Buffer.concat([
      Buffer.from("%PDF-1.4\n<< /Filter /FlateDecode >>\nstream\n", "latin1"),
      small,
      Buffer.from("\nendstream\n", "latin1"),
    ]);
    expect(pdfToText(pdf)).toContain("hello");
  });
});

describe("3.2 the budget covers every completion, wherever it came from", () => {
  it("counts what a plan step spends", async () => {
    const spent = answer("[]", { inputTokens: 400, outputTokens: 400 });
    const harness: Harness = { name: "stub", async ask() { return spent; } };
    const spec = workflow({ name: "planned", steps: [{ id: "work", plan: "sort it out", max: 2 }] });

    const run = await startRun(spec, {}, {
      ...deps(() => spent),
      limits: { budget: 100 },
      provision: provisioner({
        harness,
        planner: async () => plan,
        manifest: () => ({ agents: [], tools: [] }),
      }),
    });

    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/budget/);
    expect(run.usage.inputTokens).toBe(400);
  });

  it("counts what a judge spends deciding whether the outcome held", async () => {
    const spec = workflow({
      name: "judged",
      steps: [{ id: "draft", ask: "write" }],
      outcome: { asks: "is it any good?" },
    });
    const run = await startRun(spec, {}, {
      ...deps(() => answer("done", { inputTokens: 60, outputTokens: 60 })),
      limits: { budget: 150 },
    });

    // The step alone is 120 of a 150 budget; the judge's call is what passes it,
    // and it is only counted at all because accounting sits at the boundary.
    expect(run.usage.inputTokens + run.usage.outputTokens).toBeGreaterThan(150);
  });
});

describe("3.3 concurrency is a property of the run, not of the list", () => {
  it("does not multiply the bound by the nesting depth", async () => {
    let live = 0;
    let peak = 0;
    const harness: Harness = {
      name: "stub",
      async ask() {
        live++;
        peak = Math.max(peak, live);
        await new Promise((go) => setTimeout(go, 5));
        live--;
        return answer("ok");
      },
    };

    const spec = workflow({
      name: "nested",
      steps: [
        {
          id: "fan",
          each: "{{items}}",
          concurrency: 3,
          do: [
            { id: "a", ask: "a" },
            { id: "b", ask: "b" },
            { id: "c", ask: "c" },
            { id: "d", ask: "d", after: ["a"] },
          ],
        },
      ],
    });
    // One `after` makes the body a graph, so a, b and c are ready at once. Three
    // items each running three at once is nine in flight under a bound of three,
    // which is what a per-list budget gives you.
    const run = await startRun(spec, { items: [1, 2, 3] }, {
      ...deps(),
      harness,
      limits: { concurrency: 3 },
    });

    expect(run.status).toBe("done");
    expect(peak).toBeLessThanOrEqual(3);
  });
});

describe("3.4 every model call has a ceiling", () => {
  it("fails a plan step whose planner never comes back", async () => {
    const spec = workflow({ name: "hangs", steps: [{ id: "work", plan: "think forever", max: 2 }] });
    const run = await startRun(spec, {}, {
      ...deps(),
      limits: { timeout: 0.05 },
      provision: () => new Promise(() => undefined),
    });

    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/took longer than/);
  });

  it("fails a judge that never comes back", async () => {
    const spec = workflow({
      name: "judging",
      steps: [{ id: "draft", ask: "write" }],
      outcome: { asks: "held?" },
    });
    const harness: Harness = {
      name: "stub",
      async ask(given) {
        if (given.name.endsWith(":outcome")) return new Promise(() => undefined);
        return answer("ok");
      },
    };
    const run = await startRun(spec, {}, { ...deps(), harness, limits: { timeout: 0.05 } });

    // A judge that cannot answer is a check that did not hold, not a run that hangs.
    expect(run.outcome?.held).toBe(false);
    expect(run.outcome?.reasons.join(" ")).toMatch(/took longer than/);
  });
});

describe("3.5 an ask has a size it will not exceed", () => {
  it("refuses an input past the ceiling before anything is spent", async () => {
    const root = await makeProject(SERVER_FILES);
    const stub = stubModel([{ text: "ok" }]);
    let server: DevServer | undefined;
    try {
      server = await serve({
        root, port: 0, watch: false, env: MODEL_ENV, fetch: stub.fetch,
        token: TEST_TOKEN, maxInput: 64,
      });
      const res = await fetch(`http://127.0.0.1:${server.port}/api/agents/support`, {
        method: "POST",
        headers: authed({ "content-type": "application/json" }),
        body: JSON.stringify({ input: "x".repeat(500) }),
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toMatch(/takes at most/);
      expect(stub.calls).toHaveLength(0);
    } finally {
      await server?.close();
      await cleanup(root);
    }
  });
});

describe("3.6 what is written down is not readable by the whole machine", () => {
  it("writes the run directory owner-only and each run file owner-only", async () => {
    const spec = workflow({ name: "quiet", steps: [{ id: "a", ask: "hi" }] });
    const run = await startRun(spec, { secret: "the plan" }, deps());

    const asDir = await stat(join(dir, "runs"));
    expect(asDir.mode & 0o777).toBe(0o700);

    const asFile = await stat(join(dir, "runs", `${run.id.replace(/[^\w-]/g, "_")}.json`));
    expect(asFile.mode & 0o777).toBe(0o600);
  });
});

describe("3.7 a credential does not become part of the record", () => {
  it("redacts what an exception quoted before it is persisted onto the run", async () => {
    const spec = workflow({ name: "boom", steps: [{ id: "go", use: "svc.call", with: {} }] });
    const run = await startRun(spec, {}, {
      ...deps(),
      callTool: async () => {
        throw new Error('upstream said {"error":"bad api_key=sk-live-9f8e7d6c5b4a3210"} with Authorization: Bearer abcdef0123456789');
      },
    });

    expect(run.status).toBe("failed");
    expect(run.error).not.toContain("sk-live-9f8e7d6c5b4a3210");
    expect(run.error).not.toContain("abcdef0123456789");
    expect(JSON.stringify(run.events)).not.toContain("sk-live");
  });

  it("leaves ordinary text alone — a redactor that eats prose gets turned off", () => {
    const plain = "step \"draft\" took longer than 600s (run greet-abc123)";
    expect(redact(plain)).toBe(plain);
  });
});

describe("3.8 a guard can see which door a call came through", () => {
  it("tells a workflow step apart from an app-level call", async () => {
    const seen: { via?: string; step?: string; run?: string }[] = [];
    const root = await makeProject({
      ...SERVER_FILES,
      "functions/ping.ts": `import { fn } from "${FRAMEWORK}";
        export default fn({ description: "Answers.", run: () => "pong" });`,
      "workflows/call.ts": `import { workflow } from "${FRAMEWORK}";
        export default workflow({ steps: [{ id: "go", use: "ping", with: {} }] });`,
      "guard.ts": `import { guard } from "${FRAMEWORK}";
        export default guard((attempt) => {
          globalThis.__seen ??= [];
          globalThis.__seen.push({ via: attempt.via, step: attempt.at?.step, run: attempt.at?.run });
          return undefined;
        });`,
    });
    try {
      const { App } = await import("../src/app.js");
      const app = await App.load({ root, env: MODEL_ENV, fetch: stubModel([{ text: "ok" }]).fetch });
      try {
        const run = await app.startWorkflow("call", {});
        await app.callTool("ping", {}, { via: "http" });
        seen.push(...((globalThis as never as { __seen: typeof seen }).__seen ?? []));

        expect(seen[0]).toMatchObject({ via: "workflow", step: "go", run: run.id });
        expect(seen[1]).toMatchObject({ via: "http" });
      } finally {
        await app.close();
        delete (globalThis as never as Record<string, unknown>).__seen;
      }
    } finally {
      await cleanup(root);
    }
  });
});

describe("3.9 a destructive thing is not published by not thinking about it", () => {
  it("withholds a destructive entry until its author names an access tier", async () => {
    const { toolsOf } = await import("../src/server/mcp.js");
    const { App } = await import("../src/app.js");

    const root = await makeProject({
      ...SERVER_FILES,
      "functions/wipe.ts": `import { fn } from "${FRAMEWORK}";
        export default fn({ description: "Deletes the account.", effect: "destructive", run: () => "gone" });`,
      "functions/wipe_declared.ts": `import { fn } from "${FRAMEWORK}";
        export default fn({ description: "Deletes it, and says so.", effect: "destructive", access: "open", run: () => "gone" });`,
    });
    try {
      const app = await App.load({ root, env: MODEL_ENV, fetch: stubModel([]).fetch });
      try {
        const names = toolsOf(app, { identified: true }).map((tool) => tool.name);
        expect(names).not.toContain("wipe");
        expect(names).toContain("wipe_declared");
      } finally {
        await app.close();
      }
    } finally {
      await cleanup(root);
    }
  });
});

describe("3.10 a number that is not a number is refused", () => {
  it("will not decode NaN or Infinity as a number", () => {
    expect(() => num.dec("oops")).toThrow(/not a finite number/);
    // `Number("")` is 0, so an empty field would have decoded as a real zero.
    expect(() => num.dec("")).toThrow(/arrived empty/);
    expect(() => num.dec("NaN")).toThrow(/not a finite number/);
    expect(() => num.dec("Infinity")).toThrow(/not a finite number/);
    expect(num.dec("-12.5")).toBe(-12.5);
  });

  it("will not encode one either, since it could never decode back", () => {
    expect(() => num.enc(Number.NaN)).toThrow(/no wire form/);
  });
});

describe("3.11 a graph that cannot be walked is not a run that succeeded", () => {
  it("throws naming the cycle rather than reporting done with nothing run", async () => {
    // A provisioner is an app-supplied function and may hand back any graph at
    // all, so this is the one path into the scheduler that no pre-flight check
    // has seen. Reporting `done` with an empty `outputs` and a `result` read off
    // a step that never ran is the worst answer available: it is wrong, and it
    // is indistinguishable from success.
    const spec = workflow({ name: "knot", steps: [{ id: "work", plan: "lay it out", max: 4 }] });
    const run = await startRun(spec, {}, {
      ...deps(),
      provision: async () => ({
        steps: [
          { id: "a", ask: "a", after: ["b"] },
          { id: "b", ask: "b", after: ["a"] },
        ],
      }),
    });

    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/can never run/);
    expect(run.error).toMatch(/cycle/);
    expect(run.outputs).toEqual({});
  });

  it("still refuses an authored cycle before the run starts", async () => {
    const spec = workflow({
      name: "authored-knot",
      steps: [
        { id: "a", ask: "a", after: ["b"] },
        { id: "b", ask: "b", after: ["a"] },
      ],
    });
    await expect(startRun(spec, {}, deps())).rejects.toThrow(/circle/);
  });
});
