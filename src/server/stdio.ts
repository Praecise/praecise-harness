/**
 * The app, spoken over a pipe.
 *
 * A client launches the app as a child process and talks to it on stdin and
 * stdout — no port, no origin, no token. Whoever started the process is the
 * person using it, which is why a caller here is trusted without proving
 * anything, and why credentials come from the environment rather than a
 * handshake.
 *
 * The one rule that matters: stdout carries nothing but protocol messages. A
 * stray `console.log` from anywhere in the app would corrupt the stream, so
 * everything that is not a reply goes to stderr.
 */

import type { Readable, Writable } from "node:stream";

import type { App } from "../app.js";
import { handleMcp, type Caller } from "./mcp.js";

export interface StdioOptions {
  app: App;
  input?: Readable;
  output?: Writable;
  /** Defaults to a trusted local caller. */
  caller?: Caller;
}

export interface StdioServer {
  /** Resolves when the input closes, which is how a client says goodbye. */
  done: Promise<void>;
  close(): void;
}

/** Serve one app on a pair of streams. */
export function serveStdio(options: StdioOptions): StdioServer {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const caller = options.caller ?? { identified: true };

  let buffer = "";
  /** Replies are serialised: two concurrent calls must not interleave lines. */
  let queue: Promise<void> = Promise.resolve();
  /** Open subscriptions, by the id of the request that opened each. */
  const listening = new Map<string, AbortController>();

  const write = (reply: unknown) => {
    output.write(`${JSON.stringify(reply)}\n`);
  };

  const onData = (chunk: Buffer | string) => {
    buffer += chunk.toString();
    let cut = buffer.indexOf("\n");
    while (cut >= 0) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      cut = buffer.indexOf("\n");
      if (line) dispatch(line);
    }
  };

  function dispatch(line: string): void {
    queue = queue.then(async (): Promise<void> => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        // No id to answer against, so the only honest thing is to say so on the
        // channel that is not the protocol.
        process.stderr.write(`praecise: ignored a line that was not JSON\n`);
        return;
      }
      const said = message as { id?: string | number | null; method?: unknown; params?: { requestId?: unknown } } | null;

      // A subscription is the one request that stays open, so it is not waited for
      // here: the line after it would otherwise never be read. It writes whole lines
      // like everything else, so what it sends cannot land inside another reply.
      if (said?.method === "subscriptions/listen" && said.id !== undefined && said.id !== null) {
        const ending = new AbortController();
        const key = String(said.id);
        listening.set(key, ending);
        void handleMcp(options.app, message, caller, { send: write, signal: ending.signal })
          .then(
            (reply) => {
              if (reply !== undefined) write(reply);
              return undefined;
            },
            (err: unknown) => process.stderr.write(`praecise: ${(err as Error).message}\n`),
          )
          .finally(() => {
            if (listening.get(key) === ending) listening.delete(key);
          });
        return;
      }
      // On a pipe there is no stream to close, so a client ends a subscription by
      // saying so. Anything else in flight runs to its end, as it always did here.
      if (said?.method === "notifications/cancelled") {
        listening.get(String(said.params?.requestId))?.abort();
        return;
      }

      try {
        const reply = await handleMcp(options.app, message, caller);
        if (reply !== undefined) write(reply);
      } catch (err) {
        process.stderr.write(`praecise: ${(err as Error).message}\n`);
      }
      return;
    });
  }

  /** Every subscription ends with the connection: nothing is held about one after it. */
  const endListening = (): void => {
    for (const ending of listening.values()) ending.abort();
    listening.clear();
  };

  input.on("data", onData);

  const done = new Promise<void>((resolve) => {
    const over = (): void => {
      endListening();
      resolve();
    };
    input.once("end", over);
    input.once("close", over);
  });

  if (typeof (input as Readable & { resume?: () => void }).resume === "function") input.resume();

  return {
    done: done.then(() => queue),
    close() {
      endListening();
      input.off("data", onData);
      if (input === process.stdin) input.pause();
    },
  };
}
