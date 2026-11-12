/**
 * Thrift's compact protocol, read into plain values.
 *
 * Parquet's footer is one Thrift struct in this encoding. A struct on the wire carries
 * each field's number and type, so it can be read without the schema it was written
 * from: what comes out is a map from field number to value, and `parquet.ts` is where
 * the numbers are given their names.
 *
 * Integers are returned as JavaScript numbers. A 64-bit count past 2^53 loses its last
 * digits; nothing a footer counts (rows, bytes, offsets) is that large in a file that
 * fits in memory.
 */

import { Cursor } from "./bytes.js";

export type Value = number | boolean | Uint8Array | Value[] | Struct;
export type Struct = Map<number, Value>;

const BOOL_TRUE = 1;
const BOOL_FALSE = 2;
const BYTE = 3;
const I16 = 4;
const I32 = 5;
const I64 = 6;
const DOUBLE = 7;
const BINARY = 8;
const LIST = 9;
const SET = 10;
const MAP = 11;
const STRUCT = 12;
const UUID = 13;

/** Structs nest (a schema inside a file, a statistic inside a column); nothing real nests this deep. */
const DEEPEST = 48;

function varint(cursor: Cursor): number {
  let value = 0;
  let scale = 1;
  for (let read = 0; read < 10; read++) {
    const byte = cursor.u8();
    value += (byte & 0x7f) * scale;
    if (byte < 0x80) return value;
    scale *= 128;
  }
  throw new Error("a Thrift integer runs past ten bytes");
}

/** ZigZag: the sign is in the lowest bit, so small negatives stay short. */
const zigzag = (value: number): number => (value % 2 === 0 ? value / 2 : -(value + 1) / 2);

function valueOf(cursor: Cursor, type: number, depth: number): Value {
  switch (type) {
    case BOOL_TRUE:
    case BOOL_FALSE:
      // Only reached for an element of a list: a field's boolean is in its header.
      return cursor.u8() === BOOL_TRUE;
    case BYTE:
      return (cursor.u8() << 24) >> 24;
    case I16:
    case I32:
    case I64:
      return zigzag(varint(cursor));
    case DOUBLE:
      return cursor.f64();
    case BINARY:
      return cursor.take(varint(cursor));
    case LIST:
    case SET: {
      const header = cursor.u8();
      const length = header >> 4 === 15 ? varint(cursor) : header >> 4;
      const element = header & 15;
      if (length > cursor.left && element !== STRUCT) throw new Error("a Thrift list is longer than the bytes that hold it");
      const items: Value[] = [];
      for (let index = 0; index < length; index++) items.push(valueOf(cursor, element, depth + 1));
      return items;
    }
    case MAP: {
      const length = varint(cursor);
      const pairs: Value[] = [];
      if (length === 0) return pairs;
      const types = cursor.u8();
      for (let index = 0; index < length; index++) {
        pairs.push([valueOf(cursor, types >> 4, depth + 1), valueOf(cursor, types & 15, depth + 1)]);
      }
      return pairs;
    }
    case STRUCT:
      return structOf(cursor, depth + 1);
    case UUID:
      return cursor.take(16);
    default:
      throw new Error(`a Thrift field has type ${type}, which the compact protocol does not define`);
  }
}

/** One struct: fields until the stop byte, each numbered from the one before it. */
export function structOf(cursor: Cursor, depth = 0): Struct {
  if (depth > DEEPEST) throw new Error("its Thrift structs nest deeper than any real file's");
  const fields: Struct = new Map();
  let id = 0;
  for (;;) {
    const header = cursor.u8();
    if (header === 0) return fields;
    const type = header & 15;
    const delta = header >> 4;
    id = delta ? id + delta : zigzag(varint(cursor));
    fields.set(id, type === BOOL_TRUE ? true : type === BOOL_FALSE ? false : valueOf(cursor, type, depth));
  }
}

// What a field is taken to be once it has a name. Each returns nothing for a field that
// is absent or is not that kind of thing, which is how an optional field reads.

export const num = (struct: Struct | undefined, id: number): number | undefined => {
  const value = struct?.get(id);
  return typeof value === "number" ? value : undefined;
};

export const flag = (struct: Struct | undefined, id: number): boolean | undefined => {
  const value = struct?.get(id);
  return typeof value === "boolean" ? value : undefined;
};

export const bin = (struct: Struct | undefined, id: number): Uint8Array | undefined => {
  const value = struct?.get(id);
  return value instanceof Uint8Array ? value : undefined;
};

export const str = (struct: Struct | undefined, id: number): string | undefined => {
  const value = bin(struct, id);
  return value ? new TextDecoder().decode(value) : undefined;
};

export const sub = (struct: Struct | undefined, id: number): Struct | undefined => {
  const value = struct?.get(id);
  return value instanceof Map ? value : undefined;
};

export const list = (struct: Struct | undefined, id: number): Value[] => {
  const value = struct?.get(id);
  return Array.isArray(value) ? value : [];
};

export const structs = (struct: Struct | undefined, id: number): Struct[] =>
  list(struct, id).filter((value): value is Struct => value instanceof Map);
