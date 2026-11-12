/**
 * LeRobot datasets, format v3.0: how robot-learning demonstrations are published.
 *
 * A dataset is a folder, not a file, so what arrives as an attachment is one of its
 * parts, and each part is recognised for what it is:
 *
 *   meta/info.json                         the schema: features, shapes, frame rate, totals, path templates
 *   meta/stats.json                        per-feature min, max, mean and deviation, for normalisation
 *   meta/tasks.parquet                     task descriptions and their indices
 *   meta/episodes/chunk-000/file-000.parquet   one row per episode: its length and where its frames are
 *   data/chunk-000/file-000.parquet        the frames, many episodes to a file
 *   videos/<camera>/chunk-000/file-000.mp4 the camera streams
 *
 * The two JSON files are read in full here. The Parquet parts are read by the Parquet
 * reader, which is told by `lerobotTable` which part of a dataset a table's columns make
 * it. The videos are an endpoint's to read, or nobody's.
 *
 * The older v2.x layout kept its metadata as JSON Lines (`episodes.jsonl`,
 * `tasks.jsonl`, `episodes_stats.jsonl`); those are read too, since a dataset that has
 * not been converted still has them.
 *
 * Layout from the LeRobotDataset v3.0 documentation and `lerobot/datasets/utils.py`
 * (huggingface/lerobot), and checked against `lerobot/pusht` on the Hub, on 2026-11-13.
 */

import { short } from "../harness/modality.js";
import type { Format } from "./bytes.js";
import { clip, count, some, span, utf8 } from "./bytes.js";

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

const LISTED = 60;

/** The names of a feature's dimensions, which the format writes as a list or as lists under a heading. */
function namesOf(names: unknown): string[] {
  if (Array.isArray(names)) return names.flatMap((name) => (typeof name === "string" ? [name] : namesOf(name)));
  if (isObject(names)) return Object.values(names).flatMap(namesOf);
  return [];
}

function featureOf(name: string, feature: Json): string {
  const shape = Array.isArray(feature.shape) ? `[${feature.shape.join(", ")}]` : "";
  const names = namesOf(feature.names);
  const video = isObject(feature.video_info) ? feature.video_info : isObject(feature.info) ? feature.info : undefined;
  const codec = video
    ? [video["video.codec"], video["video.pix_fmt"], typeof video["video.fps"] === "number" ? `${video["video.fps"]} fps` : undefined, video["video.is_depth_map"] === true ? "depth" : undefined]
        .filter((part) => typeof part === "string")
        .join(", ")
    : "";
  return (
    `  ${name}: ${String(feature.dtype ?? "unknown type")}${shape ? ` ${shape}` : ""}` +
    (names.length ? ` (${clip(names.join(", "), 200)})` : "") +
    (codec ? `; ${codec}` : "")
  );
}

function readInfo(info: Json): string {
  const features = isObject(info.features) ? info.features : {};
  const version = String(info.codebase_version);
  const frames = typeof info.total_frames === "number" ? info.total_frames : undefined;
  const fps = typeof info.fps === "number" ? info.fps : undefined;
  const lines = [
    `A LeRobot dataset's meta/info.json, format ${version}` +
      (info.robot_type ? `, robot type "${String(info.robot_type)}"` : "") +
      ": " +
      [
        typeof info.total_episodes === "number" ? `${count(info.total_episodes)} episode(s)` : "",
        frames !== undefined ? `${count(frames)} frame(s)` : "",
        typeof info.total_tasks === "number" ? `${count(info.total_tasks)} task(s)` : "",
        typeof info.total_videos === "number" ? `${count(info.total_videos)} video(s)` : "",
        fps !== undefined ? `${fps} frames per second` : "",
      ]
        .filter(Boolean)
        .join(", ") +
      (frames !== undefined && fps ? ` (about ${span(frames / fps)} of data)` : "") +
      ".",
  ];
  if (isObject(info.splits)) {
    lines.push(`Splits (episode ranges): ${Object.entries(info.splits).map(([name, value]) => `${name} ${String(value)}`).join(", ")}.`);
  }
  const files = [
    typeof info.data_path === "string" ? `frames in ${info.data_path}` : "",
    typeof info.video_path === "string" ? `video in ${info.video_path}` : "",
    typeof info.chunks_size === "number" ? `${count(info.chunks_size)} files to a chunk folder` : "",
    typeof info.data_files_size_in_mb === "number" ? `frame files up to ${info.data_files_size_in_mb} MB` : "",
    typeof info.video_files_size_in_mb === "number" ? `video files up to ${info.video_files_size_in_mb} MB` : "",
  ].filter(Boolean);
  if (files.length) lines.push(`Files: ${files.join("; ")}.`);

  const entries = Object.entries(features).filter((entry): entry is [string, Json] => isObject(entry[1]));
  const { shown, rest } = some(entries, LISTED, "more feature(s)");
  lines.push(`Features (${entries.length}):`);
  for (const [name, feature] of shown) lines.push(featureOf(name, feature));
  if (rest) lines.push(`  ${rest}`);

  const cameras = entries.filter(([, feature]) => feature.dtype === "video" || feature.dtype === "image").map(([name]) => name);
  if (cameras.length) lines.push(`Cameras: ${cameras.join(", ")}.`);
  if (!version.startsWith("v3")) {
    lines.push(`This is the ${version} layout, not v3.0: there, each episode is its own Parquet and video file and the episode and task lists are JSON Lines files in meta/.`);
  }
  lines.push(
    "This file is the dataset's schema only. Its statistics are in meta/stats.json, its tasks in meta/tasks.parquet, its episodes in " +
      "meta/episodes/, and the frames and video in the files named above; none of those were read from here.",
  );
  return lines.join("\n");
}

