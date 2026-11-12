/**
 * What is said about a set of points, whichever file they came in.
 *
 * A PCD file, a PLY file and a `.splat` file are all the same thing to a model: a number
 * of points, each with the same few fields. What it can use is where they are (the box
 * that holds them), what each other field ranges over, and a handful of them written
 * out. A million coordinates would tell it less than those three things.
 *
 * Ranges are taken over evenly spaced points, not the first ones: a lidar sweep is
 * ordered by angle and a splat file by size, so the head of either is not the whole.
 */

import { short, statsOf } from "../harness/modality.js";
import { count } from "./bytes.js";

/** One field of every point: its name, and its value at a given point. */
export interface Field {
  name: string;
  at(index: number): number;
  /** A field that is not a quantity (a packed colour): named, and left out of the ranges. */
  opaque?: boolean;
}

/** The most points a range is taken over. */
export const SAMPLED = 100_000;
/** How many points are written out. */
const SHOWN = 5;

export interface Described {
  lines: string[];
  /** Whether every point was looked at, or evenly spaced ones. */
  whole: boolean;
}

/**
 * Describe `total` points with these fields. `reach` is how many of them can actually
 * be read, where a file was cut short or only its head was parsed.
 */
export function describePoints(fields: readonly Field[], total: number, reach = total): Described {
  const lines: string[] = [];
  const whole = reach <= SAMPLED && reach === total;
  if (reach <= 0 || !fields.length) return { lines, whole: false };

  const step = reach <= SAMPLED ? 1 : (reach - 1) / (SAMPLED - 1);
  const looked = Math.min(reach, SAMPLED);
  const indices = Array.from({ length: looked }, (_, index) => Math.round(index * step));
  const over = whole ? `all ${count(total)} points` : reach < total ? `${count(looked)} of the first ${count(reach)} points` : `${count(looked)} evenly spaced points`;

  const byName = new Map(fields.map((field) => [field.name, field]));
  const axes = ["x", "y", "z"].map((name) => byName.get(name)).filter((field): field is Field => field !== undefined);
  const columns = new Map<string, number[]>();
  for (const field of fields) {
    if (!field.opaque) columns.set(field.name, indices.map((index) => field.at(index)));
  }

  if (axes.length === 3) {
    const stats = axes.map((axis) => statsOf(columns.get(axis.name)!));
    if (stats.every((each) => each !== undefined)) {
      const [x, y, z] = stats as NonNullable<(typeof stats)[number]>[];
      lines.push(
        `Bounds over ${over}: x ${short(x!.min)} to ${short(x!.max)}, y ${short(y!.min)} to ${short(y!.max)}, z ${short(z!.min)} to ${short(z!.max)} ` +
          `(extent ${short(x!.max - x!.min)} x ${short(y!.max - y!.min)} x ${short(z!.max - z!.min)}, centre ${short(x!.mean)}, ${short(y!.mean)}, ${short(z!.mean)}).`,
      );
      // Depth cameras and lidars write NaN where there was no return.
      const invalid = looked - Math.min(...stats.map((each) => each!.count));
      if (invalid > 0) lines.push(`${count(invalid)} of those points have no position (NaN or infinite), as sensors write where nothing was returned.`);
    } else {
      lines.push(`None of the ${over} looked at has a finite position.`);
    }
  }

  const others = fields.filter((field) => !field.opaque && !axes.includes(field));
  if (others.length) {
    const listed = others.slice(0, 24);
    lines.push(`Other fields over ${over}:`);
    for (const field of listed) {
      const stats = statsOf(columns.get(field.name)!);
      lines.push(stats ? `  ${field.name}: min ${short(stats.min)}, max ${short(stats.max)}, mean ${short(stats.mean)}` : `  ${field.name}: no finite values`);
    }
    if (others.length > listed.length) lines.push(`  … and ${others.length - listed.length} more field(s)`);
  }

  const visible = fields.filter((field) => !field.opaque).slice(0, 12);
  lines.push(`First ${Math.min(SHOWN, reach)} point(s) (${visible.map((field) => field.name).join(", ")}):`);
  for (let index = 0; index < Math.min(SHOWN, reach); index++) {
    lines.push(`  ${visible.map((field) => short(field.at(index))).join(", ")}`);
  }
  return { lines, whole };
}

/** How wide each of the scalar types these files use is, and how to read one. */
export type Scalar = "i8" | "u8" | "i16" | "u16" | "i32" | "u32" | "f32" | "f64" | "i64" | "u64";

export const WIDTH: Record<Scalar, number> = { i8: 1, u8: 1, i16: 2, u16: 2, i32: 4, u32: 4, f32: 4, f64: 8, i64: 8, u64: 8 };

export function scalarAt(view: DataView, type: Scalar, at: number, little: boolean): number {
  if (at < 0 || at + WIDTH[type] > view.byteLength) return Number.NaN;
  switch (type) {
    case "i8":
      return view.getInt8(at);
    case "u8":
      return view.getUint8(at);
    case "i16":
      return view.getInt16(at, little);
    case "u16":
      return view.getUint16(at, little);
    case "i32":
      return view.getInt32(at, little);
    case "u32":
      return view.getUint32(at, little);
    case "f32":
      return view.getFloat32(at, little);
    case "f64":
      return view.getFloat64(at, little);
    case "i64":
      return Number(view.getBigInt64(at, little));
    case "u64":
      return Number(view.getBigUint64(at, little));
  }
}
