/**
 * NumPy `.npy` and `.npz`: how an array leaves a Python program, and so how robot state,
 * an action chunk or a calibration usually arrives.
 *
 * An `.npy` file is a magic string, a version, and a header that is a Python dictionary
 * written as text: the element type, whether the array is stored column-first, and its
 * shape. The elements follow, packed. An `.npz` is a zip archive of `.npy` files, one per
 * named array.
 *
 * Numeric arrays of either byte order are read: their range and deviation, and a bounded
 * sample of values. A two-dimensional array with few columns is taken to be a series of
 * vectors (rows over time, a column per joint), since that is what such a file nearly
 * always is, and each column is summarised on its own. Strings, structured records and
 * pickled objects are described from the header only, and that is said.
 *
 * Layout from `numpy/lib/_format_impl.py` (the NPY format specification), read on
 * 2026-11-13.
 */

import { sample, short, statsOf } from "../harness/modality.js";
import type { Format } from "./bytes.js";
import { clip, count, Cursor, latin1, size, startsWith, utf8, viewOf } from "./bytes.js";
import { MOST } from "./unpack.js";
import { contentOf, isZip, membersOf } from "./zip.js";

const MAGIC = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59];

/** The most elements a range is taken over. */
const SAMPLED = 100_000;
/** The most columns a two-dimensional array may have and still be read as vectors over time. */
const COLUMNS = 32;
const SHOWN = 24;

interface Header {
  version: string;
  descr: string;
  /** Whether `descr` is a list of fields: a structured array. */
  structured: boolean;
  fortran: boolean;
  shape: number[];
  /** Where the elements start. */
  start: number;
}

function headerOf(bytes: Uint8Array): Header {
  const cursor = new Cursor(bytes, MAGIC.length);
  const major = cursor.u8();
  const minor = cursor.u8();
  // Version 1 has a two-byte header length; 2 and 3 have four, and 3 writes the header as UTF-8.
  const length = major === 1 ? cursor.u16() : cursor.u32();
  const raw = cursor.take(length);
  const text = major >= 3 ? utf8(raw) : latin1(raw);
  const simple = /'descr'\s*:\s*'([^']*)'/.exec(text);
  const record = /'descr'\s*:\s*(\[[\s\S]*\])\s*,\s*'(?:fortran_order|shape)'/.exec(text);
  const shape = /'shape'\s*:\s*\(([^)]*)\)/.exec(text);
  if ((!simple && !record) || !shape) throw new Error("its header does not name a dtype and a shape");
  return {
    version: `${major}.${minor}`,
    descr: simple ? simple[1]! : record![1]!,
    structured: !simple,
    fortran: /'fortran_order'\s*:\s*True/.test(text),
    shape: shape[1]!
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map(Number),
    start: cursor.at,
  };
}

interface Dtype {
  /** What a person calls it: float32, int64, bool. */
  said: string;
  width: number;
  /** How to read one element, or nothing for a type that is not a number. */
  at?: (view: DataView, offset: number) => number;
}

