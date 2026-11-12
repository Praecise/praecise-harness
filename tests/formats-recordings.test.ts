/**
 * Robot logs are shown to a model as what they hold, not as bytes.
 *
 * MCAP and ROS 1 bags: the topics, their types and message counts, the time the
 * recording spans, and a first few messages where they can be read. Whatever was not
 * read is said in the rendering.
 */
import * as zlib from "node:zlib";

import { describe, expect, it } from "vitest";

import { describeAttachment } from "../src/formats/index.js";
import { attachment, bagFile, Bytes, lz4Frame, lz4Literals, mcapFile, type McapInput } from "./formats-helpers.js";

const T0 = 1_700_000_000_000_000_000n;
const MS = 1_000_000n;

/** Two channels: an IMU in CDR at 100 Hz for two seconds, and a pose in JSON at 10 Hz. */
function recording(extra: Partial<McapInput> = {}): McapInput {
  const messages = Array.from({ length: 200 }, (_, index) => ({ channel: 1, time: T0 + BigInt(index) * 10n * MS, data: Buffer.alloc(48, index) as Uint8Array | string }));
  for (let index = 0; index < 20; index++) messages.push({ channel: 2, time: T0 + BigInt(index) * 100n * MS, data: JSON.stringify({ x: index, y: index / 2 }) });
  messages.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  return {
    profile: "ros2",
    schemas: [
      { id: 1, name: "sensor_msgs/msg/Imu", encoding: "ros2msg", data: "std_msgs/Header header\n# orientation\nfloat64 x\nfloat64 y\n================\nMSG: std_msgs/Header\nuint32 seq" },
      { id: 2, name: "Pose", encoding: "jsonschema", data: '{"type":"object"}' },
      { id: 3, name: "Scan", encoding: "protobuf", data: "\u0001\u0002binary descriptor" },
    ],
    channels: [
      { id: 1, schema: 1, topic: "/imu", encoding: "cdr" },
      { id: 2, schema: 2, topic: "/pose", encoding: "json" },
      { id: 3, schema: 3, topic: "/scan", encoding: "protobuf" },
    ],
    chunks: [messages.slice(0, 110), messages.slice(110)],
    ...extra,
  };
}

const read = (bytes: Uint8Array, name = "run.mcap"): string => describeAttachment(attachment(bytes, "application/octet-stream", name)) ?? "";

