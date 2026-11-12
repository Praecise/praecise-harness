/**
 * Tables and arrays are shown to a model as their shape, not their cells.
 *
 * Parquet from its footer, Arrow from its schema and batch headers, a LeRobot dataset
 * from its metadata files, a NumPy array from its header and a bounded sample. Where
 * values were not decoded, the rendering says so.
 */
import { describe, expect, it } from "vitest";

import { describeAttachment } from "../src/formats/index.js";
import {
  arrowField,
  arrowFile,
  arrowSchema,
  arrowStream,
  attachment,
  Bytes,
  float32s,
  float64s,
  npyFile,
  parquetFile,
  type Thrift,
  zip,
} from "./formats-helpers.js";

const i64 = (value: number): Buffer => new Bytes().u64(value).done();
const f32 = (value: number): Buffer => new Bytes().f32(value).done();

/** A column chunk: its path, type, codec, value count, and the statistics a writer may keep. */
const column = (path: string[], type: number, codec: number, values: number, stats?: { min: Uint8Array; max: Uint8Array; nulls: number }): Thrift => ({
  struct: {
    2: { i: 4 },
    3: {
      struct: {
        1: { i: type },
        2: { list: [{ i: 0 }] },
        3: { list: path.map((part) => ({ s: part })) },
        4: { i: codec },
        5: { i: values },
        6: { i: values * 8 },
        7: { i: values * 4 },
        9: { i: 4 },
        12: stats ? { struct: { 3: { i: stats.nulls }, 5: { b: stats.max }, 6: { b: stats.min } } } : undefined,
      },
    },
  },
});

/** A table of frames: an index, a list of floats, a string, in two row groups. */
const frames = (options: { stats?: boolean; secondGroupStats?: boolean } = {}): Buffer => {
  const group = (rows: number, from: number, stats: boolean): Thrift => ({
    struct: {
      1: {
        list: [
          column(["episode_index"], 2, 1, rows, stats ? { min: i64(from), max: i64(from + rows - 1), nulls: 0 } : undefined),
          column(["observation.state", "list", "element"], 4, 1, rows * 2, stats ? { min: f32(-1.5 - from), max: f32(2.25 + from), nulls: 0 } : undefined),
          column(["label"], 6, 6, rows, stats ? { min: Buffer.from("apple"), max: Buffer.from("pear"), nulls: 3 } : undefined),
        ],
      },
      2: { i: rows * 100 },
      3: { i: rows },
    },
  });
  return parquetFile({
    1: { i: 2 },
    2: {
      list: [
        { struct: { 4: { s: "schema" }, 5: { i: 3 } } },
        { struct: { 1: { i: 2 }, 3: { i: 1 }, 4: { s: "episode_index" } } },
        { struct: { 3: { i: 1 }, 4: { s: "observation.state" }, 5: { i: 1 }, 6: { i: 3 }, 10: { struct: { 3: { struct: {} } } } } },
        { struct: { 3: { i: 2 }, 4: { s: "list" }, 5: { i: 1 } } },
        { struct: { 1: { i: 4 }, 3: { i: 1 }, 4: { s: "element" } } },
        { struct: { 1: { i: 6 }, 3: { i: 1 }, 4: { s: "label" }, 6: { i: 0 }, 10: { struct: { 1: { struct: {} } } } } },
      ],
    },
    3: { i: 300 },
    4: { list: [group(100, 0, options.stats !== false), group(200, 100, options.stats !== false && options.secondGroupStats !== false)] },
    5: { list: [{ struct: { 1: { s: "huggingface" }, 2: { s: '{"info":{"features":{"label":{"dtype":"string"}}}}' } } }] },
    6: { s: "parquet-cpp-arrow version 21.0.0" },
  });
};

const read = (bytes: Uint8Array, name?: string, mime = "application/octet-stream"): string => describeAttachment(attachment(bytes, mime, name)) ?? "";

