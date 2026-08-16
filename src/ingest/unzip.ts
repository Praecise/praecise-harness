/**
 * Just enough ZIP to read an Office file.
 *
 * `.docx`, `.xlsx` and `.pptx` are ZIP archives of XML. Node ships the inflate
 * half of the problem in `node:zlib` but no archive reader, and the framework
 * takes no dependencies, so the central directory is walked by hand. Only what
 * Office actually emits is supported: stored and deflated entries, no
 * encryption, no ZIP64.
 */

// `Buffer` appears in this file's exported signatures, so it is imported rather than taken
// from the ambient global. A consumer's tsconfig decides whether ambient node types are in
// scope, and a published .d.ts that depends on that decision fails to typecheck for anyone
// who did not make it — which is what the consumer job caught.
import { Buffer } from "node:buffer";

import { inflateRawSync } from "node:zlib";

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;

/**
 * How much an archive is allowed to become.
 *
 * Deflate reaches a thousand to one on repetitive input, which is what a zip
 * bomb is: thirty kilobytes on the wire, thirty megabytes in the heap, and the
 * archive says so in a header nobody has to honour. The compressed size bounds
 * nothing, so the decompressed size must be bounded directly — per entry, so one
 * hostile member cannot do it alone, and across the archive, so a thousand
 * modest members cannot do it together.
 *
 * Set well above any real Office document, which runs to single-digit megabytes.
 * An app ingesting something genuinely larger should be reading it as a file
 * rather than inflating all of it into memory.
 */
const ENTRY_LIMIT = 32 * 1024 * 1024;
const ARCHIVE_LIMIT = 64 * 1024 * 1024;

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
  /** What has already been inflated, so the archive as a whole has a ceiling. */
  let produced = 0;

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

    // Whatever is left of the archive's ceiling, never more than one entry's.
    // Zero means the archive has already produced everything it is allowed to,
    // and every remaining entry would be refused — so stop reading rather than
    // walk the rest of the directory throwing.
    const room = Math.min(ENTRY_LIMIT, ARCHIVE_LIMIT - produced);
    if (room <= 0) break;

    try {
      const content = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw, { maxOutputLength: room }) : undefined;
      if (!content) continue;
      // A stored entry cannot exceed the file it came from, but it still spends
      // the archive's allowance — a thousand honest members are a bomb too.
      if (content.length > room) continue;
      produced += content.length;
      files.set(name, content);
    } catch {
      // A single unreadable entry — corrupt, or one that would have blown the
      // ceiling — should not lose the rest of the document.
    }
  }

  return files;
}
