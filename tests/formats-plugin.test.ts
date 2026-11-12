/**
 * The binary format readers are a plugin: in the package, and not loaded until asked for.
 *
 * Listed in an app's config they register through the same seam any reader does, so a
 * recording sent with a question is shown to the model as a rendering, by what its bytes
 * are as much as by what it was called.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { agent } from "../src/define.js";
import { describeAttachment, formatNames, formats, registerFormats } from "../src/formats/index.js";
import { Table, rootOf } from "../src/formats/flatbuffers.js";
import { structOf } from "../src/formats/thrift.js";
import { Cursor } from "../src/formats/bytes.js";
import { lz4Block, lz4Frame as unLz4Frame, lzf, unpack, unpacks, whyNot } from "../src/formats/unpack.js";
import { membersOf } from "../src/formats/zip.js";
import { knownReaders, present, takesOf } from "../src/harness/modality.js";
import { createApp } from "../src/sdk.js";
import { attachment, Bytes, float32s, lz4Frame, lz4Literals, mcapFile, npyFile, thriftStruct, zip } from "./formats-helpers.js";
import { MODEL_ENV, stubModel } from "./helpers.js";

const MODELS = { house: { url: "https://models.test", credential: "HOUSE_KEY", speaks: "messages", fast: "small" } };

const LOG = mcapFile({
  schemas: [{ id: 1, name: "Pose", encoding: "jsonschema", data: "{}" }],
  channels: [{ id: 1, schema: 1, topic: "/pose", encoding: "json" }],
  chunks: [[{ channel: 1, time: 1_700_000_000_000_000_000n, data: '{"x":1}' }]],
});

const shown = (...attachments: Parameters<typeof present>[0] & object) => present(attachments, takesOf("messages"), 4000);

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "praecise-formats-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// The tests in this block run in order: what is registered is process-wide.
describe("the formats plugin", () => {
  it("is not loaded by default: a recording is left out, with a note", () => {
    expect(knownReaders()).not.toContain("an MCAP recording");
    const out = shown(attachment(LOG, "application/mcap", "run.mcap"));
    expect(out.text).toBe("");
    expect(out.notes[0]).toContain("nothing reads that media type");
  });

  it("registers only the formats asked for", () => {
    registerFormats({ only: ["npy"] });
    expect(knownReaders()).toContain("a NumPy array");
    expect(knownReaders()).not.toContain("an MCAP recording");
    expect(shown(attachment(npyFile("<f4", [2], float32s([1, 2])), "application/x-npy")).text).toContain("A NumPy array");
    expect(shown(attachment(LOG, "application/mcap")).text).toBe("");
  });

  it("listed in an app's config, sets every reader up before the app is planned", async () => {
    const model = stubModel([{ text: "ok" }]);
    await createApp({ root, config: { models: MODELS, plugins: [formats()] }, agents: { a: agent({ role: "Help." }) } }, { env: MODEL_ENV, fetch: model.fetch });
    for (const name of ["an MCAP recording", "a ROS bag", "a ROS 2 bag", "LeRobot dataset metadata", "a Parquet table", "an Arrow table", "a point cloud", "a PLY model", "Gaussian splats", "a USD scene", "a NumPy array"]) {
      expect(knownReaders()).toContain(name);
    }
    const out = shown(attachment(LOG, "application/mcap", "run.mcap"));
    expect(out.text).toContain('[Attached "run.mcap" (application/mcap), shown as an MCAP recording]');
    expect(out.text).toContain("1 message(s) on 1 channel(s)");
    expect(out.notes).toEqual([]);
  });

  it("registers nothing twice, however many apps load it", async () => {
    const before = knownReaders().length;
    registerFormats();
    await formats().setup?.();
    expect(knownReaders()).toHaveLength(before);
  });

  it("knows a file by its bytes when the media type says nothing", () => {
    for (const mime of ["application/octet-stream", "binary/octet-stream", ""]) {
      expect(shown(attachment(LOG, mime)).text).toContain("shown as an MCAP recording");
    }
    expect(shown(attachment(LOG, "application/octet-stream; charset=binary")).text).toContain("shown as an MCAP recording");
  });

  it("says a file is not what it was called, and leaves bytes it does not know to a note", () => {
    const wrong = shown(attachment("this is not a recording", "application/mcap", "run.mcap"));
    expect(wrong.text).toBe("");
    expect(wrong.notes.join("\n")).toContain('"run.mcap" (application/mcap) could not be read as an MCAP recording: its bytes do not begin the way that format does');

    const unknown = shown(attachment(Buffer.from([1, 2, 3, 4, 0, 0, 0, 9]), "application/octet-stream"));
    expect(unknown.text).toBe("");
    expect(unknown.notes).toHaveLength(1);
    expect(unknown.notes[0]).toContain("nothing reads that media type");
  });

  it("reports a damaged file as a note naming the format, not as a crash", () => {
    const cut = Buffer.concat([Buffer.from("PAR1"), Buffer.alloc(20), new Bytes().u32(5000).done(), Buffer.from("PAR1")]);
    const out = shown(attachment(cut, "application/vnd.apache.parquet", "frames.parquet"));
    expect(out.notes.join("\n")).toContain("could not be read as a Parquet table: its footer is longer than the file");
  });

  it("does not take a file that is only an address", () => {
    const out = shown({ mime: "application/mcap", url: "https://example.com/run.mcap" });
    expect(out.text).toBe("");
    expect(out.notes[0]).toContain("it is an address");
  });

  it("leaves text and JSON it does not recognise to the readers that already had them", () => {
    expect(shown(attachment("just some notes", "text/plain")).text).toContain("shown as text]\njust some notes");
    const senml = shown(attachment(JSON.stringify([{ n: "temp", v: 20, t: 0 }, { n: "temp", v: 21, t: 1 }]), "application/senml+json"));
    expect(senml.text).toContain("shown as sensor measurements");
  });

  it("trims a rendering to the room it is given, like any other", () => {
    const out = present([attachment(LOG, "application/mcap")], takesOf("messages"), 40);
    expect(out.text.length).toBeLessThan(600);
    expect(out.text).toContain("An MCAP recording");
  });

  it("names every format it can be told to leave out", () => {
    expect(formatNames.sort()).toEqual(["arrow", "lerobot", "mcap", "npy", "parquet", "pointcloud", "rosbag", "splat", "usd"]);
    expect(formats({ except: ["usd"] }).name).toBe("formats");
  });
});

describe("renders without registering", () => {
  it("describeAttachment gives the rendering directly, for a tool that wants it", () => {
    expect(describeAttachment(attachment(LOG, "application/octet-stream"))).toContain("An MCAP recording");
    expect(describeAttachment(attachment("hello", "text/plain"))).toBeUndefined();
    expect(describeAttachment({ mime: "application/mcap", url: "https://example.com/a.mcap" })).toBeUndefined();
  });
});

describe("the decompressors written out here", () => {
  it("LZ4 blocks repeat from behind the write point, including over themselves", () => {
    // Four literals, then eight bytes from four back; then five literals to finish.
    const block = Buffer.concat([Buffer.from([0x44]), Buffer.from("abcd"), Buffer.from([4, 0]), Buffer.from([0x50]), Buffer.from("vwxyz")]);
    expect(Buffer.from(lz4Block(block)).toString()).toBe("abcdabcdabcdvwxyz");
    // One literal, then a run of 300 of it: a match length that needs extension bytes.
    const run = Buffer.concat([Buffer.from([0x1f]), Buffer.from("z"), Buffer.from([1, 0]), Buffer.from([255, 26]), Buffer.from([0x10]), Buffer.from("!")]);
    expect(Buffer.from(lz4Block(run)).toString()).toBe(`${"z".repeat(301)}!`);
  });

  it("LZ4 frames hold compressed and stored blocks, and a reference may reach into an earlier block", () => {
    const first = lz4Literals(Buffer.from("hello "));
    // No literals, then six bytes from six back: "hello " again, out of the block before.
    const second = Buffer.from([0x02, 6, 0]);
    expect(Buffer.from(unLz4Frame(lz4Frame([first, second]))).toString()).toBe("hello hello ");
    expect(Buffer.from(unLz4Frame(lz4Frame([Buffer.from("stored as it is")], { stored: true }))).toString()).toBe("stored as it is");
    const long = Buffer.alloc(70_000, 0x61);
    expect(Buffer.from(unLz4Frame(lz4Frame([lz4Literals(long)]))).equals(long)).toBe(true);
  });

  it("refuses LZ4 that points before its start or stops mid-sequence", () => {
    expect(() => lz4Block(Buffer.from([0x04, 9, 0]))).toThrow("points before the start");
    expect(() => lz4Block(Buffer.from([0x40, 0x61]))).toThrow("ends inside its literals");
    expect(() => unLz4Frame(Buffer.from("not a frame at all"))).toThrow("not an LZ4 frame");
  });

  it("LZF literals and back-references", () => {
    // Three literals "abc", then a reference of length 4 from three back.
    expect(Buffer.from(lzf(Buffer.from([2, 0x61, 0x62, 0x63, (2 << 5) | 0, 2]), 16)).toString()).toBe("abcabca");
    // A long reference: length 7 + 3 + 2 from one back.
    expect(Buffer.from(lzf(Buffer.from([0, 0x7a, (7 << 5) | 0, 3, 0]), 16)).toString()).toBe("z".repeat(13));
  });

  it("names what it cannot undo, and why", () => {
    expect(unpacks("lz4")).toBe(true);
    expect(unpacks("")).toBe(true);
    expect(unpacks("bz2")).toBe(false);
    expect(whyNot("bz2")).toBe("bzip2 is not in Node");
    expect(() => unpack("bz2", Buffer.alloc(4))).toThrow("bzip2 is not in Node");
    expect(Buffer.from(unpack("none", Buffer.from("as is"))).toString()).toBe("as is");
    expect(() => unpack("lz4", Buffer.alloc(8), 1024 * 1024 * 1024)).toThrow("more than is unpacked for a sample");
  });
});

describe("the parsers under the formats", () => {
  it("a cursor refuses to read past the end, and says where", () => {
    const cursor = new Cursor(Buffer.from([1, 2, 3]));
    expect(cursor.u16()).toBe(0x0201);
    expect(() => cursor.u32()).toThrow("it is cut short: 4 byte(s) were expected at offset 2, and it ends at 3");
    expect(() => new Cursor(Buffer.alloc(8)).take(-1)).toThrow("cut short");
  });

  it("Thrift's compact protocol: short and long field headers, negative numbers, nesting, booleans", () => {
    const struct = structOf(
      new Cursor(
        thriftStruct({
          1: { i: -7 },
          2: { s: "name" },
          3: { bool: true },
          4: { bool: false },
          40: { i: 1234567890123 },
          41: { list: [{ struct: { 1: { i: 1 } } }, { struct: { 1: { i: 2 } } }] },
          42: { list: Array.from({ length: 20 }, (_, index) => ({ i: index })) },
          43: { list: [{ bool: true }, { bool: false }] },
        }),
      ),
    );
    expect(struct.get(1)).toBe(-7);
    expect(Buffer.from(struct.get(2) as Uint8Array).toString()).toBe("name");
    expect(struct.get(3)).toBe(true);
    expect(struct.get(4)).toBe(false);
    expect(struct.get(40)).toBe(1234567890123);
    expect((struct.get(41) as Map<number, unknown>[]).map((each) => each.get(1))).toEqual([1, 2]);
    expect(struct.get(42)).toHaveLength(20);
    expect(struct.get(43)).toEqual([true, false]);
  });

  it("Thrift that never ends, or nests without end, is an error", () => {
    expect(() => structOf(new Cursor(Buffer.from([0x15, 0x02])))).toThrow("cut short");
    expect(() => structOf(new Cursor(Buffer.alloc(200, 0x1c)))).toThrow("nest deeper");
    expect(() => structOf(new Cursor(Buffer.from([0x1e, 0x00])))).toThrow("does not define");
  });

  it("FlatBuffers offsets that leave the buffer are an error, not a read of something else", () => {
    expect(() => rootOf(Buffer.from([0xff, 0xff, 0xff, 0x7f, 0, 0, 0, 0]))).toThrow("outside its buffer");
    expect(() => rootOf(Buffer.alloc(2))).toThrow("cut short");
    const view = new DataView(new ArrayBuffer(16));
    view.setInt32(8, -4000, true);
    expect(() => new Table(new Uint8Array(view.buffer), view, 8).i32(0)).toThrow("outside its buffer");
  });

  it("a zip directory is read from the end, stored or deflated, and a missing one is said", () => {
    const archive = zip([{ name: "a.txt", data: Buffer.from("alpha") }, { name: "dir/b.bin", data: Buffer.alloc(500, 3), deflate: true }]);
    const members = membersOf(archive);
    expect(members.map((member) => [member.name, member.size, member.method])).toEqual([["a.txt", 5, 0], ["dir/b.bin", 500, 8]]);
    expect(members[1]!.packed).toBeLessThan(500);
    expect(() => membersOf(archive.subarray(0, archive.length - 30))).toThrow("no zip directory");
  });
});