describe("a Parquet table", () => {
  it("is described from its footer: rows, columns with their types, row groups and compression", () => {
    const shown = read(frames());
    expect(shown).toContain("A Parquet table: 300 row(s), 3 column(s), 2 row group(s)");
    expect(shown).toContain("written by parquet-cpp-arrow version 21.0.0 (format version 2)");
    expect(shown).toContain("compressed with SNAPPY, ZSTD");
    expect(shown).toContain("Rows per group: 100 to 200.");
    expect(shown).toContain("  episode_index [INT64, optional]");
    expect(shown).toContain("  observation.state.list.element [FLOAT, repeated]: 600 values");
    expect(shown).toContain("  label [BYTE_ARRAY as STRING, optional]");
  });

  it("gives each column's range across every row group, and its nulls", () => {
    const shown = read(frames());
    expect(shown).toContain("episode_index [INT64, optional]: 0 null, min 0, max 299");
    expect(shown).toContain("observation.state.list.element [FLOAT, repeated]: 600 values, 0 null, min -101.5, max 102.25");
    expect(shown).toContain('label [BYTE_ARRAY as STRING, optional]: 6 null, min "apple", max "pear"');
  });

  it("gives no range for a column when any row group did not record one", () => {
    const shown = read(frames({ secondGroupStats: false }));
    expect(shown).toContain("  episode_index [INT64, optional]: 0 null\n");
    expect(shown).not.toContain("min 0, max 99");
    expect(read(frames({ stats: false }))).toContain("  episode_index [INT64, optional]\n");
  });

  it("shows the metadata a dataset library left, and says the rows were not read", () => {
    const shown = read(frames());
    expect(shown).toContain("File metadata keys: huggingface.");
    expect(shown).toContain('huggingface: {"info":{"features":{"label":{"dtype":"string"}}}}');
    expect(shown).toContain("Not read: the rows.");
  });

  it("names logical types with their parameters", () => {
    const shown = read(
      parquetFile({
        1: { i: 2 },
        2: {
          list: [
            { struct: { 4: { s: "schema" }, 5: { i: 4 } } },
            { struct: { 1: { i: 2 }, 3: { i: 0 }, 4: { s: "at" }, 10: { struct: { 8: { struct: { 1: { bool: true }, 2: { struct: { 2: { struct: {} } } } } } } } } },
            { struct: { 1: { i: 1 }, 3: { i: 0 }, 4: { s: "level" }, 10: { struct: { 10: { struct: { 1: { i: 8 }, 2: { bool: false } } } } } } },
            { struct: { 1: { i: 7 }, 2: { i: 16 }, 3: { i: 1 }, 4: { s: "price" }, 10: { struct: { 5: { struct: { 1: { i: 2 }, 2: { i: 10 } } } } } } },
            { struct: { 1: { i: 6 }, 3: { i: 1 }, 4: { s: "old" }, 6: { i: 19 } } },
          ],
        },
        3: { i: 0 },
        4: { list: [] },
      }),
    );
    expect(shown).toContain("at [INT64 as TIMESTAMP(us, UTC), required]");
    expect(shown).toContain("level [INT32 as UINT8, required]");
    expect(shown).toContain("price [FIXED_LEN_BYTE_ARRAY as DECIMAL(10, 2), optional]");
    expect(shown).toContain("old [BYTE_ARRAY as JSON, optional]");
    expect(shown).toContain("0 row(s), 4 column(s), 0 row group(s)");
  });

  it("says which part of a LeRobot dataset a table is, from its columns", () => {
    const table = (names: string[]): Buffer =>
      parquetFile({
        1: { i: 2 },
        2: { list: [{ struct: { 4: { s: "schema" }, 5: { i: names.length } } }, ...names.map((name): Thrift => ({ struct: { 1: { i: 2 }, 3: { i: 1 }, 4: { s: name } } }))] },
        3: { i: 10 },
        4: { list: [] },
      });
    expect(read(table(["episode_index", "frame_index", "timestamp", "index", "task_index"]))).toContain("the columns of a LeRobot dataset's frame table (data/)");
    const episodes = read(table(["episode_index", "length", "dataset_from_index", "dataset_to_index", "videos/observation.images.top/from_timestamp", "stats/action/mean"]));
    expect(episodes).toContain("a LeRobot v3 dataset's episode table (meta/episodes/)");
    expect(episodes).toContain("where it sits in each camera's video (observation.images.top)");
    expect(read(table(["task_index", "task"]))).toContain("a LeRobot v3 dataset's task table (meta/tasks.parquet)");
    expect(read(table(["id", "value"]))).not.toContain("LeRobot");
  });

  it("says an encrypted footer cannot be read, and reports a truncated file as an error", () => {
    const sealed = Buffer.concat([Buffer.from("PARE"), Buffer.alloc(40), Buffer.from("PARE")]);
    expect(read(sealed)).toContain("Not read: its schema and row counts are in the footer, which cannot be read without the key.");
    const whole = frames();
    const cut = Buffer.concat([Buffer.from("PAR1"), whole.subarray(whole.length - 60)]);
    expect(() => read(cut)).toThrow("its footer is longer than the file");
    expect(() => read(whole.subarray(0, whole.length - 20))).toThrow("it begins as a Parquet file and does not end as one: it is cut short");
  });
});

