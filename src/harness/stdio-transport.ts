/**
 * Talking to an MCP server that runs as a local process rather than a URL.
 *
 * This was missing outright, and it is not a corner: a large share of the MCP servers
 * people actually publish are stdio-only — they are programs you launch, not endpoints
 * you call. A client that speaks HTTP alone cannot reach any of them, and the failure
 * is not a degraded experience but a hard "no such service".
 *
 * The transport is small because the protocol is line-oriented: newline-delimited
 * JSON-RPC on stdin and stdout, one JSON object per line. What takes care is everything
 * around it.
 *
 * ── What this refuses to do ───────────────────────────────────────────────────
 *
 * No shell. The command and its arguments are passed as an argv array and spawned
 * without one, so a service name or an argument containing a semicolon is an inert
 * string rather than a second command. A framework that launches processes on an
 * author's behalf does not get to be relaxed about this.
 *
 * ── Why stderr is drained but never parsed ────────────────────────────────────
 *
 * Servers write diagnostics to stderr, and a pipe nobody reads fills and blocks the
 * process that is writing to it — a deadlock that looks exactly like a slow server. So
 * it is consumed and kept as a tail, which is then attached to any failure: when a
 * server dies during startup, its last words on stderr are usually the only explanation
 * that exists.
 *
 * ── Why replies are matched by id and not by arrival ──────────────────────────
 *
 * A server may interleave notifications and responses, and may answer out of order.
 * Reading the next line and assuming it belongs to the request just sent is the bug
 * this shape exists to avoid; every reply is routed by its JSON-RPC id, and anything
 * without one is a notification rather than an answer nobody asked for.
 *
 * ── Why notifications are offered rather than dropped ─────────────────────────
 *
 * A message with no id was discarded here, which is right for noise and wrong for the
 * one kind that matters: `notifications/progress` is how a server says a long call is
 * still working, and dropping it means a ten-minute tool is indistinguishable from a
 * hung one. So a single handler may be registered, and everything without an id is
 * handed to it; the transport still refuses to interpret any of it.
 *
 * ── Why cancellation sends something ──────────────────────────────────────────
 *
 * Abandoning a request locally leaves the server working on it — burning whatever the
 * work costs on an answer nobody will read. On stdio there is no stream to close, so
 * cancellation has to be said out loud: `notifications/cancelled` naming the request id.
 * The reply, if one still arrives, is routed to nobody and discarded.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/** How much of stderr to keep for a post-mortem. Enough for a stack, not a log file. */
const STDERR_TAIL = 4_000;

/** How long to wait for a reply before giving up on a process that may never answer. */
const REPLY_TIMEOUT_MS = 60_000;

export interface StdioServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /**
   * How long to wait for a reply, when the default is wrong for this server.
   *
   * The clock is rearmed by anything that proves the server is still working — see
   * `touch` — so this is a limit on SILENCE, not on how long a tool may take.
   */
  replyTimeoutMs?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  /** Rearms the reply clock, so a server that is reporting progress is not timed out. */
  touch: () => void;
  /** Removes the abort listener, whatever ends the wait. */
  done: () => void;
}

/** Everything a caller may say about one request beyond its method and params. */
export interface RequestOptions {
  /** Cancels the request, and tells the server so it can stop working. */
  signal?: AbortSignal;
  /** What to call this in an error. Defaults to the method name. */
  label?: string;
}

/**
 * A live stdio MCP server. One process, many requests, replies matched by id.
 *
 * `close()` is not optional housekeeping — a spawned server outlives its parent's
 * intentions if nobody stops it, and an app that opens one per reload leaks processes
 * until something notices.
 */
export class StdioTransport {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private stderr = "";
  private readonly pending = new Map<number | string, Pending>();
  private failure?: Error;
  /** Where messages with no id go, if anybody asked for them. */
  private notifications?: (method: string, params: unknown) => void;

  constructor(private readonly server: StdioServer) {}

  /**
   * Listen to what the server says outside of any reply.
   *
   * One handler, not a list: this transport serves exactly one client object, and a
   * subscription list would be a small amount of bookkeeping in exchange for a way to
   * leak listeners across reconnects.
   */
  onNotification(handler: (method: string, params: unknown) => void): void {
    this.notifications = handler;
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;

    const child = spawn(this.server.command, this.server.args ?? [], {
      // No shell, deliberately — see the header.
      shell: false,
      cwd: this.server.cwd,
      env: this.server.env ? { ...process.env, ...this.server.env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.take(chunk));

    // Drained so the pipe cannot fill and stall the server; kept so a death has a reason.
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL);
    });

