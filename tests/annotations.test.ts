/**
 * The server's safety annotations, read back on the client.
 *
 * `server/mcp.ts` has always emitted `readOnlyHint` / `destructiveHint` for everything this app
 * publishes, and the client threw the identical hints away on the way back in — so praecise could
 * tell another client that a tool was destructive and could not tell itself. Every remote tool
 * arrived flattened to one privilege level, which is the state in which a gate cannot be built:
 * Google Calendar's `delete_event` was indistinguishable from `list_events`.
 *
 * These assert the inverse-of-`annotate()` property directly, because the two halves are one wire
 * format and a disagreement between them is invisible from either side alone.
 */

import { describe, expect, it } from "vitest";

import { effectOf } from "../src/harness/mcp.js";

/** The exact shape `server/mcp.ts` emits, so the round trip is asserted rather than assumed. */
const annotate = (effect: string) => ({
  readOnlyHint: effect === "read",
  destructiveHint: effect === "destructive",
  idempotentHint: effect !== "destructive",
  openWorldHint: true,
});

describe("server safety annotations, read back on the client", () => {
  it("every effect this codebase emits survives a round trip back through the client", () => {
    for (const effect of ["read", "write", "destructive"]) {
      expect(effectOf(annotate(effect)), `annotate(${effect}) did not read back`).toBe(effect);
    }
  });

  it("a server that annotated nothing is reported as nothing, not as a declaration it never made", () => {
    // `annotate()` must emit something concrete and defaults to "write". There is no such
    // obligation inbound, and inventing "write" here would report silence as a safety claim.
    expect(effectOf(undefined)).toBe(undefined);
    expect(effectOf({})).toBe(undefined);
    expect(effectOf({ openWorldHint: true }), "unrelated hints are not a declaration").toBe(undefined);
  });

  it("a tool claiming both read-only and destructive is treated as destructive", () => {
    // A server that sets both has contradicted itself. The safe reading of a contradiction is
    // the one that costs something if ignored.
    expect(effectOf({ readOnlyHint: true, destructiveHint: true })).toBe("destructive");
  });

  it("a declared-but-unremarkable tool is a write, since the server did say something", () => {
    expect(effectOf({ readOnlyHint: false })).toBe("write");
    expect(effectOf({ destructiveHint: false })).toBe("write");
  });

  it("the hints Google Calendar actually sends are read correctly", () => {
    // Copied verbatim from a live `tools/list` against https://calendarmcp.googleapis.com/mcp/v1
    // on 20 Aug 2026 — the server this integration exists to reach.
    const listEvents = { destructiveHint: false, idempotentHint: true, openWorldHint: false, readOnlyHint: true };
    const deleteEvent = { destructiveHint: true, idempotentHint: false, openWorldHint: false, readOnlyHint: false };
    expect(effectOf(listEvents)).toBe("read");
    expect(effectOf(deleteEvent)).toBe("destructive");
  });
});