const schema = arrowSchema(
  [
    arrowField("episode_index", 2, [{ i32: 64 }, { bool: true }], { nullable: false }),
    arrowField("observation.state", 12, [], { children: [arrowField("item", 3, [{ i16: 1 }])] }),
    arrowField("when", 10, [{ i16: 2 }, { str: "UTC" }]),
    arrowField("task", 5, [], { dictionary: true }),
    arrowField("pose", 13, [], { children: [arrowField("x", 3, [{ i16: 2 }]), arrowField("valid", 6, [])] }),
    arrowField("image", 16, [{ i32: 3 }], { children: [arrowField("item", 2, [{ i32: 8 }])] }),
  ],
  { huggingface: '{"info":{"features":{}}}' },
);

describe("an Arrow table", () => {
  it("is described from a file's footer: every column's type, and rows summed over its batches", () => {
    const shown = read(arrowFile(schema, [1000, 1000, 500]));
    expect(shown).toContain("An Arrow table (IPC file): 2,500 row(s), 6 column(s), 3 record batch(es)");
    expect(shown).toContain("  episode_index: int64, not null");
    expect(shown).toContain("  observation.state: list<float32>");
    expect(shown).toContain("  when: timestamp[us, UTC]");
    expect(shown).toContain("  task: string, dictionary-encoded");
    expect(shown).toContain("  pose: struct<x: float64, valid: bool>");
    expect(shown).toContain("  image: fixed_size_list<uint8>[3]");
    expect(shown).toContain("Schema metadata keys: huggingface.");
    expect(shown).toContain("Not read: the column values (only the schema and the batch headers are decoded).");
  });

  it("is counted by walking it when it is a stream", () => {
    const shown = read(arrowStream(schema, [10, 20, 30, 40]));
    expect(shown).toContain("An Arrow table (IPC stream): 100 row(s), 6 column(s), 4 record batch(es)");
    expect(shown).not.toContain("cut short");
  });

  it("reads a file that was never closed as the stream inside it, and says so", () => {
    const shown = read(arrowFile(schema, [7, 8], { closed: false }));
    expect(shown).toContain("15 row(s), 6 column(s), 2 record batch(es)");
    expect(shown).toContain("the file has no footer, so it was not closed");
  });

  it("says when a stream stops mid-message", () => {
    const whole = arrowStream(schema, [10, 20]);
    const shown = read(whole.subarray(0, whole.length - 30));
    expect(shown).toContain("10 row(s)");
    expect(shown).toContain("its last message is cut short, so the stream was not finished");
  });

  it("names the compression of column buffers", () => {
    expect(read(arrowFile(schema, [5], { compressed: "zstd" }))).toContain("Column buffers are compressed with zstd.");
    expect(read(arrowFile(schema, [5], { compressed: "lz4" }))).toContain("Column buffers are compressed with lz4.");
  });

  it("tells a Feather V1 file from Arrow, and does not pretend to read it", () => {
    const shown = read(Buffer.concat([Buffer.from("FEA1"), Buffer.alloc(64)]), "old.feather");
    expect(shown).toContain("A Feather version 1 file");
    expect(shown).toContain("Not read: Feather V1 is an older format");
  });

  it("fails as an error, not a hang or a wrong answer, on a schema that points outside itself", () => {
    const whole = arrowStream(schema, [1]);
    const damaged = Buffer.from(whole);
    // The root offset of the first message's header.
    damaged.writeUInt32LE(0x7fffffff, 8);
    expect(describeAttachment(attachment(damaged, "application/octet-stream"))).toBeUndefined();
    expect(() => describeAttachment(attachment(damaged, "application/vnd.apache.arrow.stream"))).toThrow();
  });
});

