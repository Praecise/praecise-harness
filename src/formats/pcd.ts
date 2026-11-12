/**
 * PCD: the Point Cloud Library's file, and what most lidar and depth pipelines save.
 *
 * A text header names the fields of a point, their sizes and types, and how many points
 * there are; then the points, in one of three forms. `ascii` is a line of numbers per
 * point. `binary` is the points one after another as the header describes them.
 * `binary_compressed` is LZF-compressed and laid out a field at a time (every x, then
 * every y, ...), which is what makes it compress.
 *
 * All three are read. The header is reported in full; positions and the other fields are
 * summarised over a sample, never listed.
 *
 * Layout from the PCL documentation ("The PCD file format"), read on 2026-11-13.
 */

import type { Format } from "./bytes.js";
import { count, latin1, size, viewOf } from "./bytes.js";
import type { Field, Scalar } from "./points.js";
import { describePoints, SAMPLED, scalarAt } from "./points.js";
import { lzf } from "./unpack.js";

/** How far in the header may run. A real one is a few hundred bytes. */
const HEADER = 64 * 1024;
/** How much of an ascii body is turned into text to find its first points. */
const ASCII = 16 * 1024 * 1024;

interface Header {
  version: string;
  fields: { name: string; type: Scalar | undefined; said: string; size: number; count: number }[];
  width: number;
  height: number;
  viewpoint: string;
  points: number;
  data: string;
  /** Where the points start. */
  start: number;
}

function headerOf(bytes: Uint8Array): Header | undefined {
  const head = latin1(bytes.subarray(0, Math.min(bytes.length, HEADER)));
  const found: Record<string, string[]> = {};
  let at = 0;
  let start = -1;
  while (at < head.length) {
    let end = head.indexOf("\n", at);
    if (end < 0) end = head.length;
    const line = head.slice(at, end).trim();
    at = end + 1;
    if (!line || line.startsWith("#")) continue;
    const [key, ...values] = line.split(/\s+/);
    // The header is these words and nothing else; anything else means this is not a PCD file.
    if (!/^(VERSION|FIELDS|COLUMNS|SIZE|TYPE|COUNT|WIDTH|HEIGHT|VIEWPOINT|POINTS|DATA)$/.test(key!)) return undefined;
    found[key!] = values;
    if (key === "DATA") {
      start = at;
      break;
    }
  }
  const names = found.FIELDS ?? found.COLUMNS;
  if (start < 0 || !names || !found.SIZE || !found.TYPE) return undefined;
  const fields = names.map((name, index) => {
    const bytesEach = Number(found.SIZE![index]);
    const letter = (found.TYPE![index] ?? "").toUpperCase();
    const type = ({ I1: "i8", I2: "i16", I4: "i32", I8: "i64", U1: "u8", U2: "u16", U4: "u32", U8: "u64", F4: "f32", F8: "f64" } as Record<string, Scalar>)[`${letter}${bytesEach}`];
    const said = `${{ I: "int", U: "uint", F: "float" }[letter] ?? letter}${bytesEach * 8}`;
    return { name, type, said, size: bytesEach, count: Number(found.COUNT?.[index] ?? 1) };
  });
  const width = Number(found.WIDTH?.[0] ?? 0);
  const height = Number(found.HEIGHT?.[0] ?? 1);
  return {
    version: found.VERSION?.[0] ?? "",
    fields,
    width,
    height,
    viewpoint: (found.VIEWPOINT ?? []).join(" "),
    points: Number(found.POINTS?.[0] ?? width * height),
    data: (found.DATA?.[0] ?? "").toLowerCase(),
    start,
  };
}