/** IEEE 754 half precision, which `DataView` only reads on newer runtimes than this package supports. */
function half(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * (fraction / 1024) * 2 ** -14;
  if (exponent === 31) return fraction ? Number.NaN : sign * Infinity;
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

function dtypeOf(descr: string): Dtype {
  // An object array is written as `|O`, with no width.
  const found = /^([<>|=])([A-Za-z])(\d*)(\[.*\])?$/.exec(descr);
  if (!found) return { said: descr, width: 0 };
  const little = found[1] !== ">";
  const kind = found[2]!;
  const width = Number(found[3]);
  const order = width > 1 ? (little ? ", little-endian" : ", big-endian") : "";
  const numeric: Record<string, Dtype["at"]> = {
    b1: (view, at) => view.getUint8(at),
    i1: (view, at) => view.getInt8(at),
    i2: (view, at) => view.getInt16(at, little),
    i4: (view, at) => view.getInt32(at, little),
    i8: (view, at) => Number(view.getBigInt64(at, little)),
    u1: (view, at) => view.getUint8(at),
    u2: (view, at) => view.getUint16(at, little),
    u4: (view, at) => view.getUint32(at, little),
    u8: (view, at) => Number(view.getBigUint64(at, little)),
    f2: (view, at) => half(view.getUint16(at, little)),
    f4: (view, at) => view.getFloat32(at, little),
    f8: (view, at) => view.getFloat64(at, little),
  };
  const names: Record<string, string> = { b: "bool", i: `int${width * 8}`, u: `uint${width * 8}`, f: `float${width * 8}`, c: `complex${width * 8}` };
  const other: Record<string, string> = {
    S: `byte strings of ${width}`,
    a: `byte strings of ${width}`,
    U: `strings of ${width} characters`,
    O: "Python objects (pickled)",
    M: `datetime64${found[4] ?? ""}`,
    m: `timedelta64${found[4] ?? ""}`,
    V: `raw records of ${width} bytes`,
  };
  return {
    said: names[kind] ? `${names[kind]}${order}` : (other[kind] ?? descr),
    // A character of a `U` string is four bytes.
    width: kind === "U" ? width * 4 : kind === "O" ? 0 : width,
    at: numeric[`${kind}${width}`],
  };
}

/** Describe one array. `named` is its name inside an archive. */
function describe(bytes: Uint8Array, named?: string): string[] {
  const header = headerOf(bytes);
  const dtype = header.structured ? { said: "structured records", width: 0 } : dtypeOf(header.descr);
  const total = header.shape.reduce((product, each) => product * each, 1);
  const body = bytes.subarray(header.start);
  const lines = [
    `${named ? `${named}: ` : `A NumPy array (.npy, format ${header.version}): `}shape (${header.shape.join(", ")}), ${dtype.said}` +
      (header.structured ? "" : ` (${header.descr})`) +
      `${header.shape.length > 1 ? (header.fortran ? ", stored column-first (Fortran order)" : ", stored row-first (C order)") : ""}; ` +
      `${count(total)} value(s) in ${size(body.length)}.`,
  ];
  if (header.structured) lines.push(`  Fields: ${clip(header.descr.replace(/\s+/g, " "), 600)}`);

  const read = dtype.at;
  if (!read || !dtype.width) {
    lines.push(`  Not read: the values. ${header.structured ? "Structured records" : `Elements that are ${dtype.said}`} are not numbers this reads; only the header is described.`);
    return lines;
  }
  const view = viewOf(body);
  const reach = Math.min(total, Math.floor(body.length / dtype.width));
  if (reach < total) lines.push(`  The file holds ${count(reach)} of the ${count(total)} values its header promises: it is cut short.`);
  if (!reach) return lines;
  const at = (index: number): number => read(view, index * dtype.width);
  const evenly = (most: number, length: number): number[] =>
    length <= most ? Array.from({ length }, (_, index) => index) : Array.from({ length: most }, (_, index) => Math.round((index * (length - 1)) / (most - 1)));
  const figures = (values: number[]): string => {
    const stats = statsOf(values);
    return stats ? `min ${short(stats.min)}, max ${short(stats.max)}, mean ${short(stats.mean)}, sd ${short(stats.sd)}` : "no finite values";
  };

  const [rows, columns] = header.shape;
  if (header.shape.length === 2 && rows! > 1 && columns! >= 1 && columns! <= COLUMNS && reach === total) {
    // Rows over time, a column per quantity: each column is its own series.
    const flat = (row: number, column: number): number => (header.fortran ? column * rows! + row : row * columns! + column);
    const picked = evenly(Math.max(2, Math.floor(SAMPLED / columns!)), rows!);
    lines.push(`  Each column over ${picked.length === rows ? `all ${count(rows!)} rows` : `${count(picked.length)} evenly spaced of ${count(rows!)} rows`}:`);
    for (let column = 0; column < columns!; column++) {
      lines.push(
        `    [${column}]: ${figures(picked.map((row) => at(flat(row, column))))}; first ${short(at(flat(0, column)))}, last ${short(at(flat(rows! - 1, column)))}`,
      );
    }
    const shown = sample(Array.from({ length: rows! }, (_, row) => row), 6);
    lines.push(`  ${shown.length === rows ? "All rows" : `${shown.length} evenly spaced rows`} (row: values):`);
    for (const row of shown) lines.push(`    ${row}: ${Array.from({ length: columns! }, (_, column) => short(at(flat(row, column)))).join(", ")}`);
    return lines;
  }

  const picked = evenly(SAMPLED, reach);
  lines.push(`  Over ${picked.length === reach ? "all of them" : `${count(picked.length)} evenly spaced of them`}: ${figures(picked.map(at))}.`);
  const first = Math.min(SHOWN, reach);
  lines.push(`  ${first === reach ? "All" : `First ${first}`}, in stored order: ${Array.from({ length: first }, (_, index) => short(at(index))).join(", ")}`);
  if (header.shape.length > 2) lines.push("  The array has more than two dimensions; its values are summarised together, not along any axis.");
  return lines;
}

function readArchive(bytes: Uint8Array): string {
  const members = membersOf(bytes);
  const arrays = members.filter((member) => member.name.endsWith(".npy"));
  const lines = [`A NumPy archive (.npz): ${count(arrays.length)} array(s); ${size(bytes.length)}.`];
  const unread: string[] = [];
  for (const member of arrays.slice(0, 24)) {
    const name = member.name.replace(/\.npy$/, "");
    if (member.size > MOST) {
      unread.push(`${name} (${size(member.size)}) is larger than is unpacked for a sample`);
      continue;
    }
    try {
      lines.push(...describe(contentOf(bytes, member), name));
    } catch (err) {
      unread.push(`${name} could not be read (${(err as Error).message})`);
    }
  }
  if (arrays.length > 24) unread.push(`${count(arrays.length - 24)} more array(s) are in the archive: ${clip(arrays.slice(24).map((member) => member.name.replace(/\.npy$/, "")).join(", "), 400)}`);
  const others = members.filter((member) => !member.name.endsWith(".npy"));
  if (others.length) unread.push(`${count(others.length)} file(s) that are not arrays (${clip(others.map((member) => member.name).join(", "), 200)})`);
  unread.push("values are summarised and sampled, not listed");
  lines.push(`Not read: ${unread.join("; ")}.`);
  return lines.join("\n");
}

/** Whether a zip archive holds NumPy arrays: its first file is one. */
function archived(bytes: Uint8Array): boolean {
  if (!isZip(bytes)) return false;
  try {
    return membersOf(bytes)[0]?.name.endsWith(".npy") === true;
  } catch {
    return false;
  }
}

export const npy: Format = {
  name: "a NumPy array",
  mimes: ["application/x-npy", "application/x-numpy", "application/npy", "application/x-npz", "application/npz"],
  extensions: ["npy", "npz"],
  loose: ["application/zip", "application/x-zip-compressed"],
  // An archive cut short has lost its directory, and is only known for what it was called.
  sniff: (bytes, declared) => startsWith(bytes, MAGIC) || archived(bytes) || (declared && isZip(bytes)),
  read: (bytes) => {
    if (!startsWith(bytes, MAGIC)) return readArchive(bytes);
    const lines = describe(bytes);
    // An array that is not numbers has already said that its values were not read at all.
    if (!lines.some((line) => line.trimStart().startsWith("Not read:"))) lines.push("Not read: values are summarised and sampled, not listed.");
    return lines.join("\n");
  },
};
