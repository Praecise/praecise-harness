/**
 * Latent transport — the dense internal communication mechanism for agents.
 *
 * praecise ships the channel that carries opaque high-dimensional payloads (real
 * hidden-state vectors on arrival) between agents, plus a deterministic partial
 * monitor (`probe`) and content-addressed reference-passing. It ships the MECHANISM
 * only: the audit DISCIPLINE — where a latent payload may go, and that a decision a
 * human disposes on must be legible — belongs to the app built on top, because that
 * is a judgment, not a framework primitive.
 */

export interface LatentPayload {
  kind: "latent";
  audit: false;
  source: string;
  dims: number;
  vector: ArrayLike<number>;
}

/** Wrap a dense payload. `vector` is real hidden state on arrival; opaque by design. */
export function latent(vector: ArrayLike<number>, opts: { source?: string; dims?: number } = {}): LatentPayload {
  return { kind: "latent", audit: false, source: opts.source ?? "agent", dims: opts.dims ?? vector.length, vector };
}

export interface LatentChannel {
  send(from: string, to: string, payload: LatentPayload): void;
  recv(to: string): LatentPayload | null;
  depth(): number;
}

/** A minimal in-process channel carrying latent payloads between agents. */
export function latentChannel(): LatentChannel {
  const q: { from: string; to: string; payload: LatentPayload }[] = [];
  return {
    send(from, to, payload) {
      if (payload?.kind !== "latent") throw new Error("latentChannel carries latent payloads only");
      q.push({ from, to, payload });
    },
    recv(to) {
      const i = q.findIndex((m) => m.to === to);
      if (i < 0) return null;
      return q.splice(i, 1)[0]!.payload;
    },
    depth: () => q.length,
  };
}

export interface Probe {
  name: string;
  value: number;
  monitor: "partial";
  note: string;
}

/** Deterministic partial monitor of a latent payload — a probe, NOT a translation. */
export function probe(payload: LatentPayload, name: string, fn: (v: ArrayLike<number>) => number): Probe {
  if (payload?.kind !== "latent") throw new Error("probe expects a latent payload");
  return {
    name,
    value: fn(payload.vector),
    monitor: "partial",
    note: "a probe is a partial monitor of an opaque payload, not a lossless translation",
  };
}

export interface Refs {
  put(payload: unknown): string;
  get(id: string): unknown;
  has(id: string): boolean;
}

/** Reference-passing: content-addressed handles instead of re-inlining long context. */
export function createRefs(): Refs {
  const store = new Map<string, unknown>();
  const hash = (s: string): string => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16);
  };
  return {
    put: (p) => { const id = `ref-${hash(JSON.stringify(p))}`; store.set(id, p); return id; },
    get: (id) => store.get(id),
    has: (id) => store.has(id),
  };
}
