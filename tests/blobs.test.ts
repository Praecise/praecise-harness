/**
 * Bytes kept under the hash of what they are, and carried by address.
 *
 * The store on disk is the one that ships as the default, and it is the one tested
 * here, in a temporary folder. Object storage is a `BlobStore` a plugin supplies; the
 * in-memory one stands in for "somewhere that is not the default" below.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  addressOf,
  blobsIn,
  detach,
  diskBlobs,
  inline,
  isBlobAddress,
  memoryBlobs,
  sweepBlobs,
  type BlobStore,
} from "../src/blobs.js";
import { agent, store } from "../src/define.js";
import { createApp } from "../src/sdk.js";
import { openStore } from "../src/stores/index.js";
import { MODEL_ENV, stubModel } from "./helpers.js";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (data: Uint8Array | undefined): string => new TextDecoder().decode(data);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "praecise-blobs-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const each = (): [string, () => BlobStore][] => [
  ["on disk", () => diskBlobs(join(dir, "blobs"))],
  ["in memory", () => memoryBlobs()],
];

describe.each(each())("a blob store %s", (_where, make) => {
  it("keeps bytes under the sha-256 of them, and gives them back", async () => {
    const blobs = make();
    const address = await blobs.put(bytes("a frame of video"));
    expect(address).toBe(`sha256:${createHash("sha256").update("a frame of video").digest("hex")}`);
    expect(address).toBe(addressOf(bytes("a frame of video")));
    expect(text(await blobs.get(address))).toBe("a frame of video");
    expect(await blobs.stat(address)).toMatchObject({ address, size: 16 });
  });

  it("keeps the same bytes once however often they are kept", async () => {
    const blobs = make();
    const first = await blobs.put(bytes("same"));
    const second = await blobs.put(bytes("same"));
    expect(second).toBe(first);
    const listed = [];
    for await (const info of blobs.list()) listed.push(info.address);
    expect(listed).toEqual([first]);
  });

  it("answers with nothing for bytes it does not hold, and removes what it is told to", async () => {
    const blobs = make();
    const missing = addressOf(bytes("never kept"));
    expect(await blobs.get(missing)).toBeUndefined();
    expect(await blobs.stat(missing)).toBeUndefined();
    expect(await blobs.delete(missing)).toBe(false);

    const address = await blobs.put(bytes("to go"));
    expect(await blobs.delete(address)).toBe(true);
    expect(await blobs.get(address)).toBeUndefined();
  });

  it("refuses an address that is not one", async () => {
    await expect(make().get("../../etc/passwd")).rejects.toThrow(/not a blob address/);
  });
});

describe("the store on disk", () => {
  it("says so when a file is no longer what its address says", async () => {
    const blobs = diskBlobs(join(dir, "blobs"));
    const address = await blobs.put(bytes("as written"));
    const digest = address.slice("sha256:".length);
    const file = join(dir, "blobs", digest.slice(0, 2), digest.slice(2));
    expect(text(await readFile(file))).toBe("as written");

    await writeFile(file, "as tampered with");
    await expect(blobs.get(address)).rejects.toThrow(/no longer what its address says/);
  });

  it("leaves no half-written file where a reader could find one", async () => {
    const blobs = diskBlobs(join(dir, "blobs"));
    const address = await blobs.put(bytes("whole"));
    const folder = join(dir, "blobs", address.slice(7, 9));
    expect(await readdir(folder)).toEqual([address.slice(9)]);
  });
});

describe("an attachment carried by address", () => {
  const frame = { mime: "image/png", name: "frame.png", data: Buffer.from("not really a png").toString("base64") };

  it("gives up its bytes for an address, and takes them back", async () => {
    const blobs = memoryBlobs();
    const carried = await detach(blobs, frame);
    expect(carried.data).toBeUndefined();
    expect(isBlobAddress(carried.blob)).toBe(true);
    expect(carried).toMatchObject({ mime: "image/png", name: "frame.png" });

    const whole = await inline(blobs, carried);
    expect(whole.data).toBe(frame.data);
    expect(whole.blob).toBe(carried.blob);
  });

  it("leaves small things inline, and leaves a url or an address as it is", async () => {
    const blobs = memoryBlobs();
    expect(await detach(blobs, frame, { over: 1_000 })).toBe(frame);
    const linked = { mime: "image/png", url: "https://example.test/frame.png" };
    expect(await detach(blobs, linked)).toBe(linked);
    expect(await inline(blobs, linked)).toBe(linked);
  });

  it("says which bytes are missing rather than sending an attachment without them", async () => {
    const gone = { mime: "image/png", blob: addressOf(bytes("swept")) };
    await expect(inline(memoryBlobs(), gone)).rejects.toThrow(/not in the blob store/);
  });

  it("reaches the model as its bytes, and is said to be missing when they are", async () => {
    const blobs = memoryBlobs();
    const carried = await detach(blobs, frame);
    const model = stubModel([{ text: "A frame." }, { text: "Nothing to see." }]);
    const app = await createApp(
      {
        root: dir,
        config: { models: { house: { url: "https://models.test", credential: "HOUSE_KEY", speaks: "messages", fast: "small" } } },
        agents: { a: agent({ role: "Help.", quality: "fast" }) },
      },
      { env: MODEL_ENV, fetch: model.fetch, blobs },
    );
    expect(app.blobs).toBe(blobs);

    await app.ask("a", "what is this?", { attachments: [carried] });
    const sent = JSON.stringify(model.calls[0]?.body.messages);
    expect(sent).toContain(frame.data);

    const missing = await app.ask("a", "and this?", { attachments: [{ mime: "image/png", name: "lost.png", blob: addressOf(bytes("lost")) }] });
    expect(JSON.stringify(model.calls[1]?.body.messages)).not.toContain("lost.png");
    expect((missing.notes ?? []).join("\n")).toMatch(/"lost\.png" \(image\/png\) was not sent: its bytes are not in the blob store/);
  });

  it("keeps blobs in a folder under the app's state when nothing else is supplied", async () => {
    const model = stubModel([]);
    const app = await createApp(
      {
        root: dir,
        config: { models: { house: { url: "https://models.test", credential: "HOUSE_KEY", speaks: "messages", fast: "small" } } },
        agents: { a: agent({ role: "Help.", quality: "fast" }) },
      },
      { env: MODEL_ENV, fetch: model.fetch },
    );
    const address = await app.blobs.put(bytes("kept by the app"));
    const digest = address.slice(7);
    expect(text(await readFile(join(dir, ".praecise", "blobs", digest.slice(0, 2), digest.slice(2))))).toBe("kept by the app");
  });
});

describe("sweeping", () => {
  it("finds every address in a value, wherever it is", () => {
    const one = addressOf(bytes("one"));
    const two = addressOf(bytes("two"));
    const three = addressOf(bytes("three"));
    const found = blobsIn({
      scan: one,
      pages: [{ image: two }, "plain text"],
      note: `see ${three} for the original`,
      count: 3,
      nothing: null,
    });
    expect([...found].sort()).toEqual([one, two, three].sort());
  });

  it("removes what nothing names, keeps what a row names, and never runs by itself", async () => {
    const blobs = diskBlobs(join(dir, "blobs"));
    const wanted = await blobs.put(bytes("the scan a row refers to"));
    const orphan = await blobs.put(bytes("nothing refers to this"));

    const rows = await openStore("docs", store({ of: "document", url: "memory:" }), { stateDir: dir });
    await rows.remember({ text: "an invoice", meta: { scan: wanted, pages: 2 } });

    // Nothing has been swept: both are still there until an app asks.
    expect(await blobs.stat(orphan)).toBeDefined();

    const live = blobsIn((await rows.history()).map((row) => row.meta));
    const swept = await sweepBlobs(blobs, live, { olderThan: 0, now: Date.now() + 1_000 });
    expect(swept).toMatchObject({ removed: [orphan], kept: 1 });
    expect(swept.freed).toBe(22);
    expect(await blobs.get(orphan)).toBeUndefined();
    expect(text(await blobs.get(wanted))).toBe("the scan a row refers to");
    await rows.close();
  });

  it("leaves what was only just kept, since the row that names it may not be written yet", async () => {
    const blobs = memoryBlobs();
    const fresh = await blobs.put(bytes("written a moment ago"));
    const swept = await sweepBlobs(blobs, []);
    expect(swept).toMatchObject({ removed: [], kept: 1, freed: 0 });
    expect(await blobs.stat(fresh)).toBeDefined();
  });

  it("can say what would go without removing it", async () => {
    const blobs = memoryBlobs();
    const orphan = await blobs.put(bytes("unreferenced"));
    const swept = await sweepBlobs(blobs, [], { olderThan: 0, now: Date.now() + 1_000, dryRun: true });
    expect(swept.removed).toEqual([orphan]);
    expect(await blobs.stat(orphan)).toBeDefined();
  });
});