const INFO = {
  codebase_version: "v3.0",
  robot_type: "so100",
  total_episodes: 206,
  total_frames: 25650,
  total_tasks: 1,
  chunks_size: 1000,
  fps: 10,
  splits: { train: "0:206" },
  data_path: "data/chunk-{chunk_index:03d}/file-{file_index:03d}.parquet",
  video_path: "videos/{video_key}/chunk-{chunk_index:03d}/file-{file_index:03d}.mp4",
  features: {
    "observation.image": {
      dtype: "video",
      shape: [96, 96, 3],
      names: ["height", "width", "channel"],
      video_info: { "video.fps": 10.0, "video.codec": "av1", "video.pix_fmt": "yuv420p", "video.is_depth_map": false, has_audio: false },
    },
    "observation.state": { dtype: "float32", shape: [2], names: { motors: ["motor_0", "motor_1"] }, fps: 10.0 },
    action: { dtype: "float32", shape: [2], names: { motors: ["motor_0", "motor_1"] }, fps: 10.0 },
    episode_index: { dtype: "int64", shape: [1], names: null, fps: 10.0 },
  },
  data_files_size_in_mb: 100,
  video_files_size_in_mb: 500,
};

const json = (value: unknown, name?: string): string => describeAttachment(attachment(JSON.stringify(value, null, 2), "application/json", name)) ?? "";