describe("an MCAP recording", () => {
  it("is described from its summary: channels, types, counts, rates and the time it spans", () => {
    const shown = read(
      mcapFile(recording({ attachments: [{ name: "calib.yaml", media: "application/yaml", data: "fx: 1" }], metadata: [{ name: "robot", pairs: { serial: "A1", site: "lab" } }] })),
    );
    expect(shown).toContain('An MCAP recording (profile "ros2", written by formats-helpers): 220 message(s) on 3 channel(s), 2 chunk(s), 1 attachment(s), 1 metadata record(s)');
    expect(shown).toContain("Time: 2023-11-14T22:13:20.000Z to 2023-11-14T22:13:21.990Z (1.99 s).");
    expect(shown).toContain("/imu [sensor_msgs/msg/Imu, cdr]: 200 message(s), about 100 per second");
    expect(shown).toContain("/pose [Pose, json]: 20 message(s)");
    expect(shown).toContain("/scan [Scan, protobuf]: 0 messages");
    expect(shown).toContain("Chunks: 2 uncompressed");
    expect(shown).toContain("Attachments: calib.yaml (application/yaml, 5 B).");
    expect(shown).toContain("robot: serial=A1, site=lab");
  });

  it("shows a schema a person wrote, without its comments or the types nested after it", () => {
    const shown = read(mcapFile(recording()));
    expect(shown).toContain("sensor_msgs/msg/Imu (ros2msg): std_msgs/Header header; float64 x; float64 y");
    expect(shown).not.toContain("uint32 seq");
    expect(shown).toContain("1 schema(s) in protobuf encoding are named but their definitions are not shown");
  });

  it("samples the first messages of each channel: JSON as text, binary as a size, and says which", () => {
    const shown = read(mcapFile(recording()));
    expect(shown).toContain("First message(s) of each channel, from the first chunk:");
    expect(shown).toContain('at 2023-11-14T22:13:20.000Z: {"x":0,"y":0}');
    expect(shown).toContain("at 2023-11-14T22:13:20.010Z: 48 bytes");
    expect(shown).toContain("message bodies in cdr encoding are binary and were not decoded");
    // Three of each channel, never the two hundred.
    expect(shown.match(/: 48 bytes/g)).toHaveLength(3);
  });

  it("opens chunks compressed with LZ4", () => {
    const shown = read(mcapFile(recording({ compression: { name: "lz4", pack: (data) => lz4Frame([lz4Literals(data)]) } })));
    expect(shown).toContain("Chunks: 2 compressed with lz4");
    expect(shown).toContain('{"x":0,"y":0}');
    expect(shown).not.toContain("were not opened");
  });

  it("opens zstd chunks where this Node can, and otherwise describes everything outside them and says why", () => {
    const zstd = (zlib as unknown as { zstdCompressSync?: (data: Uint8Array) => Buffer }).zstdCompressSync;
    const shown = read(mcapFile(recording({ compression: { name: "zstd", pack: (data) => (zstd ? zstd(data) : Buffer.from("not really zstd")) } })));
    // Either way the summary gives the whole picture.
    expect(shown).toContain("220 message(s) on 3 channel(s)");
    expect(shown).toContain("/imu [sensor_msgs/msg/Imu, cdr]: 200 message(s)");
    expect(shown).toContain("Chunks: 2 compressed with zstd");
    if (zstd) {
      expect(shown).toContain('{"x":0,"y":0}');
    } else {
      expect(shown).toContain("chunks compressed with zstd were not opened (zstd needs Node 22.15 or later");
      expect(shown).toContain("no message was sampled, because the first chunk could not be opened");
      expect(shown).not.toContain("First message(s)");
    }
  });

  it("counts by reading the data when a file has no summary", () => {
    const shown = read(mcapFile(recording({ summary: false })));
    expect(shown).toContain("220 message(s) on 3 channel(s), 2 chunk(s)");
    expect(shown).toContain("no statistics record, so messages were counted by reading the data section");
    expect(shown).toContain("/imu [sensor_msgs/msg/Imu, cdr]: 200 message(s), about 100 per second");
    expect(shown).toContain("Time: 2023-11-14T22:13:20.000Z to 2023-11-14T22:13:21.990Z");
  });

  it("says so when the summary has no per-channel counts, and does not invent them", () => {
    const shown = read(mcapFile(recording({ channelCounts: false })));
    expect(shown).toContain("220 message(s)");
    expect(shown).toContain("the file does not say how many messages each channel has");
    expect(shown).not.toContain("200 message(s)");
  });

  it("reads a recording that was never closed, and one cut off mid-record, saying which", () => {
    const open = mcapFile(recording({ finished: false }));
    const shown = read(open);
    expect(shown).toContain("The file has no footer: it was not closed");
    expect(shown).toContain("220 message(s) on 3 channel(s), 2 chunk(s)");

    const cut = read(open.subarray(0, open.length - 40));
    expect(cut).toContain("The file has no footer");
    expect(cut).toContain("runs past the end of the file, so the recording was cut off there");
    // The first chunk is whole, so its messages are still counted.
    expect(cut).toContain("110 message(s)");
  });

  it("counts only what it could open when an unsummarised file has chunks it cannot", () => {
    const shown = read(mcapFile(recording({ summary: false, compression: { name: "snappy", pack: (data) => data } })));
    expect(shown).toContain("0 message(s) on 0 channel(s), 2 chunk(s)");
    expect(shown).toContain('chunks compressed with snappy were not opened ("snappy" is not a compression this reads)');
  });

  it("takes a time that is not a date as seconds from wherever the recorder counted", () => {
    const input = recording();
    input.chunks = [[{ channel: 2, time: 5n * 1_000_000_000n, data: "{}" }, { channel: 2, time: 65n * 1_000_000_000n, data: "{}" }]];
    expect(read(mcapFile(input))).toContain("Time: 5s to 65s (60 s).");
  });
});

const bag = (extra: Partial<Parameters<typeof bagFile>[0]> = {}): Buffer => {
  const messages = Array.from({ length: 120 }, (_, index) => ({ conn: index % 3 === 0 ? 1 : 0, seconds: 1_700_000_000 + Math.floor(index / 2), data: Buffer.alloc(12, 1) }));
  return bagFile({
    connections: [
      { id: 0, topic: "/chatter", type: "std_msgs/String", definition: "string data\n", caller: "/talker" },
      {
        id: 1,
        topic: "/odom",
        type: "nav_msgs/Odometry",
        definition: "Header header\nstring child_frame_id # the frame\n\n================================================================================\nMSG: std_msgs/Header\nuint32 seq\n",
      },
    ],
    chunks: [messages.slice(0, 60), messages.slice(60)],
    ...extra,
  });
};

const readBag = (bytes: Uint8Array): string => describeAttachment(attachment(bytes, "application/x-rosbag")) ?? "";

