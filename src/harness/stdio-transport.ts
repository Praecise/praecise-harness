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
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
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

  constructor(private readonly server: StdioServer) {}

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
    let message: { id?: number | string; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      // A server that prints something other than JSON-RPC on stdout is misbehaving,
      // but one stray line must not take down a working session.
      return;
    }
    if (message.id === undefined) return; // a notification, addressed to nobody waiting
    const waiting = this.pending.get(message.id);
    if (!waiting) return;
    this.pending.delete(message.id);
    clearTimeout(waiting.timer);
    if (message.error) waiting.reject(new Error(message.error.message ?? "MCP error"));
    else waiting.resolve(message.result);
  }

  /** Send a request and wait for the reply carrying this id. */
  request(id: number | string, method: string, params?: unknown): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const child = this.start();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.server.command} did not answer ${method} within ${REPLY_TIMEOUT_MS}ms`));
      }, REPLY_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
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