describe("a LeRobot dataset", () => {
  it("is described from meta/info.json: totals, frame rate, features with shapes and names, cameras, and where the rest is", () => {
    const shown = json(INFO, "info.json");
    expect(shown).toContain(`A LeRobot dataset's meta/info.json, format v3.0, robot type "so100": 206 episode(s), 25,650 frame(s), 1 task(s), 10 frames per second (about 42.8 min of data).`);
    expect(shown).toContain("Splits (episode ranges): train 0:206.");
    expect(shown).toContain("frames in data/chunk-{chunk_index:03d}/file-{file_index:03d}.parquet");
    expect(shown).toContain("  observation.image: video [96, 96, 3] (height, width, channel); av1, yuv420p, 10 fps");
    expect(shown).toContain("  observation.state: float32 [2] (motor_0, motor_1)");
    expect(shown).toContain("Cameras: observation.image.");
    expect(shown).toContain("none of those were read from here");
  });

  it("says so when the layout is the older one", () => {
    const shown = json({ ...INFO, codebase_version: "v2.1" });
    expect(shown).toContain("format v2.1");
    expect(shown).toContain("This is the v2.1 layout, not v3.0");
  });

  it("reads meta/stats.json one feature at a time, a value per dimension", () => {
    const shown = json({
      "observation.state": { min: [13.4, 32.9], max: [496.1, 510.9], mean: [229.1, 293.3], std: [101.8, 96.4], count: [25650] },
      "observation.image": { min: [[[0.0]], [[0.0]], [[0.0]]], max: [[[1.0]], [[1.0]], [[1.0]]], mean: [[[0.9]], [[0.8]], [[0.7]]], std: [[[0.1]], [[0.2]], [[0.3]]], count: [1000] },
      "next.success": { min: [false], max: [true], mean: [0.1], std: [0.3], count: [25650] },
    });
    expect(shown).toContain("Statistics in the form of a LeRobot dataset's meta/stats.json: 3 feature(s), one value per dimension.");
    expect(shown).toContain("  observation.state (25,650 values): min 13.4, 32.9; max 496.1, 510.9; mean 229.1, 293.3; std 101.8, 96.4");
    expect(shown).toContain("  observation.image (1,000 values): min 0, 0, 0; max 1, 1, 1; mean 0.9, 0.8, 0.7");
    expect(shown).toContain("  next.success (25,650 values): min 0; max 1");
  });

  it("reads the older JSON Lines metadata: episodes, tasks and per-episode statistics", () => {
    const lines = (rows: unknown[]): string => describeAttachment(attachment(rows.map((row) => JSON.stringify(row)).join("\n"), "application/jsonl")) ?? "";
    const episodes = lines([
      { episode_index: 0, tasks: ["pick the cube"], length: 120 },
      { episode_index: 1, tasks: ["pick the cube"], length: 80 },
      { episode_index: 2, tasks: ["stack"], length: 200 },
    ]);
    expect(episodes).toContain("3 episode(s), 400 frame(s) in all; the shortest 80 frames, the longest 200.");
    expect(episodes).toContain("  2: pick the cube");
    expect(lines([{ task_index: 0, task: "pick the cube" }, { task_index: 1, task: "stack" }])).toContain("2 task(s).\n  0: pick the cube\n  1: stack");
    const stats = lines([{ episode_index: 4, stats: { action: { min: [0], max: [1], mean: [0.5], std: [0.1], count: [120] } } }]);
    expect(stats).toContain("per-episode statistics");
    expect(stats).toContain("Episode 4:\n  action (120 values): min 0; max 1; mean 0.5; std 0.1");
  });

  it("leaves JSON that is none of those to whoever else reads JSON", () => {
    expect(describeAttachment(attachment('{"hello":"world"}', "application/json"))).toBeUndefined();
    expect(describeAttachment(attachment("[1,2,3]", "application/json"))).toBeUndefined();
    expect(describeAttachment(attachment('{"a":{"min":[0]},"b":7}', "application/json"))).toBeUndefined();
    expect(describeAttachment(attachment("{ not json", "application/json"))).toBeUndefined();
  });
});

