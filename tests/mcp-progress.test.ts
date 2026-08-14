/**
 * Watching a long call, and stopping one.
 *
 * A tool that takes ten minutes and a tool that has hung look identical to a client
 * that only waits. MCP's answer is `_meta.progressToken` going out and
 * `notifications/progress` coming back, and without reading those a caller has nothing
 * to show and no basis for deciding the thing is stuck.
 *
 * Cancellation is the other half, and it is transport-shaped: on stdio there is no
 * stream to drop, so it has to be SAID — `notifications/cancelled` naming the request
 * id — and on HTTP there is nothing to say, because the request IS the response stream
 * and closing it is the whole gesture.
 *
 * The HTTP tests here use a real streaming `Response` rather than a canned string, so
 * the notifications genuinely arrive before the reply does. The stdio tests spawn a
 * real process. Neither touches the network.
 */
import { describe, expect, test } from "vitest";
import { McpClient, type McpProgress } from "../src/harness/mcp.js";
import { StdioTransport } from "../src/harness/stdio-transport.js";
import type { ResolvedService } from "../src/compile/services.js";

const HTTP: ResolvedService = {
  name: "ledger",
  url: "https://mcp.example.com",
  credential: "LEDGER_API_KEY",
  apiKey: "k",
  auth: "bearer",
};

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const encoder = new TextEncoder();
const frame = (payload: unknown) => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);

/**
 * A server that answers `tools/call` over a live SSE stream the test drives.
 *
 * `emit` gets a writer and the id of the call, and may take as long as it likes; the
 * stream stays open until it closes it, which is what makes "the reply had not arrived
 * yet" a state this test can actually be in.
 */
function streaming(emit: (write: (payload: unknown) => void, id: number) => Promise<void> | void) {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { id?: number; method: string; params?: Record<string, unknown> };
    if (body.id === undefined) return new Response("", { status: 202 });
    bodies.push(body as Record<string, unknown>);
    if (body.method === "initialize") {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-11-25", capabilities: {} } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (payload: unknown) => {
          try {
            controller.enqueue(frame(payload));
          } catch {
            // The reader closed the stream — which on HTTP is the cancellation.
          }
        };
        void Promise.resolve(emit(write, body.id as number)).then(
          () => {
            try {
              controller.close();
            } catch {
              // Already closed by a cancelling reader.
            }
          },
          () => undefined,
        );
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;

  return { client: new McpClient(HTTP, fetchImpl), bodies };
}

const progressNote = (token: unknown, progress: number, total?: number, message?: string) => ({
  jsonrpc: "2.0",
  method: "notifications/progress",
  params: { progressToken: token, progress, total, message },
});

