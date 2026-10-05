/**
 * A sealed journal of what a workflow run did, step by step.
 *
 * Each finished step becomes one entry: which step, what went in and came out
 * (as digests, so the journal can leave the building without the data), the
 * action it took, the approvals it carried, the evidence its model calls came
 * with and the sandbox snapshot it ran from. Entries are numbered and each names
 * the hash of the one before, so a removed or reordered entry breaks the chain;
 * with a signer each hash is signed, so an edited one fails verification.
 *
 * The sink is where entries go — a log service, a ledger, a file — and may hand
 * back an anchor for an entry once it has been fixed somewhere outside the app.
 * Delivery is at least once and keyed by (run, seq): an entry is recorded on the
 * run BEFORE it is delivered, so a crash between the two re-delivers it on
 * recovery rather than losing it.
 */

import { createHash } from "node:crypto";

import type { Action } from "./define.js";
import type { PaymentRecord } from "./payments.js";

/** Signs bytes with a key the app holds, naming which key. */
export interface Signer {
  sign(bytes: Uint8Array): Promise<{ signature: string; keyRef: string }>;
  /** Check a signature made by `sign`; needed to verify a journal, not to write one. */
  verify?(bytes: Uint8Array, signature: string, keyRef: string): Promise<boolean>;
}

export interface JournalEntry {
  run: string;
  workflow: string;
  step: string;
  seq: number;
  /** Hash of the previous entry of this run; null for the first. */
  prev: string | null;
  at: number;
  /** SHA-256 of the step's resolved input, canonical JSON. */
  input: string;
  /** SHA-256 of the step's output, canonical JSON. */
  output: string;
  tool?: string;
  action?: Action;
  tainted?: boolean;
  approvals?: { subject?: string; digest?: string; signature?: string }[];
  evidence?: unknown[];
  /** The snapshot the step's sandbox was left in, when one is configured. */
  sandbox?: string;
  /** The idempotency key the step's effect ran under. */
  key?: string;
  /** Payments the step made or found already settled under its key. */
  payments?: PaymentRecord[];
}

export interface SealedEntry {
  entry: JournalEntry;
  /** SHA-256 of the entry's canonical JSON, hex. */
  hash: string;
  signature?: string;
  keyRef?: string;
}

export interface JournalSink {
  /** Take one entry. Called at least once per (run, seq); dedupe on that pair. */
  append(sealed: SealedEntry): Promise<{ anchor?: string } | void>;
}

/** Where the app's work runs, when it can be snapshotted and put back. */
export interface Sandbox {
  /** Fix the current state and name it. Called after each journalled step. */
  snapshot(at: { run: string; step: string }): Promise<string>;
  /** Return to a state `snapshot` named. */
  restore(ref: string): Promise<void>;
}

export interface Journal {
  sink: JournalSink;
  /** Signs every entry hash. Absent ⇒ entries are hash-chained but unsigned, and say so. */
  signer?: Signer;
}

/** JSON with keys sorted at every depth, so equal values hash equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? "null";
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  if (typeof value === "bigint") return value.toString();
  return value;
}

export function digestOf(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value ?? null)).digest("hex");
}

/** Hash an entry and sign the hash, if there is a signer. */
export async function seal(entry: JournalEntry, signer?: Signer): Promise<SealedEntry> {
  const hash = digestOf(entry);
  if (!signer) return { entry, hash };
  const { signature, keyRef } = await signer.sign(Buffer.from(hash, "hex"));
  return { entry, hash, signature, keyRef };
}

/**
 * Check a run's sealed entries: numbering, chaining, hashes, and signatures when
 * a verifier is given. Answers with the first problem found, or nothing.
 */
export async function verifyJournal(
  entries: SealedEntry[],
  verifier?: Pick<Signer, "verify">,
): Promise<string | undefined> {
  let prev: string | null = null;
  for (const [i, sealed] of entries.entries()) {
    const { entry } = sealed;
    if (entry.seq !== i) return `entry ${i} is numbered ${entry.seq}`;
    if (entry.prev !== prev) return `entry ${i} does not follow the entry before it`;
    if (digestOf(entry) !== sealed.hash) return `entry ${i} does not match its hash`;
    if (verifier?.verify) {
      if (!sealed.signature || !sealed.keyRef) return `entry ${i} is not signed`;
      const ok = await verifier.verify(Buffer.from(sealed.hash, "hex"), sealed.signature, sealed.keyRef);
      if (!ok) return `entry ${i} has a signature that does not verify`;
    }
    prev = sealed.hash;
  }
  return undefined;
}