describe("a NumPy array", () => {
  it("is read as vectors over time when it is rows of a few columns: each column on its own, and a few rows", () => {
    const rows = 500;
    const values = Array.from({ length: rows }, (_, row) => [row, -row / 2, 1]).flat();
    const shown = read(npyFile("<f4", [rows, 3], float32s(values)), "state.npy");
    expect(shown).toContain("A NumPy array (.npy, format 1.0): shape (500, 3), float32, little-endian (<f4), stored row-first (C order); 1,500 value(s) in 6 kB.");
    expect(shown).toContain("Each column over all 500 rows:");
    expect(shown).toContain("[0]: min 0, max 499, mean 249.5");
    expect(shown).toContain("[1]: min -249.5, max 0, mean -124.75");
    expect(shown).toContain("first 0, last 499");
    expect(shown).toContain("    499: 499, -249.5, 1");
    expect(shown).toContain("6 evenly spaced rows");
    expect(shown).toContain("Not read: values are summarised and sampled, not listed.");
    // Six rows are written out, not five hundred.
    expect(shown.split("\n").length).toBeLessThan(20);
  });

  it("reads a column-first array by its columns, not by the order it is stored in", () => {
    // [[0, 1, 2], [3, 4, 5]] stored as 0, 3, 1, 4, 2, 5.
    const shown = read(npyFile("<f8", [2, 3], float64s([0, 3, 1, 4, 2, 5]), { fortran: true }));
    expect(shown).toContain("stored column-first (Fortran order)");
    expect(shown).toContain("    0: 0, 1, 2");
    expect(shown).toContain("    1: 3, 4, 5");
    expect(shown).toContain("[2]: min 2, max 5");
  });

  it("reads either byte order, integers, booleans and half floats", () => {
    expect(read(npyFile(">i2", [3], Buffer.from([0x01, 0x00, 0xff, 0xff, 0x00, 0x02])))).toContain("All, in stored order: 256, -1, 2");
    expect(read(npyFile("|b1", [3], Buffer.from([1, 0, 1])))).toContain("bool (|b1); 3 value(s) in 3 B.\n  Over all of them: min 0, max 1");
    // 0x3c00 is 1, 0xc000 is -2, 0x3555 is about a third.
    expect(read(npyFile("<f2", [3], Buffer.from([0x00, 0x3c, 0x00, 0xc0, 0x55, 0x35])))).toContain("All, in stored order: 1, -2, 0.33325");
    expect(read(npyFile("<u8", [1], new Bytes().u64(12345678901).done()))).toContain("uint64, little-endian (<u8)");
  });

  it("samples a long array and shows its head, never the whole", () => {
    const shown = read(npyFile("<f4", [250_000], float32s(Array.from({ length: 250_000 }, (_, index) => index))));
    expect(shown).toContain("250,000 value(s) in 1 MB");
    expect(shown).toContain("Over 100,000 evenly spaced of them: min 0, max 249999");
    expect(shown).toContain("First 24, in stored order: 0, 1, 2");
    expect(shown.length).toBeLessThan(600);
  });

  it("summarises more than two dimensions together, and says so", () => {
    const shown = read(npyFile("<f4", [2, 2, 2], float32s([1, 2, 3, 4, 5, 6, 7, 8])));
    expect(shown).toContain("shape (2, 2, 2)");
    expect(shown).toContain("more than two dimensions");
  });

  it("describes strings, objects and structured records from the header only, and says the values were not read", () => {
    const strings = read(npyFile("<U3", [2], Buffer.alloc(24)));
    expect(strings).toContain("strings of 3 characters (<U3)");
    expect(strings).toContain("Not read: the values.");
    expect(read(npyFile("|O", [4], Buffer.alloc(10)))).toContain("Python objects (pickled)");
    const records = read(npyFile("[('x', '<f4'), ('id', '<i8')]", [3], Buffer.alloc(36)));
    expect(records).toContain("shape (3), structured records");
    expect(records).toContain("Fields: [('x', '<f4'), ('id', '<i8')]");
    expect(records).toContain("Not read: the values. Structured records are not numbers this reads");
  });

  it("says when the file holds fewer values than its header promises", () => {
    const shown = read(npyFile("<f8", [100], float64s([1, 2, 3])));
    expect(shown).toContain("The file holds 3 of the 100 values its header promises: it is cut short.");
  });

  it("reads each array of an .npz archive, stored or deflated", () => {
    const state = npyFile("<f8", [4, 2], float64s([1, 2, 3, 4, 5, 6, 7, 8]));
    const ids = npyFile("<i8", [3], Buffer.from(new BigInt64Array([7n, 8n, 9n]).buffer));
    for (const deflate of [false, true]) {
      const shown = read(zip([{ name: "state.npy", data: state, deflate }, { name: "ids.npy", data: ids, deflate }]), "episode.npz");
      expect(shown).toContain("A NumPy archive (.npz): 2 array(s)");
      expect(shown).toContain("state: shape (4, 2), float64");
      expect(shown).toContain("    3: 7, 8");
      expect(shown).toContain("ids: shape (3), int64");
      expect(shown).toContain("All, in stored order: 7, 8, 9");
    }
    const archive = zip([{ name: "state.npy", data: state }]);
    expect(() => read(archive.subarray(0, archive.length - 30), "episode.npz")).toThrow("it has no zip directory: the archive is cut short");
  });
});