describe("progress over HTTP, while the call is still running", () => {
  test("notifications arrive interleaved, before the reply that follows them", async () => {
    let settled = false;
    const seen: McpProgress[] = [];

    const { client, bodies } = streaming(async (write, id) => {
      const token = (bodies.at(-1)?.params as { _meta?: { progressToken?: string } })?._meta?.progressToken;
      for (let step = 1; step <= 3; step++) {
        await sleep(5);
        write(progressNote(token, step, 3, `step ${step}`));
      }
      await sleep(5);
      write({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "done" }] } });
    });

    const call = client
      .call("rebuild", {}, { onProgress: (event) => {
        // The point of the whole feature: this runs while the call is in flight.
        expect(settled).toBe(false);
        seen.push(event);
      } })
      .then((text) => {
        settled = true;
        return text;
      });

    expect(await call).toBe("done");
    expect(seen).toEqual([
      { progress: 1, total: 3, message: "step 1" },
      { progress: 2, total: 3, message: "step 2" },
      { progress: 3, total: 3, message: "step 3" },
    ]);
  });

  test("a token is only sent when somebody is listening", async () => {
    // A server is never asked to narrate work nobody is watching.
    const { client, bodies } = streaming((write, id) => {
      write({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "ok" }] } });
    });

    await client.call("quiet", {});
    // `_meta` itself is always present — it carries the protocol version now — so the
    // claim under test is narrower and more exact than it used to be: no progress TOKEN
    // is minted when nobody passed a listener, so no server is asked to narrate.
    const quiet = bodies.at(-1)?.params as { _meta?: Record<string, unknown> };
    expect(quiet._meta?.progressToken).toBeUndefined();
    expect(quiet._meta?.["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");

    await client.call("watched", {}, { onProgress: () => undefined });
    const watched = bodies.at(-1)?.params as { _meta?: { progressToken?: string } };
    expect(typeof watched._meta?.progressToken).toBe("string");
  });

  test("an idempotency key and a progress token share `_meta` rather than evicting each other", async () => {
    const { client, bodies } = streaming((write, id) => {
      write({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "ok" }] } });
    });

    await client.call("ship", {}, { idempotencyKey: "abc", onProgress: () => undefined });
    const meta = (bodies.at(-1)?.params as { _meta: Record<string, unknown> })._meta;
    expect(meta["praecise/idempotencyKey"]).toBe("abc");
    expect(typeof meta.progressToken).toBe("string");
  });

  test("progress for a token nobody is holding is ignored, not thrown", async () => {
    const seen: McpProgress[] = [];
    const { client } = streaming((write, id) => {
      write(progressNote("someone-elses-token", 1));
      write({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "fine" }] } });
    });

    expect(await client.call("t", {}, { onProgress: (e) => seen.push(e) })).toBe("fine");
    expect(seen).toEqual([]);
  });

  test("a reply is found past the frames that came before it", async () => {
    // The old reader took the FIRST data frame and called it the answer, which is wrong
    // the moment a server says anything before replying — and progress is exactly that.
    // This body arrives whole, so it exercises the non-streaming path as well.
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { id?: number; method: string };
      if (body.id === undefined) return new Response("", { status: 202 });
      if (body.method === "initialize") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const text =
        `data: ${JSON.stringify(progressNote("praecise/1", 1))}\n\n` +
        `data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "the answer" }] } })}\n\n`;
      return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;

    const client = new McpClient(HTTP, fetchImpl);
    const seen: McpProgress[] = [];
    expect(await client.call("t", {}, { onProgress: (e) => seen.push(e) })).toBe("the answer");
    expect(seen).toEqual([{ progress: 1, total: undefined, message: undefined }]);
  });

  test("a stream that ends without answering fails as that, rather than as an empty result", async () => {
    const { client } = streaming((write, _id) => {
      write(progressNote("praecise/1", 1));
    });
    await expect(client.call("t", {})).rejects.toThrow(/without a reply/);
  });

  test("an error frame is still an error when it arrives on a stream", async () => {
    const { client } = streaming((write, id) => {
      write({ jsonrpc: "2.0", id, error: { code: -32000, message: "the ledger is closed" } });
    });
    await expect(client.call("t", {})).rejects.toThrow(/the ledger is closed/);
  });
});

describe("cancelling over HTTP", () => {
  test("aborting a call that has gone quiet stops waiting for it", async () => {
    // The server sends one progress note and then nothing, forever. Without the abort
    // this waits on a read that never resolves, which is the hang cancellation exists
    // to end — so a check performed after the read would never run.
    const control = new AbortController();
    const { client } = streaming(async (write) => {
      write(progressNote("praecise/1", 1));
      await new Promise(() => undefined);
    });

    const call = client.call(
      "forever",
      {},
      { signal: control.signal, onProgress: () => control.abort(new Error("the user closed the tab")) },
    );

    await expect(call).rejects.toThrow(/cancelled: the user closed the tab/);
  });

  test("a signal already aborted never reaches the wire", async () => {
    const { client, bodies } = streaming((write, id) => {
      write({ jsonrpc: "2.0", id, result: { content: [] } });
    });
    await client.call("warm-up", {}); // handshake first, so only the call itself is counted
    const before = bodies.length;

    await expect(client.call("t", {}, { signal: AbortSignal.abort() })).rejects.toThrow(/cancelled/);
    expect(bodies.length).toBe(before);
  });
});

/**
 * A stdio server that narrates, hangs, and remembers being cancelled.
 *
 * It replies over `tools/call`, keyed on the tool name, so these go through the same
 * path an agent's tool call takes rather than a private one.
 */
const SERVER = `
const cancelled = [];
let hangId;
let buffer = "";
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let cut;
  while ((cut = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, cut).trim();
    buffer = buffer.slice(cut + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) {
      if (msg.method === "notifications/cancelled") cancelled.push(msg.params);
      continue;
    }
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-11-25", capabilities: {} } });
      continue;
    }
    const name = msg.params?.name;
    const token = msg.params?._meta?.progressToken;
    const text = (t) => send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: t }] } });
    const note = (n) =>
      send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: n, total: 2 } });

    if (name === "counted") {
      setTimeout(() => note(1), 5);
      setTimeout(() => note(2), 10);
      setTimeout(() => text("counted to two"), 20);
    } else if (name === "hang") {
      hangId = msg.id;
      setTimeout(() => note(1), 5);
    } else if (name === "cancellations") {
      text(JSON.stringify({ seen: cancelled.length, matched: cancelled[0]?.requestId === hangId, reason: cancelled[0]?.reason }));
    } else {
      text("ok");
    }
  }
});
`;

const launched = (): ResolvedService => ({
  name: "local",
  command: [process.execPath, "-e", SERVER],
  credential: "LOCAL_API_KEY",
  auth: "bearer",
});