describe("a ROS 1 bag", () => {
  it("is described from its index: topics, types, counts, rates and the time it spans", () => {
    const shown = readBag(bag());
    expect(shown).toContain("A ROS 1 bag (format 2.0): 120 message(s) on 2 connection(s) in 2 chunk(s)");
    expect(shown).toContain("Time: 2023-11-14T22:13:20.000Z to 2023-11-14T22:14:19.000Z (59 s).");
    expect(shown).toContain("/chatter [std_msgs/String]: 80 message(s), about 1.34 per second, from /talker");
    expect(shown).toContain("/odom [nav_msgs/Odometry]: 40 message(s)");
    expect(shown).toContain("Chunks: 2 uncompressed");
  });

  it("shows each message type's own fields, and says the bodies were not decoded", () => {
    const shown = readBag(bag());
    expect(shown).toContain("nav_msgs/Odometry: Header header; string child_frame_id");
    expect(shown).not.toContain("uint32 seq");
    expect(shown).toContain("Not read: message bodies are in ROS serialization and were not decoded.");
  });

  it("needs no chunk opened: a bz2 bag is described in full from its index", () => {
    const shown = readBag(bag({ compression: { name: "bz2", pack: () => Buffer.from("BZh9 not really") } }));
    expect(shown).toContain("120 message(s) on 2 connection(s) in 2 chunk(s)");
    expect(shown).toContain("Chunks: 2 compressed with bz2");
    expect(shown).toContain("/chatter [std_msgs/String]: 80 message(s)");
    expect(shown).not.toContain("were not opened");
  });

  it("walks a bag that was not closed, counting from the index records after each chunk", () => {
    const shown = readBag(bag({ indexed: false }));
    expect(shown).toContain("The bag has no index: it was not closed (it would need `rosbag reindex`)");
    expect(shown).toContain("120 message(s) on 2 connection(s) in 2 chunk(s)");
    expect(shown).toContain("/odom [nav_msgs/Odometry]: 40 message(s)");
    expect(shown).toContain("Time: 2023-11-14T22:13:20.000Z to 2023-11-14T22:14:19.000Z");
  });

  it("opens LZ4 chunks of an unclosed bag to find its topics", () => {
    const shown = readBag(bag({ indexed: false, compression: { name: "lz4", pack: (data) => lz4Frame([lz4Literals(data)]) } }));
    expect(shown).toContain("/chatter [std_msgs/String]: 80 message(s)");
    expect(shown).toContain("Chunks: 2 compressed with lz4");
  });

  it("still counts an unclosed bz2 bag, and says its topics are inside chunks it cannot open", () => {
    const shown = readBag(bag({ indexed: false, compression: { name: "bz2", pack: () => Buffer.from("BZh9 not really") } }));
    expect(shown).toContain("120 message(s)");
    expect(shown).toContain("chunks compressed with bz2 were not opened (bzip2 is not in Node), so connections first named inside them are missing");
    expect(shown).toContain("120 message(s) are on 2 connection(s) whose topic could not be read");
    expect(shown).not.toContain("/chatter");
  });

  it("reads what is there of a bag cut off mid-record", () => {
    const whole = bag({ indexed: false });
    const shown = readBag(whole.subarray(0, whole.length - 30));
    expect(shown).toContain("runs past the end of the file, so the recording was cut off there");
    expect(shown).toContain("/chatter [std_msgs/String]");
  });

  it("recognises a ROS 2 bag in SQLite form and says plainly that it is not read", () => {
    const page = Buffer.alloc(4096);
    page.write("SQLite format 3\u0000", 0, "latin1");
    page.writeUInt16BE(4096, 16);
    page.writeUInt32BE(7, 28);
    page.write("CREATE TABLE topics(id INTEGER PRIMARY KEY,name TEXT NOT NULL)CREATE TABLE messages(id INTEGER PRIMARY KEY)", 200, "latin1");
    const shown = describeAttachment(attachment(page, "application/octet-stream", "run_0.db3")) ?? "";
    expect(shown).toContain("A SQLite database of 7 page(s) of 4,096 bytes");
    expect(shown).toContain("the `topics` and `messages` tables that a ROS 2 bag in SQLite form");
    expect(shown).toContain("Not read: SQLite pages are not decoded here");
    expect(shown).toContain("ROS 2 bags recorded as MCAP are read");
    // A SQLite file nobody called a bag is not claimed.
    expect(describeAttachment(attachment(page, "application/octet-stream", "notes.sqlite"))).toBeUndefined();
  });

  it("is not fooled by a record whose lengths lie", () => {
    const bytes = new Bytes().raw("#ROSBAG V2.0\n").u32(0xfffffff0).raw(Buffer.alloc(64)).done();
    expect(() => readBag(bytes)).toThrow("no bag header record");
  });
});
