/**
 * PLY: the Stanford polygon format, used for scanned meshes, point clouds and, since
 * 2023, for trained Gaussian splats.
 *
 * A text header declares elements (`vertex`, `face`, ...), how many of each there are,
 * and the properties of one. The data follows as text or as packed binary of either
 * byte order. An element whose properties are all single numbers has a fixed size, so
 * its rows can be reached directly; one with a list property (a face's vertex indices)
 * does not, and is counted from the header and not read.
 *
 * So: the header is reported in full, and the vertices are summarised when they can be
 * reached, which is whenever no list-bearing element comes before them. That is every
 * file in practice.
 *
 * Layout from Paul Bourke's description of the format (paulbourke.net/dataformats/ply),
 * read on 2026-11-13.
 */

import type { Format } from "./bytes.js";
import { clip, count, latin1, size, startsWith, viewOf } from "./bytes.js";
import type { Field, Scalar } from "./points.js";
import { describePoints, SAMPLED, scalarAt, WIDTH } from "./points.js";

const HEADER = 256 * 1024;
const ASCII = 16 * 1024 * 1024;

const TYPES: Record<string, Scalar> = {
  char: "i8", int8: "i8", uchar: "u8", uint8: "u8", short: "i16", int16: "i16", ushort: "u16", uint16: "u16",
  int: "i32", int32: "i32", uint: "u32", uint32: "u32", float: "f32", float32: "f32", double: "f64", float64: "f64",
};

export interface Property {
  name: string;
  /** Nothing for a list, or for a type the format does not define. */
  type: Scalar | undefined;
  said: string;
}

export interface Element {
  name: string;
  count: number;
  properties: Property[];
}

export interface PlyHeader {
  format: string;
  comments: string[];
  elements: Element[];
  /** Where the data starts. */
  start: number;
}

export function plyHeaderOf(bytes: Uint8Array): PlyHeader | undefined {
  if (!startsWith(bytes, "ply")) return undefined;
  const head = latin1(bytes.subarray(0, Math.min(bytes.length, HEADER)));
  const end = /(^|\n)end_header[ \t]*\r?\n/.exec(head);
  if (!end) return undefined;
  const header: PlyHeader = { format: "", comments: [], elements: [], start: end.index + end[0].length };
  for (const raw of head.slice(0, end.index).split("\n")) {
    const line = raw.trim();
    const [word, ...rest] = line.split(/\s+/);
    if (word === "format") header.format = rest[0] ?? "";
    else if (word === "comment" || word === "obj_info") header.comments.push(rest.join(" "));
    else if (word === "element") header.elements.push({ name: rest[0] ?? "", count: Number(rest[1] ?? 0), properties: [] });
    else if (word === "property") {
      const element = header.elements[header.elements.length - 1];
      if (!element) continue;
      if (rest[0] === "list") element.properties.push({ name: rest[3] ?? "", type: undefined, said: `list of ${rest[2]}` });
      else element.properties.push({ name: rest[1] ?? "", type: TYPES[rest[0] ?? ""], said: rest[0] ?? "" });
    }
  }
  return header.format ? header : undefined;
}

const fixed = (element: Element): boolean => element.properties.every((property) => property.type !== undefined);
const widthOf = (element: Element): number => element.properties.reduce((total, property) => total + (property.type ? WIDTH[property.type] : 0), 0);

/**
 * The properties of one element as fields that can be read at any row, and how many of
 * its rows are actually there. Nothing if the element cannot be reached.
 */
export function plyFields(bytes: Uint8Array, header: PlyHeader, element: Element): { fields: Field[]; reach: number } | undefined {
  const index = header.elements.indexOf(element);
  const before = header.elements.slice(0, index);
  if (!fixed(element)) return undefined;
  const body = bytes.subarray(header.start);

  if (header.format === "ascii") {
    // Every row of every element is a line, so rows before this element are lines to step over.
    const skip = before.reduce((total, each) => total + each.count, 0);
    const rows = latin1(body.subarray(0, ASCII))
      .split("\n", skip + SAMPLED + 1)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(skip, skip + SAMPLED)
      .map((line) => line.split(/\s+/).map(Number));
    if (body.length > ASCII) rows.pop();
    return {
      fields: element.properties.map((property, column) => ({ name: property.name, at: (row) => rows[row]?.[column] ?? Number.NaN })),
      reach: Math.min(element.count, rows.length),
    };
  }

  if (header.format !== "binary_little_endian" && header.format !== "binary_big_endian") return undefined;
  if (!before.every(fixed)) return undefined;
  const little = header.format === "binary_little_endian";
  const from = before.reduce((total, each) => total + each.count * widthOf(each), 0);
  const stride = widthOf(element);
  const view = viewOf(body);
  let offset = 0;
  const fields = element.properties.map((property) => {
    const at = offset;
    offset += WIDTH[property.type!];
    return { name: property.name, at: (row: number) => scalarAt(view, property.type!, from + row * stride + at, little) };
  });
  return { fields, reach: Math.max(0, Math.min(element.count, Math.floor((body.length - from) / Math.max(1, stride)))) };
}

const FORMATS: Record<string, string> = { ascii: "text", binary_little_endian: "little-endian binary", binary_big_endian: "big-endian binary" };

function read(bytes: Uint8Array): string {
  const header = plyHeaderOf(bytes);
  if (!header) throw new Error("its header is not a PLY header");
  const vertex = header.elements.find((element) => element.name === "vertex");
  const faces = header.elements.find((element) => element.name === "face");
  const lines = [
    `A PLY ${faces && faces.count > 0 ? "mesh" : "point cloud"}: ${header.elements.map((element) => `${count(element.count)} ${element.name}`).join(", ")}; ` +
      `stored as ${FORMATS[header.format] ?? header.format}; ${size(bytes.length)}.`,
  ];
  for (const element of header.elements) {
    lines.push(`Properties of ${element.name}: ${clip(element.properties.map((property) => `${property.name} (${property.said})`).join(", "), 900)}.`);
  }
  if (header.comments.length) lines.push(`Comments: ${clip(header.comments.slice(0, 6).join(" | "), 400)}`);

  const unread: string[] = [];
  if (vertex) {
    const found = plyFields(bytes, header, vertex);
    if (found) {
      // A colour or a normal is a quantity too, and is ranged with the rest.
      if (found.reach < vertex.count && header.format !== "ascii") {
        lines.push(`The file holds ${count(found.reach)} of the ${count(vertex.count)} vertices its header promises: it is cut short.`);
      }
      lines.push(...describePoints(found.fields, vertex.count, found.reach).lines);
    } else {
      unread.push("the vertices could not be reached, because an element with list properties is stored before them or the format is not one PLY defines");
    }
  }
  const lists = header.elements.filter((element) => element !== vertex && element.count > 0).map((element) => element.name);
  if (lists.length) unread.push(`the ${lists.join(", ")} data is counted from the header and not read`);
  unread.push("the vertices are summarised, not listed");
  lines.push(`Not read: ${unread.join("; ")}.`);
  return lines.join("\n");
}

export const ply: Format = {
  name: "a PLY model",
  mimes: ["application/x-ply", "application/ply", "model/ply", "model/x-ply", "text/x-ply"],
  extensions: ["ply"],
  loose: ["text/plain"],
  sniff: (bytes) => plyHeaderOf(bytes) !== undefined,
  read,
};
