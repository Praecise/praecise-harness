/**
 * Reading the record back, and what may follow from it.
 *
 * The property under test throughout is that nothing an agent carries changes without
 * somebody saying so, and that the record it was drawn from survives every one of these
 * operations unaltered.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentPlan } from "../src/compile/plan.js";
import {
  MOST_CARRIED,
  NoteBook,
  renderNotes,
  review,
  reviewerPlan,
  type Candidate,
  type Note,
  type ProposedNote,
} from "../src/harness/consolidate.js";
import { Memory, memoryDir, type Episode, type Jotting } from "../src/harness/memory.js";
import { FileShelf } from "../src/harness/shelf.js";
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

const episode = (id: string, input: string, answer: string, origin: Episode["origin"] = "agent"): Episode => ({
  id,
  input,
  answer,
  at: Date.now(),
  origin,
});

const jotting = (id: string, subject: string, text: string): Jotting => ({
  id,
  subject,
  text,
  at: Date.now(),
  origin: "agent",
});

const episodes: Episode[] = [
  episode("e1", "my export keeps failing", "the file is over a gigabyte"),
  episode("e2", "it failed again on a big file", "same cause, over a gigabyte"),
];

const fact = (text: string, from: string[] = ["e1"]): ProposedNote => ({
  kind: "fact",
  text,
  from,
  origin: "agent",
  at: Date.now(),
});

const candidate = (notes: ProposedNote[], retire: Candidate["retire"] = []): Candidate => ({
  agent: "support",
  at: Date.now(),
  read: { episodes: 2, jottings: 0, carried: 0, since: 0, until: 0 },
  notes,
  retire,
});

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "praecise-notes-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("reviewing the record", () => {
  it("keeps what cites the record and drops what cites nothing that was read", async () => {
    const harness = answering({
      notes: [
        { kind: "fact", text: "Exports fail on files over a gigabyte.", from: ["e1", "e2"] },
        { kind: "fact", text: "The customer is in Lisbon.", from: ["e9"] },
        { kind: "fact", text: "   ", from: ["e1"] },
        { kind: "fact", text: "Cites nothing at all." },
      ],
    });

    const proposal = await review(harness, plan, { episodes, jottings: [], carried: [] });

    expect(proposal.notes.map((note) => note.text)).toEqual(["Exports fail on files over a gigabyte."]);
    expect(proposal.notes[0]!.from).toEqual(["e1", "e2"]);
    expect(proposal.problems?.[0]).toContain("3 proposed entries");
  });

  it("proposes a procedure only where it has a name", async () => {
    const harness = answering({
      notes: [
        { kind: "procedure", name: "export a large file", text: "Split it, then upload the parts.", from: ["e1"] },
        { kind: "procedure", text: "A way with no name.", from: ["e1"] },
      ],
    });
    const proposal = await review(harness, plan, { episodes, jottings: [], carried: [] });
    expect(proposal.notes).toHaveLength(1);
    expect(proposal.notes[0]).toMatchObject({ kind: "procedure", name: "export a large file" });
  });

  it("can cite a working note, and holds the proposal to the lowest authority it cites", async () => {
    const outside = episode("e3", "what does the page say", "it says refunds are instant", "external");
    const harness = answering({
      notes: [
        { kind: "fact", text: "Refunds are instant.", from: ["e3", "n1"] },
        { kind: "fact", text: "Exports fail over a gigabyte.", from: ["n1"] },
      ],
    });
    const proposal = await review(harness, plan, {
      episodes: [...episodes, outside],
      jottings: [jotting("n1", "exports", "they fail over a gigabyte")],
      carried: [],
    });
    expect(proposal.notes.map((note) => note.origin)).toEqual(["external", "agent"]);
    expect(proposal.read).toMatchObject({ episodes: 3, jottings: 1 });
  });

  it("shows the reviewer what is carried, and takes replacements and retirements only of that", async () => {
    const held: Note = { id: "c1", kind: "fact", text: "On the monthly plan.", from: ["e0"], origin: "agent", at: 1 };
    const seen: { plan?: AgentPlan; input?: string } = {};
    const harness = answering(
      {
        notes: [{ kind: "fact", text: "On the annual plan.", from: ["e2"], replaces: ["c1", "c404"] }],
        retire: [
          { id: "c1", from: ["e2"], why: "they switched" },
          { id: "c404", from: ["e2"], why: "not a thing" },
          { id: "c1", from: ["e404"], why: "cites nothing read" },
        ],
      },
      seen,
    );

    const proposal = await review(harness, plan, { episodes, jottings: [], carried: [held] });

    expect(seen.input).toContain("[c1] fact: On the monthly plan.");
    expect(proposal.notes[0]!.replaces).toEqual(["c1"]);
    expect(proposal.retire.map((entry) => entry.id)).toEqual(["c1"]);
    expect(proposal.retire[0]).toMatchObject({ why: "they switched", origin: "agent" });
  });

  it("reads with no tools and no memory of its own", async () => {
    const seen: { plan?: AgentPlan; input?: string } = {};
    await review(answering({ notes: [] }, seen), { ...plan, locals: [{ name: "x" } as never] }, {
      episodes,
      jottings: [],
      carried: [],
    });
    expect(seen.plan).toMatchObject({ name: "support:review", memory: false, locals: [], services: [] });
    expect(reviewerPlan(plan).returns).toHaveProperty("retire");
  });

  it("says so when there is nothing to read, and when the record could not be read", async () => {
    const empty = await review(answering({}), plan, { episodes: [], jottings: [], carried: [] });
    expect(empty.problems).toEqual(["there was nothing to read"]);

    const failing: Harness = {
      name: "stub",
      async ask() {
        throw new Error("endpoint down");
      },
    };
    const failed = await review(failing, plan, { episodes, jottings: [], carried: [] });
    expect(failed.notes).toEqual([]);
    expect(failed.problems?.[0]).toContain("endpoint down");
  });
});

describe("what an agent carries", () => {
  it("carries nothing until a proposal is accepted", async () => {
    const book = new NoteBook(new FileShelf(dir));
    await book.propose(candidate([fact("Exports fail over a gigabyte.")]));

    expect(await book.notes("support")).toEqual([]);
    expect(renderNotes(await book.notes("support"))).toBe("");
    expect((await book.pending("support"))?.notes).toHaveLength(1);
  });

  it("accepting adds to what is carried, and nothing is dropped for not being proposed again", async () => {
    const book = new NoteBook(new FileShelf(dir));
    await book.propose(candidate([fact("Exports fail over a gigabyte.")]));
    await book.accept("support");
    await book.propose(candidate([fact("The customer is on the annual plan.", ["e2"])]));
    const done = await book.accept("support");

    expect(done.kept.map((note) => note.text)).toEqual(["The customer is on the annual plan."]);
    expect((await book.notes("support")).map((note) => note.text)).toEqual([
      "Exports fail over a gigabyte.",
      "The customer is on the annual plan.",
    ]);
    expect(await book.pending("support")).toBeUndefined();
  });

  it("accepts by position, counting entries first and retirements after", async () => {
    const book = new NoteBook(new FileShelf(dir));
    await book.propose(candidate([fact("one"), fact("two")]));
    const first = await book.accept("support", [0, 1]);
    const [one] = first.kept;

    await book.propose(
      candidate(
        [fact("three"), fact("four")],
        [{ id: one!.id, why: "no longer so", from: ["e2"], origin: "agent", at: Date.now() }],
      ),
    );
    const done = await book.accept("support", [1, 2]);

    expect(done.kept.map((note) => note.text)).toEqual(["four"]);
    expect(done.closed.map((note) => note.text)).toEqual(["one"]);
    expect((await book.notes("support")).map((note) => note.text)).toEqual(["two", "four"]);
  });

  it("closes what a replacement replaces, and keeps it in the history", async () => {
    const book = new NoteBook(new FileShelf(dir));
    await book.propose(candidate([fact("On the monthly plan.")]));
    const [old] = (await book.accept("support")).kept;

    await book.propose(candidate([{ ...fact("On the annual plan.", ["e2"]), replaces: [old!.id] }]));
    await book.accept("support");

    expect((await book.notes("support")).map((note) => note.text)).toEqual(["On the annual plan."]);
    const history = await book.history("support");
    const closed = history.find((note) => note.id === old!.id)!;
    expect(closed.until).toBeTypeOf("number");
    expect(renderNotes(history)).not.toContain("monthly");
  });

  it("lets a person stop carrying one entry", async () => {
    const book = new NoteBook(new FileShelf(dir));
    await book.propose(candidate([fact("one"), fact("two")]));
    const { kept } = await book.accept("support");

    expect(await book.retire("support", kept[0]!.id)).toBe(true);
    expect(await book.retire("support", kept[0]!.id)).toBe(false);
    expect((await book.notes("support")).map((note) => note.text)).toEqual(["two"]);
    expect(await book.history("support")).toHaveLength(2);
  });

  it("refuses to carry more than is read on every request, and changes nothing", async () => {
    const book = new NoteBook(new FileShelf(dir));
    const many = Array.from({ length: 24 }, (_, at) => fact(`fact ${at}`));
    await book.propose(candidate(many));
    await book.accept("support");
    await book.propose(candidate(many.map((note) => ({ ...note, text: `${note.text} again` }))));
    await book.accept("support");
    expect(await book.notes("support")).toHaveLength(MOST_CARRIED);

    await book.propose(candidate([fact("one too many")]));
    await expect(book.accept("support")).rejects.toThrow(/the most is 48/);
    expect(await book.notes("support")).toHaveLength(MOST_CARRIED);
    // The proposal is still there to accept part of.
    expect(await book.pending("support")).toBeDefined();
  });

  it("rejecting discards the proposal and leaves what is carried", async () => {
    const book = new NoteBook(new FileShelf(dir));
    await book.propose(candidate([fact("one")]));
    await book.accept("support");
    await book.propose(candidate([fact("two")]));
    await book.reject("support");

    expect(await book.pending("support")).toBeUndefined();
    expect((await book.notes("support")).map((note) => note.text)).toEqual(["one"]);
    await expect(book.accept("support")).rejects.toThrow(/no proposal waiting/);
  });

  it("renders facts and procedures apart", async () => {
    const book = new NoteBook(new FileShelf(dir));
    await book.propose(
      candidate([
        fact("Exports fail over a gigabyte."),
        { kind: "procedure", name: "export a large file", text: "Split it, then upload the parts.", from: ["e1"], origin: "agent", at: 1 },
      ]),
    );
    await book.accept("support");

    const block = renderNotes(await book.notes("support"));
    expect(block).toContain("What you have learned across past conversations:\n- Exports fail over a gigabyte.");
    expect(block).toContain("Procedures you can reuse:\n- export a large file: Split it, then upload the parts.");
  });
});

describe("the record survives all of it", () => {
  it("is byte for byte what it was after a review, an accept and a reject", async () => {
    const memory = new Memory(dir);
    await memory.record("support", { input: "my export keeps failing", answer: "over a gigabyte", origin: "agent" });
    await memory.record("support", { input: "again", answer: "same cause", origin: "agent" });
    const path = join(memoryDir(dir, "support"), "exchanges.json");
    const before = await readFile(path, "utf8");

    const kept = await memory.all("support");
    const book = new NoteBook(new FileShelf(dir));
    const proposal = await review(
      answering({ notes: [{ kind: "fact", text: "Exports fail over a gigabyte.", from: [kept[0]!.id] }] }),
      plan,
      { episodes: kept, jottings: [], carried: [] },
    );
    await book.propose(proposal);
    await book.accept("support");
    await book.propose(proposal);
    await book.reject("support");

    expect(await readFile(path, "utf8")).toBe(before);
  });
});