function read(bytes: Uint8Array): string {
  const header = headerOf(bytes);
  if (!header) throw new Error("its header is not a PCD header");
  const body = bytes.subarray(header.start);
  const stride = header.fields.reduce((total, field) => total + field.size * field.count, 0);
  const lines = [
    `A PCD point cloud${header.version ? ` (version ${header.version})` : ""}: ${count(header.points)} point(s), ` +
      (header.height > 1 ? `organised as ${count(header.width)} x ${count(header.height)} (an image-shaped cloud, as a depth camera gives)` : "unorganised") +
      `, stored as ${header.data}; ${size(bytes.length)}.`,
    `Fields: ${header.fields.map((field) => `${field.name} (${field.said}${field.count > 1 ? ` x ${field.count}` : ""})`).join(", ")}; ${stride} bytes a point.`,
  ];
  if (header.viewpoint && header.viewpoint !== "0 0 0 1 0 0 0") lines.push(`Viewpoint (translation, then quaternion): ${header.viewpoint}.`);

  const unread: string[] = [];
  // A field is a quantity if it is one number that is not padding or a packed colour.
  const plain = (field: Header["fields"][number]): boolean => field.count === 1 && field.type !== undefined && field.name !== "_";
  const packed = (name: string): boolean => name === "rgb" || name === "rgba";
  let fields: Field[] = [];
  let reach = header.points;

  if (header.data === "binary") {
    const view = viewOf(body);
    reach = Math.min(header.points, Math.floor(body.length / Math.max(1, stride)));
    let offset = 0;
    for (const field of header.fields) {
      const from = offset;
      offset += field.size * field.count;
      if (plain(field)) fields.push({ name: field.name, opaque: packed(field.name), at: (index) => scalarAt(view, field.type!, index * stride + from, true) });
    }
  } else if (header.data === "binary_compressed") {
    try {
      const head = viewOf(body);
      const compressed = head.getUint32(0, true);
      const whole = lzf(body.subarray(8, 8 + compressed), head.getUint32(4, true));
      const view = viewOf(whole);
      reach = Math.min(header.points, Math.floor(whole.length / Math.max(1, stride)));
      let offset = 0;
      for (const field of header.fields) {
        const from = offset;
        offset += field.size * field.count * header.points;
        if (plain(field)) fields.push({ name: field.name, opaque: packed(field.name), at: (index) => scalarAt(view, field.type!, from + index * field.size, true) });
      }
    } catch (err) {
      reach = 0;
      unread.push(`the points could not be unpacked (${(err as Error).message})`);
    }
  } else if (header.data === "ascii") {
    const rows = latin1(body.subarray(0, ASCII))
      .split("\n", SAMPLED + 1)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, SAMPLED)
      .map((line) => line.split(/\s+/).map(Number));
    // The last line taken may be half of one, where the body was longer than what was read.
    if (body.length > ASCII) rows.pop();
    reach = Math.min(header.points, rows.length);
    let column = 0;
    for (const field of header.fields) {
      const from = column;
      column += field.count;
      if (plain(field)) fields.push({ name: field.name, opaque: packed(field.name), at: (index) => rows[index]?.[from] ?? Number.NaN });
    }
  } else {
    reach = 0;
    unread.push(`points stored as "${header.data}" are not a form PCD defines`);
  }

  if (reach < header.points && header.data !== "ascii" && !unread.length) {
    lines.push(`The file holds ${count(reach)} of the ${count(header.points)} points its header promises: it is cut short.`);
  }
  if (!fields.some((field) => !field.opaque)) fields = [];
  const described = describePoints(fields, header.points, reach);
  lines.push(...described.lines);

  const skipped = header.fields.filter((field) => !plain(field) || packed(field.name)).map((field) => field.name);
  if (skipped.length) unread.push(`${[...new Set(skipped)].join(", ")} (packed, padding or multi-valued fields) are named but not summarised`);
  unread.push("the points themselves are summarised, not listed");
  lines.push(`Not read: ${unread.join("; ")}.`);
  return lines.join("\n");
}

export const pcd: Format = {
  name: "a point cloud",
  mimes: ["application/x-pcd", "application/vnd.pcl.pcd", "model/x-pcd", "text/x-pcd"],
  extensions: ["pcd"],
  loose: ["text/plain"],
  sniff: (bytes) => /^\s*(#[^\n]*\n\s*)*VERSION\s/.test(latin1(bytes.subarray(0, 1024))) && headerOf(bytes) !== undefined,
  read,
};
