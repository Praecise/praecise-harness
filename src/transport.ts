/**
 * Latent transport — the dense internal communication mechanism for agents.
 *
 * praecise ships the channel that carries opaque high-dimensional payloads (real
 * hidden-state vectors on arrival) between agents, plus a deterministic partial
 * monitor (`probe`) and content-addressed reference-passing. It ships the MECHANISM
 * only: the audit DISCIPLINE — where a latent payload may go, and that a decision a
 * human disposes on must be legible — belongs to the app built on top, because that
 * is a judgment, not a framework primitive. The one seam the framework does hold:
 * its own audit surfaces (judge evidence, PROV) never treat a latent payload as
 * legible text — `isLatent` and `latentRef` are what they use to keep that true.
 */

export interface LatentPayload {
  kind: "latent";
  audit: false;
  source: string;
  dims: number;
  /** How many serial latent steps the payload encodes — latent reasoning has a
   *  compute-depth dimension a monitor must be able to see (Interlat/COCONUT). */
  depth: number;
  vector: ArrayLike<number>;
}

/** Wrap a dense payload. `vector` is real hidden state on arrival; opaque by design. */
export function latent(vector: ArrayLike<number>, opts: { source?: string; dims?: number; depth?: number } = {}): LatentPayload {
  return { kind: "latent", audit: false, source: opts.source ?? "agent", dims: opts.dims ?? vector.length, depth: opts.depth ?? 1, vector };
}

/** True of a latent payload wherever it turns up — including one revived from JSON,
 *  which is why this checks shape rather than identity. */
export function isLatent(value: unknown): value is LatentPayload {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "latent" &&
    "vector" in (value as object)
  );
}

/** What an audit surface records in place of a latent payload: the typed opaque
 *  reference (kind, dims, depth, source, content hash) — never the vector, which is
 *  not evidence to any reader and would only claim a legibility it does not have. */
export interface LatentRef {
  kind: "latent";
  opaque: true;
  source: string;
  dims: number;
  depth: number;
  hash: string;
}

export function latentRef(payload: LatentPayload): LatentRef {
  return {
    kind: "latent",
    opaque: true,
    source: payload.source,
    dims: payload.dims,
    depth: payload.depth,
    hash: fnv1a64(JSON.stringify(Array.from(payload.vector))),
  };
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

/** FNV-1a over 64 bits, as fixed-width hex. 32 bits alias after ~10^5 payloads
 *  (birthday bound); 64 keeps content addressing honest at any realistic volume. */
function fnv1a64(s: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

export interface Refs {
  put(payload: unknown): string;
  get(id: string): unknown;
  has(id: string): boolean;
}

/** Reference-passing: content-addressed handles instead of re-inlining long context.
 *  A colliding put with DIFFERENT content throws rather than aliasing — a handle
 *  that silently pointed at someone else's payload would be worse than no handle.
 *  `opts.hash` exists so a test can force that collision; leave it alone otherwise. */
export function createRefs(opts: { hash?: (s: string) => string } = {}): Refs {
  const store = new Map<string, { body: string; payload: unknown }>();
  const hash = opts.hash ?? fnv1a64;
  return {
    put: (p) => {
      const body = JSON.stringify(p) ?? "undefined";
      const id = `ref-${hash(body)}`;
      const existing = store.get(id);
      if (existing && existing.body !== body) {
        throw new Error(`ref ${id} already holds different content — refusing to alias`);
      }
      store.set(id, { body, payload: p });
      return id;
    },
    get: (id) => store.get(id)?.payload,
    has: (id) => store.has(id),
  };
}
