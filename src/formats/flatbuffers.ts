/**
 * Reading a FlatBuffers table, and no more of FlatBuffers than that.
 *
 * Arrow writes its schema and the header of every batch as FlatBuffers. A table there is
 * an offset to a vtable, and the vtable is a list of where each field sits in the table,
 * zero where the writer left the field at its default. So a field is read by its position
 * in the `.fbs` declaration, which is the number each accessor here takes; `arrow.ts`
 * gives those numbers their names.
 *
 * Every offset is checked against the bytes before it is followed: a table that points
 * outside its buffer is a damaged file, and says so.
 */

import { utf8, viewOf } from "./bytes.js";

export class Table {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private readonly at: number;

  constructor(bytes: Uint8Array, view: DataView, at: number) {
    this.bytes = bytes;
    this.view = view;
    this.at = at;
    if (at < 4 || at + 4 > bytes.length) throw new Error("a FlatBuffers table points outside its buffer");
  }

  /** Where a field's value is, or 0 if the writer left it out. */
  private slot(field: number): number {
    const vtable = this.at - this.view.getInt32(this.at, true);
    if (vtable < 0 || vtable + 4 > this.bytes.length) throw new Error("a FlatBuffers vtable points outside its buffer");
    const entry = 4 + field * 2;
    if (entry + 2 > this.view.getUint16(vtable, true)) return 0;
    const offset = this.view.getUint16(vtable + entry, true);
    if (offset && this.at + offset + 1 > this.bytes.length) throw new Error("a FlatBuffers field points outside its buffer");
    return offset ? this.at + offset : 0;
  }

  /** Follow the offset stored at `from` to what it points at. */
  private follow(from: number): number {
    const to = from + this.view.getUint32(from, true);
    if (to + 4 > this.bytes.length) throw new Error("a FlatBuffers offset points outside its buffer");
    return to;
  }

  u8(field: number, otherwise = 0): number {
    const at = this.slot(field);
    return at ? this.view.getUint8(at) : otherwise;
  }

  bool(field: number, otherwise = false): boolean {
    const at = this.slot(field);
    return at ? this.view.getUint8(at) !== 0 : otherwise;
  }

  i16(field: number, otherwise = 0): number {
    const at = this.slot(field);
    return at ? this.view.getInt16(at, true) : otherwise;
  }

  i32(field: number, otherwise = 0): number {
    const at = this.slot(field);
    return at ? this.view.getInt32(at, true) : otherwise;
  }

  i64(field: number, otherwise = 0): number {
    const at = this.slot(field);
    return at ? Number(this.view.getBigInt64(at, true)) : otherwise;
  }

  string(field: number): string | undefined {
    const at = this.slot(field);
    if (!at) return undefined;
    const start = this.follow(at);
    const length = this.view.getUint32(start, true);
    if (start + 4 + length > this.bytes.length) throw new Error("a FlatBuffers string runs past its buffer");
    return utf8(this.bytes.subarray(start + 4, start + 4 + length));
  }

  table(field: number): Table | undefined {
    const at = this.slot(field);
    return at ? new Table(this.bytes, this.view, this.follow(at)) : undefined;
  }

  /** Where a vector's elements start and how many there are. */
  private vector(field: number, width: number): { start: number; length: number } {
    const at = this.slot(field);
    if (!at) return { start: 0, length: 0 };
    const start = this.follow(at);
    const length = this.view.getUint32(start, true);
    if (start + 4 + length * width > this.bytes.length) throw new Error("a FlatBuffers vector runs past its buffer");
    return { start: start + 4, length };
  }

  /** A vector of tables. */
  tables(field: number): Table[] {
    const { start, length } = this.vector(field, 4);
    return Array.from({ length }, (_, index) => new Table(this.bytes, this.view, this.follow(start + index * 4)));
  }

  /** A vector of fixed-size structs, as the offset of each within the buffer. */
  structs(field: number, width: number): number[] {
    const { start, length } = this.vector(field, width);
    return Array.from({ length }, (_, index) => start + index * width);
  }

  /** How many elements a vector has, whatever they are. */
  length(field: number): number {
    return this.vector(field, 0).length;
  }

  get raw(): DataView {
    return this.view;
  }
}

/** The root table of a buffer that starts at `at`. */
export function rootOf(bytes: Uint8Array, at = 0): Table {
  const view = viewOf(bytes);
  if (at + 4 > bytes.length) throw new Error("a FlatBuffers buffer is cut short");
  return new Table(bytes, view, at + view.getUint32(at, true));
}
