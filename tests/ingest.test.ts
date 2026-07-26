import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync, deflateSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { canConvert, ingestFile } from "../src/ingest/index.js";
import { pdfToText } from "../src/ingest/pdf.js";
import { unzip } from "../src/ingest/unzip.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "praecise-ingest-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function file(name: string, contents: string | Buffer): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, contents);
  return path;
}

/** Build a one-entry zip archive the way Office writes them. */
function zip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const [name, text] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, "utf8");
    const body = Buffer.from(text, "utf8");
    const packed = deflateRawSync(body);

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    locals.push(local, packed);

    const entry = Buffer.alloc(46 + nameBytes.length);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(body.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    nameBytes.copy(entry, 46);
    central.push(entry);

    offset += local.length + packed.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}

/** Build a PDF with one Flate-compressed content stream. */
function pdf(text: string): Buffer {
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const stream = deflateSync(Buffer.from(content, "latin1"));
  return Buffer.concat([
    Buffer.from("%PDF-1.4\n4 0 obj\n<< /Filter /FlateDecode /Length 0 >>\nstream\n", "latin1"),
    stream,
    Buffer.from("\nendstream\nendobj\n%%EOF", "latin1"),
  ]);
}

describe("built-in converters", () => {
  it("reads markdown verbatim", async () => {
    const { text } = await ingestFile(await file("a.md", "# Title\n\nbody"));
    expect(text).toBe("# Title\n\nbody");
  });

  it("fences source so a model can see the language", async () => {
    const { text } = await ingestFile(await file("a.py", "print(1)"));
    expect(text).toBe("```py\nprint(1)\n```");
  });

  it("turns csv rows into labelled fields", async () => {
    const { text } = await ingestFile(await file("a.csv", "name,city\nAda,London\nAlan,Wilmslow"));
    expect(text).toBe("name: Ada, city: London\nname: Alan, city: Wilmslow");
  });

  it("keeps a quoted comma inside its field", async () => {
    const { text } = await ingestFile(await file("a.csv", 'name,note\nAda,"a, b"'));
    expect(text).toBe("name: Ada, note: a, b");
  });

  it("drops script and style when reading html", async () => {
    const html = "<html><style>p{}</style><body><p>One</p><script>x()</script><p>Two</p></body></html>";
    const { text } = await ingestFile(await file("a.html", html));
    expect(text).toBe("One\nTwo");
  });

  it("keeps only the spoken lines of a subtitle track", async () => {
    const vtt = "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nHello there\n";
    const { text } = await ingestFile(await file("a.vtt", vtt));
    expect(text).toBe("Hello there");
  });

  it("pretty-prints json and reports when it is not json", async () => {
    expect((await ingestFile(await file("a.json", '{"a":1}'))).text).toBe('{\n  "a": 1\n}');
    const bad = await ingestFile(await file("b.json", "{oops"));
    expect(bad.note).toContain("not valid JSON");
  });
});

describe("archives", () => {
  it("reads a deflated entry back out", () => {
    const files = unzip(zip({ "word/document.xml": "<w:p>hi</w:p>" }));
    expect(files.get("word/document.xml")?.toString()).toBe("<w:p>hi</w:p>");
  });

  it("returns nothing for bytes that are not an archive", () => {
    expect(unzip(Buffer.from("not a zip")).size).toBe(0);
  });

  it("pulls paragraphs out of a docx", async () => {
    const doc = zip({
      "word/document.xml": "<w:body><w:p><w:r><w:t>One</w:t></w:r></w:p><w:p><w:t>Two</w:t></w:p></w:body>",
    });
    const { text } = await ingestFile(await file("a.docx", doc));
    expect(text).toBe("One\nTwo");
  });

  it("labels each slide of a pptx", async () => {
    const deck = zip({
      "ppt/slides/slide1.xml": "<a:p><a:t>First</a:t></a:p>",
      "ppt/slides/slide2.xml": "<a:p><a:t>Second</a:t></a:p>",
    });
    const { text } = await ingestFile(await file("a.pptx", deck));
    expect(text).toBe("--- slide 1 ---\nFirst\n\n--- slide 2 ---\nSecond");
  });

  it("resolves xlsx shared strings into rows", async () => {
    const book = zip({
      "xl/sharedStrings.xml": "<sst><si><t>name</t></si><si><t>Ada</t></si></sst>",
      "xl/worksheets/sheet1.xml":
        '<sheetData><row><c t="s"><v>0</v></c></row><row><c t="s"><v>1</v></c></row></sheetData>',
    });
    const { text } = await ingestFile(await file("a.xlsx", book));
    expect(text).toBe("name: Ada");
  });
});

describe("pdf", () => {
  it("recovers text from a compressed content stream", () => {
    expect(pdfToText(pdf("Hello world"))).toBe("Hello world");
  });

  it("says so when there is no text to find", async () => {
    const scanned = Buffer.from("%PDF-1.4\nnothing here\n%%EOF", "latin1");
    const { text, note } = await ingestFile(await file("a.pdf", scanned));
    expect(text).toBe("");
    expect(note).toContain("scanned");
  });
});

describe("the pipeline", () => {
  it("caches a conversion by content, not by path", async () => {
    const cacheDir = join(dir, "cache");
    const first = await ingestFile(await file("a.csv", "a,b\n1,2"), { cacheDir });
    const copy = await ingestFile(await file("copy.csv", "a,b\n1,2"), { cacheDir });
    expect(copy.text).toBe(first.text);
  });

  it("hands an unknown format to the fallback converter", async () => {
    const { text } = await ingestFile(await file("a.dwg", "binary"), {
      fallback: async () => ({ text: "a drawing" }),
    });
    expect(text).toBe("a drawing");
  });

  it("reports an unreadable format rather than throwing", async () => {
    const { text, note } = await ingestFile(await file("a.dwg", "binary"));
    expect(text).toBe("");
    expect(note).toContain(".dwg");
  });

  it("knows which extensions it can read", () => {
    expect(canConvert(".pdf")).toBe(true);
    expect(canConvert(".dwg")).toBe(false);
  });
});
