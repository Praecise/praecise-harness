/**
 * Reading a server-sent event stream.
 *
 * All three wires stream the same way — a response body of `data:` lines, each
 * carrying one JSON object — and differ only in what those objects say. So the
 * reading is here and the interpreting is in each adapter.
 *
 * The one thing worth being careful about is that a chunk boundary lands
 * wherever the network put it, which is regularly halfway through a line and
 * occasionally halfway through a multi-byte character. So bytes are decoded
 * with a streaming decoder and lines are only emitted once their terminator has
 * arrived.
 */

/** Yield each `data:` payload in order, skipping comments and end markers. */
export async function* events(body: ReadableStream<Uint8Array> | null): AsyncGenerator<unknown> {
  if (!body) return;

  const reader = body.getReader();
  const decode = new TextDecoder();
  let pending = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      pending += decode.decode(value, { stream: true });

      let at: number;
      while ((at = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, at).replace(/\r$/, "");
        pending = pending.slice(at + 1);

        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        // "[DONE]" is a terminator some endpoints send and none require.
        if (!payload || payload === "[DONE]") continue;

        try {
          yield JSON.parse(payload);
        } catch {
          // A frame that is not JSON is not something to fail a request over.
        }
      }
    }
  } finally {
    // Release the body whether the caller drained it or walked away mid-answer.
    await reader.cancel().catch(() => {});
  }
}

/**
 * Tool arguments arrive as a JSON string in fragments, and are only parseable
 * once the last one has landed.
 */
export class Fragments {
  private readonly parts = new Map<number, { id: string; name: string; json: string }>();

  open(at: number, id: string, name: string): void {
    const existing = this.parts.get(at);
    if (existing) {
      if (id) existing.id = id;
      if (name) existing.name = name;
      return;
    }
    this.parts.set(at, { id, name, json: "" });
  }

  push(at: number, json: string): void {
    const part = this.parts.get(at);
    if (part) part.json += json;
    else this.parts.set(at, { id: "", name: "", json });
  }

  /** Everything gathered, in the order the endpoint opened it. */
  done(): { id: string; name: string; args: Record<string, unknown> }[] {
    return [...this.parts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, part]) => ({ id: part.id, name: part.name, args: parse(part.json) }));
  }
}

function parse(json: string): Record<string, unknown> {
  if (!json.trim()) return {};
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    // A truncated stream leaves unparseable arguments; an empty object is a
    // better thing to hand a tool than a half-finished one.
    return {};
  }
}