    child.on("error", (error: Error) => this.fail(new Error(`could not start ${this.server.command}: ${error.message}`)));
    child.on("exit", (code, signal) => {
      const how = signal ? `killed by ${signal}` : `exited with code ${code}`;
      this.fail(new Error(`${this.server.command} ${how}${this.stderr ? `\n${this.stderr.trim()}` : ""}`));
    });

    this.child = child;
    return child;
  }

  /** Everything in flight fails with the same reason, rather than hanging forever. */
  private fail(error: Error): void {
    this.failure = error;
    for (const [, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      waiting.done();
      waiting.reject(error);
    }
    this.pending.clear();
  }

  /** Split on newlines and route each complete line; a partial line waits for the rest. */
  private take(chunk: string): void {
    this.buffer += chunk;
    let cut = this.buffer.indexOf("\n");
    while (cut >= 0) {
      const line = this.buffer.slice(0, cut).trim();
      this.buffer = this.buffer.slice(cut + 1);
      if (line) this.route(line);
      cut = this.buffer.indexOf("\n");
    }
  }

  private route(line: string): void {
    let message: {
      id?: number | string;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { message?: string };
    };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      // A server that prints something other than JSON-RPC on stdout is misbehaving,
      // but one stray line must not take down a working session.
      return;
    }
    if (message.id === undefined) {
      // Addressed to nobody waiting — which is not the same as addressed to nobody.
      if (message.method) this.notifications?.(message.method, message.params);
      return;
    }
    const waiting = this.pending.get(message.id);
    if (!waiting) return; // an answer to something already cancelled, timed out, or gone
    this.pending.delete(message.id);
    clearTimeout(waiting.timer);
    waiting.done();
    if (message.error) waiting.reject(new Error(message.error.message ?? "MCP error"));
    else waiting.resolve(message.result);
  }

  /** Send a request and wait for the reply carrying this id. */
  request(
    id: number | string,
    method: string,
    params?: unknown,
    opts: RequestOptions = {},
  ): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const what = opts.label ?? method;
    const stoppedBy = () => {
      const why = reasonOf(opts.signal);
      return new Error(`${what} was cancelled${why ? `: ${why}` : ""}`);
    };
    if (opts.signal?.aborted) return Promise.reject(stoppedBy());

    const child = this.start();
    const patience = this.server.replyTimeoutMs ?? REPLY_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const arm = () =>
        setTimeout(() => {
          this.pending.delete(id);
          off();
          reject(new Error(`${this.server.command} did not answer ${method} within ${patience}ms`));
        }, patience);

      const stop = () => {
        const waiting = this.pending.get(id);
        if (!waiting) return;
        this.pending.delete(id);
        clearTimeout(waiting.timer);
        off();
        // Said out loud, so the server can stop working on an answer nobody will read.
        this.cancel(id, reasonOf(opts.signal));
        reject(stoppedBy());
      };
      const off = () => opts.signal?.removeEventListener("abort", stop);
      opts.signal?.addEventListener("abort", stop, { once: true });

      const entry: Pending = {
        resolve,
        reject,
        timer: arm(),
        touch: () => {
          const waiting = this.pending.get(id);
          if (!waiting) return;
          clearTimeout(waiting.timer);
          waiting.timer = arm();
        },
        done: off,
      };
      this.pending.set(id, entry);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  /**
   * Push back the reply clock for a request that is demonstrably still being worked on.
   *
   * A server sending progress is a server that is alive, and timing it out anyway
   * reports working software as broken. Nothing here decides what counts as evidence of
   * life — the client does, and calls this.
   */
  touch(id: number | string): void {
    this.pending.get(id)?.touch();
  }

  /** Tell the server to stop working on a request. Nothing is expected back. */
  cancel(id: number | string, reason?: string): void {
    this.notify("notifications/cancelled", { requestId: id, reason: reason ?? "client cancelled" });
  }

  /** Send something that expects no reply. */
  notify(method: string, params?: unknown): void {
    if (this.failure) return;
    this.start().stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  close(): void {
    this.fail(new Error("transport closed"));
    this.child?.stdin.end();
    this.child?.kill();
    this.child = undefined;
  }
}

/** Whatever the caller gave as a reason for aborting, if it gave a readable one. */
function reasonOf(signal?: AbortSignal): string | undefined {
  if (!signal) return undefined;
  if (signal.reason instanceof Error) return signal.reason.message;
  return typeof signal.reason === "string" ? signal.reason : undefined;
}
