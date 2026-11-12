/**
 * The directory of a zip archive, and the bytes of one file in it.
 *
 * Two of the formats here are zip archives under another name: a `.usdz` is a zip of a
 * USD layer and its textures, stored uncompressed, and a `.npz` is a zip of `.npy`
 * arrays. Neither needs more than this: the central directory at the end of the file
 * says what is inside and where, and a member is either stored or deflated.
 *
 * ZIP64 archives (more than 65,535 members, or anything past 4 GB) are not read; a file
 * that size is not sent as an attachment.
 */

import { Cursor, startsWith } from "./bytes.js";
import { unpack } from "./unpack.js";

export interface Member {
  name: string;
  /** 0 is stored, 8 is deflate. */
  method: number;
  packed: number;
  size: number;
  /** Where its local header starts. */
  offset: number;
}

const END = [0x50, 0x4b, 0x05, 0x06];

/** Whether these bytes begin as a zip archive does. */
export const isZip = (bytes: Uint8Array): boolean => startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, END);

/** What a zip archive holds, from its central directory. */
export function membersOf(bytes: Uint8Array): Member[] {
  // The end record is the last thing in the file but for a comment of up to 65,535 bytes.
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) {
    if (startsWith(bytes, END, at)) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error("it has no zip directory: the archive is cut short");
  const tail = new Cursor(bytes, end + 10);
  const total = tail.u16();
  tail.skip(4);
  const start = tail.u32();
  if (total === 0xffff || start === 0xffffffff) throw new Error("it is a ZIP64 archive, which is not read");

  const members: Member[] = [];
  const cursor = new Cursor(bytes, start);
  for (let index = 0; index < total; index++) {
    if (cursor.u32() !== 0x02014b50) throw new Error("its zip directory is damaged");
    cursor.skip(6);
    const method = cursor.u16();
    cursor.skip(8);
    const packed = cursor.u32();
    const size = cursor.u32();
    const nameLength = cursor.u16();
    const extraLength = cursor.u16();
    const commentLength = cursor.u16();
    cursor.skip(8);
    const offset = cursor.u32();
    const name = cursor.text(nameLength);
    cursor.skip(extraLength + commentLength);
    members.push({ name, method, packed, size, offset });
  }
  return members;
}

/** Where a member's own bytes start, past its local header. */
function dataStart(bytes: Uint8Array, member: Member): number {
  const cursor = new Cursor(bytes, member.offset);
  if (cursor.u32() !== 0x04034b50) throw new Error(`the zip entry for "${member.name}" is damaged`);
  cursor.skip(22);
  const nameLength = cursor.u16();
  const extraLength = cursor.u16();
  return cursor.at + nameLength + extraLength;
}

/**
 * The first `most` bytes of a stored member without touching the rest, or nothing if it
 * is compressed. A header is all most callers want.
 */
export function headOf(bytes: Uint8Array, member: Member, most: number): Uint8Array | undefined {
  if (member.method !== 0) return undefined;
  const start = dataStart(bytes, member);
  return bytes.subarray(start, Math.min(bytes.length, start + Math.min(most, member.size)));
}

/** A member's bytes, inflated if it was deflated. */
export function contentOf(bytes: Uint8Array, member: Member): Uint8Array {
  const start = dataStart(bytes, member);
  const packed = bytes.subarray(start, start + member.packed);
  if (packed.length < member.packed) throw new Error(`"${member.name}" is cut short`);
  if (member.method === 0) return packed;
  if (member.method === 8) return unpack("deflate", packed, member.size);
  throw new Error(`"${member.name}" uses zip compression method ${member.method}, which is not read`);
}