const STATS = ["min", "max", "mean", "std", "count", "q01", "q10", "q50", "q90", "q99"];

const isStats = (value: unknown): value is Json =>
  isObject(value) && Object.keys(value).length > 0 && Object.keys(value).every((key) => STATS.includes(key)) && ("mean" in value || "min" in value);

const flat = (value: unknown): number[] =>
  Array.isArray(value) ? (value as unknown[]).flat(Infinity).map((each) => (typeof each === "boolean" ? Number(each) : each)).filter((each): each is number => typeof each === "number") : typeof value === "number" ? [value] : [];

/** How many dimensions of one feature are written out before the rest are counted. */
const DIMENSIONS = 16;

function statsLine(name: string, stats: Json): string {
  const total = flat(stats.count)[0];
  const parts = STATS.filter((key) => key !== "count" && key in stats).map((key) => {
    const values = flat(stats[key]);
    return `${key} ${values.slice(0, DIMENSIONS).map(short).join(", ")}${values.length > DIMENSIONS ? `, … (${values.length} dimensions)` : ""}`;
  });
  return `  ${name}${total !== undefined ? ` (${count(total)} values)` : ""}: ${parts.join("; ")}`;
}

function readStats(stats: Json): string {
  const entries = Object.entries(stats) as [string, Json][];
  const { shown, rest } = some(entries, LISTED, "more feature(s)");
  return [
    `Statistics in the form of a LeRobot dataset's meta/stats.json: ${entries.length} feature(s), one value per dimension.`,
    ...shown.map(([name, each]) => statsLine(name, each)),
    ...(rest ? [`  ${rest}`] : []),
  ].join("\n");
}

/** The v2.x metadata files: one JSON object to a line. */
function readLines(rows: Json[]): string | undefined {
  const head = rows[0]!;
  if ("task_index" in head && typeof head.task === "string") {
    const { shown, rest } = some(rows, 40, "more task(s)");
    return [
      `A LeRobot dataset's task list (the v2.x meta/tasks.jsonl): ${count(rows.length)} task(s).`,
      ...shown.map((row) => `  ${String(row.task_index)}: ${clip(String(row.task), 200)}`),
      ...(rest ? [`  ${rest}`] : []),
    ].join("\n");
  }
  if ("episode_index" in head && isObject(head.stats)) {
    const first = Object.entries(head.stats).filter((entry): entry is [string, Json] => isStats(entry[1]));
    const { shown, rest } = some(first, 20, "more feature(s)");
    return [
      `A LeRobot dataset's per-episode statistics (the v2.x meta/episodes_stats.jsonl): ${count(rows.length)} episode(s), ${first.length} feature(s) each.`,
      `Episode ${String(head.episode_index)}:`,
      ...shown.map(([name, each]) => statsLine(name, each)),
      ...(rest ? [`  ${rest}`] : []),
      "The other episodes have the same shape and are not shown.",
    ].join("\n");
  }
  if ("episode_index" in head && typeof head.length === "number") {
    const lengths = rows.map((row) => row.length).filter((each): each is number => typeof each === "number");
    const tasks = new Map<string, number>();
    for (const row of rows) {
      for (const task of Array.isArray(row.tasks) ? row.tasks : []) tasks.set(String(task), (tasks.get(String(task)) ?? 0) + 1);
    }
    const { shown, rest } = some([...tasks].sort((a, b) => b[1] - a[1]), 20, "more task(s)");
    return [
      `A LeRobot dataset's episode list (the v2.x meta/episodes.jsonl): ${count(rows.length)} episode(s), ${count(lengths.reduce((a, b) => a + b, 0))} frame(s) in all; ` +
        `the shortest ${count(Math.min(...lengths))} frames, the longest ${count(Math.max(...lengths))}.`,
      ...(shown.length ? ["Tasks, by how many episodes do them:", ...shown.map(([task, episodes]) => `  ${count(episodes)}: ${clip(task, 200)}`)] : []),
      ...(rest ? [`  ${rest}`] : []),
    ].join("\n");
  }
  return undefined;
}

