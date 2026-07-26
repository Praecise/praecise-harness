/**
 * Reading the record back, and what may follow from it.
 *
 * The property under test throughout is that nothing an agent carries changes
 * without somebody saying so, and that the record it was drawn from survives
 * every one of these operations unaltered.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentPlan } from "../src/compile/plan.js";
import {
  NoteBook,
  consolidate,
  consolidatorPlan,
  renderNotes,
  type Candidate,
} from "../src/harness/consolidate.js";
import { Memory, type Episode } from "../src/harness/memory.js";
import type { Answer, Harness } from "../src/harness/types.js";

const plan: AgentPlan = {
  name: "support",
  description: "helps",
  quality: "fast",
  instructions: "You help people with refunds.",
  rungs: [],
  services: [],
  locals: [],
  memory: true,
  problems: [],
};

function answering(data: unknown, seen?: { plan?: AgentPlan; input?: string }): Harness {
  return {
    name: "stub",
    async ask(given, input) {
      if (seen) {
        seen.plan = given;
        seen.input = input;
      }
      return {
        text: "",
        data,
        path: ["stub"],
        usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, decidingTokens: 0 },
        toolCalls: [],
        harness: "stub",
      } satisfies Answer;
    },
  };
}

const episode = (id: string, input: string, answer: string): Episode => ({
  id,
  input,
  answer,
  at: Date.now(),
});

const record: Episode[] = [
  episode("e1", "my export keeps failing", "the file is over a gigabyte"),
  episode("e2", "it failed again on a big file", "same cause, over a gigabyte"),
];

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "praecise-notes-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("proposing what to carry forward", () => {
  it("keeps a note that cites exchanges it was given", async () => {
    const harness = answering({ notes: [{ text: "exports fail over a gigabyte", from: ["e1", "e2"] }] });
    const candidate = await consolidate(harness, plan, record);

    expect(candidate.notes).toEqual([
      { text: "exports fail over a gigabyte", from: ["e1", "e2"] },
    ]);
    expect(candidate.read.episodes).toBe(2);
  });

  it("drops a note whose sources were never read", async () => {
    // Nobody can check a claim against exchanges that do not exist, and the
    // likeliest reason for one is that it was invented.
    const harness = answering({
      notes: [
        { text: "exports fail over a gigabyte", from: ["e1"] },
        { text: "the customer is on the annual plan", from: ["e99"] },
      ],
    });
    const candidate = await consolidate(harness, plan, record);

    expect(candidate.notes.map((note) => note.text)).toEqual(["exports fail over a gigabyte"]);
    expect(candidate.problems?.[0]).toContain("cited nothing that was read");
  });

  it("proposes nothing rather than failing when the model gives nothing back", async () => {
    const candidate = await consolidate(answering({}), plan, record);
    expect(candidate.notes).toEqual([]);
  });

  it("says there was nothing to read rather than asking about an empty record", async () => {
    let asked = false;
    const harness: Harness = {
      name: "stub",
      ask: async () => {
        asked = true;
        throw new Error("should not have been asked");
      },
    };
    const candidate = await consolidate(harness, plan, []);
    expect(asked).toBe(false);
    expect(candidate.problems).toEqual(["there was nothing to read"]);
  });

  it("reads the record with none of the agent's own equipment", async () => {
    const seen: { plan?: AgentPlan; input?: string } = {};
    const rich: AgentPlan = {
      ...plan,
      services: [{ name: "web" }] as unknown as AgentPlan["services"],
      locals: [{ name: "lookup" }] as unknown as AgentPlan["locals"],
      memoryStore: "notes",
    };
    await consolidate(answering({ notes: [] }, seen), rich, record);

    expect(seen.plan?.services).toEqual([]);
    expect(seen.plan?.locals).toEqual([]);
    expect(seen.plan?.memory).toBe(false);
    expect(seen.plan?.memoryStore).toBeUndefined();
    expect(seen.plan?.instructions).not.toContain("refunds");
    expect(seen.input).toContain("[e1]");
  });

  it("keeps the exchange ids visible so a note can be checked against them", () => {
    expect(consolidatorPlan(plan).returns?.notes).toContain("from");
  });
});

describe("a proposal and the record it came from", () => {
  const candidate = (notes: Candidate["notes"]): Candidate => ({
    agent: "support",
    at: Date.now(),
    read: { episodes: 2, since: 0, until: 1 },
    notes,
  });

  it("leaves the record byte for byte as it was", async () => {
    const memory = new Memory(dir);
    await memory.record("support", { input: "my export keeps failing", answer: "over a gigabyte" });
    const file = join(dir, "support.json");
    const before = await readFile(file, "utf8");

    const book = new NoteBook(dir);
    await book.propose(candidate([{ text: "exports fail over a gigabyte", from: ["e1"] }]));
    await book.accept("support");
    await book.propose(candidate([{ text: "something else", from: ["e1"] }]));
    await book.reject("support");

    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("carries nothing until a proposal has been accepted", async () => {
    const book = new NoteBook(dir);
    await book.propose(candidate([{ text: "exports fail over a gigabyte", from: ["e1"] }]));

    expect(await book.notes("support")).toEqual([]);
    expect((await book.pending("support"))?.notes).toHaveLength(1);

    await book.accept("support");
    expect(await book.notes("support")).toHaveLength(1);
    expect(await book.pending("support")).toBeUndefined();
  });

  it("keeps only the notes chosen by position", async () => {
    const book = new NoteBook(dir);
    await book.propose(
      candidate([
        { text: "first", from: ["e1"] },
        { text: "second", from: ["e1"] },
        { text: "third", from: ["e2"] },
      ]),
    );

    const kept = await book.accept("support", [0, 2]);
    expect(kept.map((note) => note.text)).toEqual(["first", "third"]);
  });

  it("replaces what was accepted before rather than piling on top of it", async () => {
    const book = new NoteBook(dir);
    await book.propose(candidate([{ text: "first", from: ["e1"] }]));
    await book.accept("support");
    await book.propose(candidate([{ text: "second", from: ["e1"] }]));
    await book.accept("support");

    expect((await book.notes("support")).map((note) => note.text)).toEqual(["second"]);
  });

  it("discards a proposal without touching what is already carried", async () => {
    const book = new NoteBook(dir);
    await book.propose(candidate([{ text: "kept", from: ["e1"] }]));
    await book.accept("support");
    await book.propose(candidate([{ text: "not kept", from: ["e1"] }]));
    await book.reject("support");

    expect((await book.notes("support")).map((note) => note.text)).toEqual(["kept"]);
    expect(await book.pending("support")).toBeUndefined();
  });

  it("refuses to accept a proposal that was never made", async () => {
    await expect(new NoteBook(dir).accept("support")).rejects.toThrow(/no proposal/);
  });

  it("keeps one agent's notes out of another's", async () => {
    const book = new NoteBook(dir);
    await book.propose(candidate([{ text: "only support's", from: ["e1"] }]));
    await book.accept("support");
    expect(await book.notes("billing")).toEqual([]);
  });
});

describe("what the record itself can give back", () => {
  it("hands over everything kept, oldest first", async () => {
    const memory = new Memory(dir);
    await memory.record("support", { input: "one", answer: "a" });
    await memory.record("support", { input: "two", answer: "b" });

    expect((await memory.all("support")).map((e) => e.input)).toEqual(["one", "two"]);
  });
});

describe("rendering", () => {
  it("says nothing at all when there is nothing carried", () => {
    expect(renderNotes([])).toBe("");
  });

  it("carries the text and not the bookkeeping", () => {
    const rendered = renderNotes([{ text: "exports fail over a gigabyte", from: ["e1"] }]);
    expect(rendered).toContain("exports fail over a gigabyte");
    expect(rendered).not.toContain("e1");
  });
});