describe("progress and cancellation against a real launched server", () => {
  test("notifications on the same pipe as the replies reach the caller", async () => {
    // A message with no id used to be dropped here, which is right for noise and wrong
    // for the one kind that says a long call is still working.
    const client = new McpClient(launched());
    try {
      const seen: McpProgress[] = [];
      const out = await client.call("counted", {}, { onProgress: (event) => seen.push(event) });
      expect(out).toBe("counted to two");
      expect(seen).toEqual([
        { progress: 1, total: 2, message: undefined },
        { progress: 2, total: 2, message: undefined },
      ]);
    } finally {
      client.close();
    }
  });

  test("cancelling tells the server, naming the request it should stop working on", async () => {
    // Abandoning the wait locally would leave the server spending whatever the work
    // costs on an answer nobody will read.
    const client = new McpClient(launched());
    try {
      const control = new AbortController();
      const call = client.call("hang", {}, {
        signal: control.signal,
        onProgress: () => control.abort(new Error("changed my mind")),
      });
      await expect(call).rejects.toThrow(/cancelled: changed my mind/);

      const reported = JSON.parse(await client.call("cancellations", {})) as {
        seen: number;
        matched: boolean;
        reason: string;
      };
      expect(reported.seen).toBe(1);
      expect(reported.matched).toBe(true);
      expect(reported.reason).toBe("changed my mind");
    } finally {
      client.close();
    }
  });

  test("a late reply to a cancelled request is discarded rather than confusing the next one", async () => {
    const transport = new StdioTransport({
      command: process.execPath,
      args: [
        "-e",
        `let b="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>{b+=c;let k;while((k=b.indexOf("\\n"))>=0){const l=b.slice(0,k).trim();b=b.slice(k+1);if(!l)continue;const m=JSON.parse(l);if(m.id===undefined)continue;setTimeout(()=>process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{late:m.method}})+"\\n"), m.method==="slow"?30:1);}})`,
      ],
    });
    try {
      const control = new AbortController();
      const abandoned = transport.request(1, "slow", {}, { signal: control.signal });
      control.abort();
      await expect(abandoned).rejects.toThrow(/cancelled/);

      // The abandoned reply lands while this one is outstanding. Routing by id is what
      // keeps it from being read as this request's answer.
      await expect(transport.request(2, "fast")).resolves.toEqual({ late: "fast" });
      await sleep(60);
      await expect(transport.request(3, "third")).resolves.toEqual({ late: "third" });
    } finally {
      transport.close();
    }
  });

  test("a server that reports progress is not timed out for taking a while", async () => {
    // The reply clock is a limit on SILENCE, not on how long a tool may take. Timing
    // out a server that is demonstrably working reports working software as broken.
    //
    // The warm-up request is not ceremony: a cold `node -e` takes long enough to start
    // that its startup, not its answer, would be what the clock measured.
    const chatty = new StdioTransport({
      command: process.execPath,
      args: [
        "-e",
        `let b="";const send=(m)=>process.stdout.write(JSON.stringify(m)+"\\n");
         process.stdin.setEncoding("utf8");process.stdin.on("data",c=>{b+=c;let k;while((k=b.indexOf("\\n"))>=0){const l=b.slice(0,k).trim();b=b.slice(k+1);if(!l)continue;const m=JSON.parse(l);if(m.id===undefined)continue;
         if(m.method==="warm"){send({jsonrpc:"2.0",id:m.id,result:{warm:true}});continue;}
         for(let i=1;i<=8;i++) setTimeout(()=>send({jsonrpc:"2.0",method:"notifications/progress",params:{progressToken:"t",progress:i}}), i*100);
         setTimeout(()=>send({jsonrpc:"2.0",id:m.id,result:{ok:true}}), 900);}})`,
      ],
      replyTimeoutMs: 400,
    });
    chatty.onNotification(() => chatty.touch(9));
    try {
      await expect(chatty.request(0, "warm")).resolves.toEqual({ warm: true });
      // Nine hundred milliseconds of work under a four-hundred millisecond clock, and
      // it arrives — because every hundred-millisecond note pushed the clock back.
      await expect(chatty.request(9, "long")).resolves.toEqual({ ok: true });
    } finally {
      chatty.close();
    }
  });

  test("a silent server still times out, so the clock is not simply disabled", async () => {
    const mute = new StdioTransport({
      command: process.execPath,
      args: ["-e", "process.stdin.resume();"],
      replyTimeoutMs: 100,
    });
    try {
      await expect(mute.request(1, "tools/list")).rejects.toThrow(/within 100ms/);
    } finally {
      mute.close();
    }
  });
});