function parse(bytes: Uint8Array): { info?: Json; stats?: Json; rows?: Json[] } {
  // Every one of these files opens with a brace; anything else is not looked at further.
  let at = 0;
  while (at < bytes.length && (bytes[at] === 0x20 || bytes[at] === 0x0a || bytes[at] === 0x0d || bytes[at] === 0x09)) at++;
  if (bytes[at] !== 0x7b) return {};
  const text = utf8(bytes);
  try {
    const whole: unknown = JSON.parse(text);
    if (!isObject(whole)) return {};
    if (typeof whole.codebase_version === "string" && isObject(whole.features)) return { info: whole };
    const values = Object.values(whole);
    if (values.length && values.every(isStats)) return { stats: whole };
    // One line of JSON Lines is also one JSON document.
    return { rows: [whole] };
  } catch {
    try {
      const rows = text
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as unknown);
      return rows.length && rows.every(isObject) ? { rows } : {};
    } catch {
      return {};
    }
  }
}

/** Parsed once per file: a format is asked whether a file is its own, and then to read it. */
const PARSED = new WeakMap<Uint8Array, ReturnType<typeof parse>>();

function parsed(bytes: Uint8Array): ReturnType<typeof parse> {
  let found = PARSED.get(bytes);
  if (!found) {
    found = parse(bytes);
    PARSED.set(bytes, found);
  }
  return found;
}

function read(bytes: Uint8Array): string | undefined {
  const { info, stats, rows } = parsed(bytes);
  if (info) return readInfo(info);
  if (stats) return readStats(stats);
  return rows ? readLines(rows) : undefined;
}

/**
 * Which part of a LeRobot dataset a table is, going by its columns.
 *
 * The Parquet reader calls this with a file's column names, so a table of frames or of
 * episodes is introduced as what it is and not as an anonymous table.
 */
export function lerobotTable(columns: readonly string[]): string | undefined {
  const has = (name: string): boolean => columns.includes(name);
  if (has("episode_index") && has("dataset_from_index") && has("dataset_to_index")) {
    const cameras = columns.map((name) => /^videos\/(.+)\/from_timestamp$/.exec(name)?.[1]).filter(Boolean);
    const stats = columns.filter((name) => name.startsWith("stats/")).length;
    return (
      "These are the columns of a LeRobot v3 dataset's episode table (meta/episodes/): one row per episode, with its length, its tasks, " +
      "the rows of the frame files it occupies (dataset_from_index to dataset_to_index)" +
      (cameras.length ? `, where it sits in each camera's video (${cameras.join(", ")})` : "") +
      (stats ? `, and ${count(stats)} per-episode statistics columns` : "") +
      "."
    );
  }
  if (has("episode_index") && has("frame_index") && has("timestamp") && (has("index") || has("task_index"))) {
    return "These are the columns of a LeRobot dataset's frame table (data/): one row per frame, many episodes to a file, told apart by episode_index.";
  }
  if (has("task_index") && columns.length <= 3) {
    return "These are the columns of a LeRobot v3 dataset's task table (meta/tasks.parquet): one row per task description.";
  }
  return undefined;
}

export const lerobot: Format = {
  name: "LeRobot dataset metadata",
  mimes: ["application/vnd.lerobot+json"],
  extensions: [],
  loose: ["application/json", "text/json", "application/jsonl", "application/x-ndjson", "application/x-jsonlines", "application/jsonlines", "text/plain"],
  sniff: (bytes) => {
    const { info, stats, rows } = parsed(bytes);
    return Boolean(info || stats || (rows && readLines(rows)));
  },
  read,
};
