/**
 * Just enough ZIP to read an Office file.
 *
 * `.docx`, `.xlsx` and `.pptx` are ZIP archives of XML. Node ships the inflate
 * half of the problem in `node:zlib` but no archive reader, and the framework
 * takes no dependencies, so the central directory is walked by hand. Only what
 * Office actually emits is supported: stored and deflated entries, no
 * encryption, no ZIP64.
 */

import { inflateRawSync } from "node:zlib";

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;

/** Scan back from the end for the end-of-central-directory record. */
function findDirectoryEnd(buf: Buffer): number | undefined {
  const earliest = Math.max(0, buf.length - 0xffff - 22);
  for (let at = buf.length - 22; at >= earliest; at--) {
    if (buf.readUInt32LE(at) === END_OF_CENTRAL_DIRECTORY) return at;
  }
  return undefined;
}

/** Read an archive into name → bytes. Returns an empty map for anything else. */
export function unzip(buf: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const end = findDirectoryEnd(buf);
  if (end === undefined) return files;

  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);

  for (let index = 0; index < count; index++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== CENTRAL_FILE_HEADER) break;

    const method = buf.readUInt16LE(at + 10);
    const compressedSize = buf.readUInt32LE(at + 20);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const localAt = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;

    if (localAt + 30 > buf.length || buf.readUInt32LE(localAt) !== LOCAL_FILE_HEADER) continue;
    const localNameLength = buf.readUInt16LE(localAt + 26);
    const localExtraLength = buf.readUInt16LE(localAt + 28);
    const from = localAt + 30 + localNameLength + localExtraLength;
    const raw = buf.subarray(from, from + compressedSize);

    try {
      if (method === 0) files.set(name, Buffer.from(raw));
      else if (method === 8) files.set(name, inflateRawSync(raw));
    } catch {
      // A single unreadable entry should not lose the rest of the document.
    }
  }

  return files;
}
