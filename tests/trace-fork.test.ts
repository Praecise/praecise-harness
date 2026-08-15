/**
 * Observability, forking, and editing a run's history — the three things a mature graph
 * runtime has that praecise did not.
 *
 * Each is tested for the property that makes it worth having rather than for existing.
 * A tracer that only records successes flatters a dashboard; a fork that mutates the run
 * it forked from destroys the evidence it was meant to compare against; an edited output
 * that leaves no trace turns a record into a story.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  newSpanId,
  newTraceId,
  parseTraceparent,
  traceMeta,
  traceparentOf,
  traced,
  type Span,
} from "../src/harness/trace.js";
import { forkRun, startRun, type WorkflowDeps } from "../src/workflow/run.js";
import { RunStore } from "../src/workflow/store.js";
import { workflow } from "../src/define.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("spans, in the convention a collector already understands", () => {
  const collect = () => {
    const spans: Span[] = [];
    return { spans, tracer: (span: Span) => spans.push(span) };
  };

  it("names and attributes a model call as the GenAI convention specifies", async () => {
    const { spans, tracer } = collect();
    await traced(
      tracer,
      { operation: "chat", provider: "anthropic", model: "claude-sonnet-5" },
      async () => ({ usage: { inputTokens: 12, outputTokens: 34 } }),
      (answer) => ({ inputTokens: answer.usage.inputTokens, outputTokens: answer.usage.outputTokens }),
    );

    const span = spans[0]!;
    // Dashboards group on this name, so it is not free-form.
    expect(span.name).toBe("chat claude-sonnet-5");
    expect(span.kind).toBe("client");
    expect(span.attributes["gen_ai.operation.name"]).toBe("chat");
    expect(span.attributes["gen_ai.provider.name"]).toBe("anthropic");
    expect(span.attributes["gen_ai.request.model"]).toBe("claude-sonnet-5");
    expect(span.attributes["gen_ai.usage.input_tokens"]).toBe(12);
    expect(span.attributes["gen_ai.usage.output_tokens"]).toBe(34);
    expect(span.status.code).toBe("ok");
  });

  it("records the call that failed, which is the one worth having", async () => {
    // An exception path that skips the span is how a dashboard comes to show only
    // successes and a suspiciously good latency.
    const { spans, tracer } = collect();
    await expect(
      traced(tracer, { operation: "chat", provider: "openai", model: "gpt-x" }, async () => {
        throw new TypeError("upstream said no");
      }),
    ).rejects.toThrow("upstream said no");

    expect(spans).toHaveLength(1);
    expect(spans[0]?.status.code).toBe("error");
    // The convention wants the error TYPE: a message containing an id makes every
    // failure unique and ungroupable.
    expect(spans[0]?.attributes["error.type"]).toBe("TypeError");
  });

  it("costs nothing when nobody is listening", async () => {
    // Tracing that costs something when off is tracing people turn off.
    const value = await traced(undefined, { operation: "chat", provider: "x" }, async () => 42);
    expect(value).toBe(42);
  });

  it("puts a child span in its parent's trace", async () => {
    const { spans, tracer } = collect();
    const parent = { traceId: newTraceId(), spanId: newSpanId() };
    await traced(tracer, { operation: "execute_tool", provider: "github", toolName: "search", parent }, async () => "ok");

    expect(spans[0]?.traceId).toBe(parent.traceId);
    expect(spans[0]?.parentSpanId).toBe(parent.spanId);
    expect(spans[0]?.name).toBe("execute_tool search");
  });
});

describe("trace context across a process boundary", () => {
  it("round-trips a traceparent", () => {
    const context = { traceId: newTraceId(), spanId: newSpanId() };
    expect(parseTraceparent(traceparentOf(context))).toEqual(context);
  });

  it("refuses a malformed header rather than inventing a trace", () => {
    // A trace that looks joined and is not is worse than an obviously separate one,
    // because nobody investigates it.
    expect(parseTraceparent("garbage")).toBeUndefined();
    expect(parseTraceparent("00-tooshort-abc-01")).toBeUndefined();
    expect(parseTraceparent(undefined)).toBeUndefined();
    // All-zero ids are invalid by the spec.
    expect(parseTraceparent(`00-${"0".repeat(32)}-${"0".repeat(16)}-01`)).toBeUndefined();
  });

  it("travels in the `_meta` key MCP reserves for it", () => {
    const meta = traceMeta({ traceId: newTraceId(), spanId: newSpanId() });
    expect(Object.keys(meta)).toEqual(["traceparent"]);
    expect(meta.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });
});

describe("forking a run", () => {
  const SPEC = workflow({
    name: "triage",
    steps: [
      { id: "classify", ask: "classify", agent: "worker" },
      { id: "act", ask: "act", agent: "worker", after: ["classify"] },
    ],
  });

  async function deps(root: string, answer: (input: string) => string): Promise<WorkflowDeps> {
    return {
      harness: {
        name: "stub",
        ask: async (_plan: unknown, input: string) => ({
          text: answer(input),
          usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
        }),
      },
      store: new RunStore(join(root, "runs")),
      planFor: async () => ({ name: "worker", instructions: "", rungs: [], tools: [], services: [] }),
      callTool: async () => ({}),
    } as unknown as WorkflowDeps;
  }

  it("carries the early steps and re-runs only what came after", async () => {
    const root = await mkdtemp(join(tmpdir(), "praecise-fork-"));
    roots.push(root);

    const asked: string[] = [];
    const original = await startRun(SPEC, {}, await deps(root, (input) => {
      asked.push(input);
      return `did:${input}`;
    }));
    expect(original.status).toBe("done");
    expect(asked).toEqual(["classify", "act"]);

    asked.length = 0;
    const forked = await forkRun(original.id, SPEC, await deps(root, (input) => {
      asked.push(input);
      return `again:${input}`;
    }), { after: "classify" });

    // The carried step is not re-run; only what came after it is.
    expect(asked).toEqual(["act"]);
    expect(forked.outputs.classify).toEqual(original.outputs.classify);
    expect(forked.outputs.act).not.toEqual(original.outputs.act);
  });

  it("leaves the original exactly as it was", async () => {
    // A branch, not an edit. The run that happened stays readable beside the one that
    // might have — otherwise the comparison the fork exists for is impossible.
    const root = await mkdtemp(join(tmpdir(), "praecise-fork-"));
    roots.push(root);
    const store = new RunStore(join(root, "runs"));

    const original = await startRun(SPEC, {}, await deps(root, (i) => `did:${i}`));
    const before = JSON.stringify(await store.load(original.id));

    await forkRun(original.id, SPEC, await deps(root, (i) => `other:${i}`), { after: "classify" });

    expect(JSON.stringify(await store.load(original.id))).toBe(before);
  });

  it("records who edited an output, so the journal stays evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "praecise-fork-"));
    roots.push(root);

    const original = await startRun(SPEC, {}, await deps(root, (i) => `did:${i}`));
    const forked = await forkRun(original.id, SPEC, await deps(root, (i) => `did:${i}`), {
      after: "classify",
      patch: { classify: "refund" },
      by: "an operator",
    });

    expect(forked.outputs.classify).toBe("refund");
    const patched = forked.events.filter((event) => event.kind === "patched");
    expect(patched).toHaveLength(1);
    expect(patched[0]?.step).toBe("classify");
    expect(patched[0]?.detail).toContain("an operator");
    // And the fork says where it came from, so it is never mistaken for an independent run.
    expect(forked.forkedFrom?.run).toBe(original.id);
  });

  it("refuses to patch a step the fork does not carry", async () => {
    // Otherwise a value appears in the outputs for a step that is about to run and
    // overwrite it, which looks like an edit that silently did nothing.
    const root = await mkdtemp(join(tmpdir(), "praecise-fork-"));
    roots.push(root);
    const original = await startRun(SPEC, {}, await deps(root, (i) => `did:${i}`));

    await expect(
      forkRun(original.id, SPEC, await deps(root, (i) => `did:${i}`), {
        after: "classify",
        patch: { act: "something" },
      }),
    ).rejects.toThrow(/not among the steps carried/);
  });

  it("names the steps it does have when asked to fork after one it does not", async () => {
    const root = await mkdtemp(join(tmpdir(), "praecise-fork-"));
    roots.push(root);
    const original = await startRun(SPEC, {}, await deps(root, (i) => `did:${i}`));

    await expect(
      forkRun(original.id, SPEC, await deps(root, (i) => `did:${i}`), { after: "nonexistent" }),
    ).rejects.toThrow(/classify, act/);
  });
});
