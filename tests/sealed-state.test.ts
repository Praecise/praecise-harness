import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  agent,
  createApp,
  type App,
  type AppOptions,
  type Conversations,
  type Episode,
  type Recollection,
  type StateCipher,
  type Thread,
} from "../src/index.js";
import { scriptedModel } from "../src/testing/index.js";
import { cleanup, makeProject } from "./helpers.js";

/** AES-256-GCM under a key held by the test, as an app would bring one. */
function cipher(key = randomBytes(32)): StateCipher {
  return {
    async seal(plain) {
      const iv = randomBytes(12);
      const sealing = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([sealing.update(plain), sealing.final()]);
      return Buffer.concat([iv, sealing.getAuthTag(), body]);
    },
    async open(sealed) {
      const bytes = Buffer.from(sealed);
      const opening = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      opening.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([opening.update(bytes.subarray(28)), opening.final()]);
    },
  };
}

const SECRET = "the vault code is 4417";

describe("threads and memory can be sealed or stored elsewhere", () => {
  let root: string | undefined;
  let app: App | undefined;

  afterEach(async () => {
    await app?.close();
    if (root) await cleanup(root);
    app = undefined;
    root = undefined;
  });

  async function build(options: AppOptions, fresh = true) {
    if (fresh || !root) root = await makeProject({});
    const model = scriptedModel([], { fallback: "Noted." });
    app = await createApp(
      {
        root,
        config: { models: model.models, preference: "quality" },
        agents: { keeper: agent({ role: "You keep notes.", memory: true }) },
      },
      options,
    );
    return model;
  }

  /** Every file under the state directory, as bytes. */
  async function stateFiles(): Promise<{ path: string; text: string }[]> {
    const found: { path: string; text: string }[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else found.push({ path, text: (await readFile(path)).toString("latin1") });
      }
    };
    await walk(join(root!, ".praecise"));
    return found;
  }

  it("writes both as plain JSON where nothing was asked for, as before", async () => {
    await build({});
    await app!.ask("keeper", SECRET, { thread: "t1" });
    const files = await stateFiles();
    expect(files.filter((file) => file.text.includes(SECRET)).length).toBeGreaterThanOrEqual(2);
  });

  it("seals conversations with a cipher, and reads them back across a restart", async () => {
    const key = cipher();
    const model = await build({ threads: key });
    await app!.ask("keeper", SECRET, { thread: "t1" });

    const kept = (await stateFiles()).filter((file) => file.path.includes("threads"));
    expect(kept).toHaveLength(1);
    expect(kept[0]!.text).not.toContain(SECRET);
    expect(kept[0]!.text.startsWith("praecise-sealed-state:v1\n")).toBe(true);

    await app!.close();
    const again = await build({ threads: key }, false);
    await app!.ask("keeper", "and what was it?", { thread: "t1" });
    // The earlier turn was carried into the request.
    expect(again.requests[0]!.messages.map((message) => message.content)).toContain(SECRET);
    expect((await app!.threads.list()).map((thread) => thread.id)).toEqual(["t1"]);
    expect((await app!.threads.load("t1"))!.turns).toHaveLength(4);
    expect(model.requests).toHaveLength(1);
  });

  it("seals what an agent remembers and the notes learned from it", async () => {
    const key = cipher();
    await build({ memory: key });
    await app!.ask("keeper", SECRET);
    await app!.ask("keeper", "the vault code again?");

    for (const file of await stateFiles()) expect(file.text).not.toContain(SECRET);
    expect((await app!.recorded("keeper")).map((episode) => episode.input)).toContain(SECRET);

    await app!.close();
    const again = await build({ memory: key }, false);
    await app!.ask("keeper", "what is the vault code?");
    // Recalled from the sealed record into the instructions.
    expect(again.requests[0]!.system).toContain(SECRET);
  });

  it("refuses a plain file once a cipher is set, and a sealed one once it is not, without writing over either", async () => {
    await build({});
    await app!.ask("keeper", SECRET, { thread: "t1" });
    await app!.close();
    const plain = (await stateFiles()).find((file) => file.path.includes("threads"))!;

    await build({ threads: cipher(), memory: cipher() }, false);
    await expect(app!.ask("keeper", "again", { thread: "t1" })).rejects.toThrow(/is not sealed/);
    expect((await readFile(plain.path)).toString("latin1")).toBe(plain.text);
    // Memory that cannot be opened is a note, not a lost record.
    const answer = await app!.ask("keeper", "again");
    expect(answer.notes?.join("\n")).toContain("could not read memory");
    await app!.close();

    // The other way about: sealed on disk, and no cipher given.
    root = await makeProject({});
    const key = cipher();
    await build({ threads: key }, false);
    await app!.ask("keeper", SECRET, { thread: "t2" });
    await app!.close();
    const sealed = (await stateFiles()).find((file) => file.path.includes("threads"))!;
    await build({}, false);
    await expect(app!.ask("keeper", "again", { thread: "t2" })).rejects.toThrow(/is sealed, and no cipher was given/);
    expect((await readFile(sealed.path)).toString("latin1")).toBe(sealed.text);
  });

  it("does not open a conversation sealed under another key", async () => {
    await build({ threads: cipher() });
    await app!.ask("keeper", SECRET, { thread: "t1" });
    await app!.close();
    await build({ threads: cipher() }, false);
    await expect(app!.ask("keeper", "again", { thread: "t1" })).rejects.toThrow();
  });

  it("keeps conversations in a backend of the app's own", async () => {
    const held = new Map<string, Thread>();
    const backend: Conversations = {
      load: async (id) => held.get(id),
      append: async (id, name, said) => {
        const thread = held.get(id) ?? { id, agent: name, turns: [], startedAt: 1, updatedAt: 1 };
        thread.turns.push(...said.map((message) => ({ ...message, at: 1 })));
        held.set(id, thread);
      },
      list: async () => [...held.values()].map((t) => ({ id: t.id, agent: t.agent, turns: t.turns.length, startedAt: 1, updatedAt: 1, opened: "" })),
      forget: async (id) => held.delete(id),
    };
    const model = await build({ threads: backend });

    await app!.ask("keeper", SECRET, { thread: "t1" });
    await app!.ask("keeper", "and again", { thread: "t1" });

    expect(held.get("t1")!.turns).toHaveLength(4);
    expect(model.requests[1]!.messages[0]!.content).toBe(SECRET);
    expect((await stateFiles()).some((file) => file.path.includes("threads"))).toBe(false);
    expect(await app!.threads.forget("t1")).toBe(true);
  });

  it("keeps what an agent remembers in a backend of the app's own", async () => {
    const episodes: Episode[] = [];
    const backend: Recollection = {
      recall: async () => episodes.slice(-1),
      record: async (_agent, episode) => void episodes.push({ ...episode, id: `e${episodes.length}`, at: 1 }),
      all: async () => episodes,
      redact: async () => false,
    };
    const model = await build({ memory: backend });

    await app!.ask("keeper", SECRET);
    await app!.ask("keeper", "what did I tell you?");

    expect(episodes.map((episode) => episode.input)).toEqual([SECRET, "what did I tell you?"]);
    expect(model.requests[1]!.system).toContain(SECRET);
    expect(await app!.recorded("keeper")).toBe(episodes);
    for (const file of await stateFiles()) expect(file.text).not.toContain(SECRET);
  });

  it("forgets a sealed conversation without needing to open it", async () => {
    await build({ threads: cipher() });
    await app!.ask("keeper", SECRET, { thread: "t1" });
    const file = (await stateFiles()).find((entry) => entry.path.includes("threads"))!;
    await writeFile(file.path, "praecise-sealed-state:v1\nnot what was sealed");
    expect(await app!.threads.forget("t1")).toBe(true);
    expect(await app!.threads.forget("t1")).toBe(false);
  });
});
