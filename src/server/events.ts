/**
 * The same two things the runtime reports, written down a socket.
 *
 * There is no envelope and no framing of our own: each event goes out as the
 * JSON the runtime produced, one per server-sent event, in the order it was
 * produced. A reader switches on `kind` and is done. That is only possible
 * because of the rule the events already obey — nothing reported is taken back
 * — which means a socket that drops has lost the rest, never the sense, of what
 * it had already been told.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import type { Run, RunEvent } from "../workflow/store.js";

/** How often a run's own record is re-read while it is still going. */
const LOOK_AGAIN = 150;

export interface Channel {
  send(value: unknown): void;
  close(): void;
  /** Aborted when the reader goes away, so the work can stop with them. */
  readonly signal: AbortSignal;
}

export function openChannel(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    /**
     * Put the payload's `type` in the SSE `event:` field as well as the body.
     *
     * Off by default, and that default is load-bearing rather than conservative: a
     * browser `EventSource` delivers a NAMED event only to `addEventListener("<name>")`
     * and never to `onmessage`. Turning this on for every stream would silently stop the
     * existing dashboard receiving anything — the frames would still arrive, on a
     * listener nobody registered.
     *
     * AG-UI clients dispatch by name, so they ask for it.
     */
    named?: boolean;
  } = {},
): Channel {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    // Nothing between here and the reader may hold a frame back waiting for
    // more of them; a buffered stream of progress is not progress.
    "x-accel-buffering": "no",
  });

  const leaving = new AbortController();
  req.on("close", () => leaving.abort());

  let closed = false;
  return {
    signal: leaving.signal,
    send(value) {
      if (closed || res.writableEnded) return;
      const name = options.named ? (value as { type?: unknown })?.type : undefined;
      const head = typeof name === "string" ? `event: ${name}\n` : "";
      res.write(`${head}data: ${JSON.stringify(value)}\n\n`);
    },
    close() {
      if (closed) return;
      closed = true;
      res.end();
    },
  };
}

/**
 * A run's events, from the beginning, and then as they are added.
 *
 * A run records what it has done as it does it, so following one is reading
 * that record from where you left off rather than being told twice. Reading
 * stops when the run does — a run waiting on a person has stopped, and whoever
 * approves it can follow the next stretch from there.
 */
export async function* followRun(
  runs: { load(id: string): Promise<Run | undefined> },
  id: string,
  signal: AbortSignal,
): AsyncGenerator<RunEvent | { kind: "settled"; run: Run }> {
  let sent = 0;

  for (;;) {
    if (signal.aborted) return;

    const run = await runs.load(id);
    if (!run) return;

    for (const event of run.events.slice(sent)) yield event;
    sent = run.events.length;

    if (run.status !== "running") {
      yield { kind: "settled", run };
      return;
    }

    await new Promise((resume) => setTimeout(resume, LOOK_AGAIN));
  }
}
