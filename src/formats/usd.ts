/**
 * USD: Pixar's scene description, which simulators and robot asset libraries are built on.
 *
 * It comes in three files. `.usda` is text, and is read here: the layer's settings, every
 * prim with its type and path, what it references or pulls in as a payload, its variant
 * sets, and which attributes are animated and over what time. Attribute values (the
 * points of a mesh, a transform) are counted and not shown.
 *
 * `.usdc` is the binary "crate" form. Its header, its table of contents and its table of
 * name tokens are read: the version, how many paths and specs it holds, and the names
 * that appear in it. The scene itself is stored as compressed integer tables that index
 * into each other, and rebuilding the prim tree from them is not done here; the
 * rendering says so.
 *
 * `.usdz` is a zip archive of a layer and its textures. Its directory is listed and its
 * first file, which the format makes the root layer, is read as whichever of the two
 * forms it is.
 *
 * The text form follows the grammar OpenUSD's own files are written in; the crate header,
 * table of contents and token section are from `pxr/usd/sdf/crateFile.cpp` and
 * `pxr/base/tf/fastCompression.cpp` in PixarAnimationStudios/OpenUSD, read on 2026-11-13.
 */

import type { Format } from "./bytes.js";
import { clip, count, Cursor, latin1, size, some, startsWith, utf8 } from "./bytes.js";
import { lz4Block } from "./unpack.js";
import type { Member } from "./zip.js";
import { contentOf, headOf, isZip, membersOf } from "./zip.js";

const TEXT = "#usda ";
const CRATE = "PXR-USDC";
const LISTED = 60;

// ── The text form ───────────────────────────────────────────────────────────

interface Token {
  kind: "word" | "string" | "asset" | "path" | "punct" | "line";
  text: string;
}

/** Break a layer into words, strings, asset paths, prim paths and punctuation, dropping comments. */
function tokens(source: string): Token[] {
  const out: Token[] = [];
  const word = /[A-Za-z0-9_.+-]+(?::[A-Za-z_][A-Za-z0-9_.]*)*/y;
  let at = 0;
  while (at < source.length) {
    const char = source[at]!;
    if (char === "\n") {
      if (out[out.length - 1]?.kind !== "line") out.push({ kind: "line", text: "\n" });
      at++;
    } else if (char === " " || char === "\t" || char === "\r") {
      at++;
    } else if (char === "#") {
      const end = source.indexOf("\n", at);
      at = end < 0 ? source.length : end;
    } else if (char === '"' || char === "'") {
      const triple = source.startsWith(char.repeat(3), at);
      const quote = triple ? char.repeat(3) : char;
      let end = at + quote.length;
      while (end < source.length && !source.startsWith(quote, end)) end += source[end] === "\\" ? 2 : 1;
      out.push({ kind: "string", text: source.slice(at + quote.length, end) });
      at = end + quote.length;
    } else if (char === "@") {
      const quote = source.startsWith("@@@", at) ? "@@@" : "@";
      const end = source.indexOf(quote, at + quote.length);
      const stop = end < 0 ? source.length : end;
      out.push({ kind: "asset", text: source.slice(at + quote.length, stop) });
      at = stop + quote.length;
    } else if (char === "<") {
      const end = source.indexOf(">", at);
      const stop = end < 0 ? source.length : end;
      out.push({ kind: "path", text: source.slice(at + 1, stop) });
      at = stop + 1;
    } else {
      word.lastIndex = at;
      const found = word.exec(source);
      if (found) {
        out.push({ kind: "word", text: found[0] });
        at += found[0].length;
      } else {
        out.push({ kind: "punct", text: char });
        at++;
      }
    }
  }
  return out;
}

interface Prim {
  path: string;
  specifier: string;
  type: string;
  properties: Set<string>;
  relationships: Set<string>;
  /** References, payloads, inherits and specializes, each as it was written. */
  arcs: string[];
  facts: string[];
  variantSets: Map<string, string[]>;
}

interface Animated {
  name: string;
  samples: number;
  first: number;
  last: number;
}

interface Layer {
  version: string;
  settings: string[];
  sublayers: string[];
  prims: Prim[];
  animated: Animated[];
  assets: Set<string>;
}

const ARCS = new Set(["references", "payload", "inherits", "specializes"]);
const QUALIFIERS = new Set(["custom", "uniform", "varying", "prepend", "append", "add", "delete", "reorder", "config"]);

function layerOf(source: string): Layer {
  const all = tokens(source);
  const layer: Layer = { version: /^#usda\s+(\S+)/.exec(source)?.[1] ?? "", settings: [], sublayers: [], prims: [], animated: [], assets: new Set() };
  let at = 0;
  const is = (index: number, kind: Token["kind"], text?: string): boolean => all[index]?.kind === kind && (text === undefined || all[index]!.text === text);
  const lines = (): void => {
    while (is(at, "line")) at++;
  };

  /** Step over a parenthesised block that starts at `at`, handing each `name = ...` at its top level to `each`. */
  const block = (each: (name: string, valueAt: number, end: number) => void): void => {
    let depth = 0;
    const start = at;
    let close = at;
    for (let index = at; index < all.length; index++) {
      if (is(index, "punct", "(")) depth++;
      else if (is(index, "punct", ")") && --depth === 0) {
        close = index;
        break;
      }
      close = index;
    }
    let inner = 0;
    for (let index = start + 1; index < close; index++) {
      const token = all[index]!;
      if (token.kind === "punct" && "([{".includes(token.text)) inner++;
      else if (token.kind === "punct" && ")]}".includes(token.text)) inner--;
      else if (inner === 0 && token.kind === "word" && is(index + 1, "punct", "=")) {
        // The value runs to the end of the line it closes its brackets on.
        let end = index + 2;
        let nested = 0;
        for (; end < close; end++) {
          const next = all[end]!;
          if (next.kind === "punct" && "([{".includes(next.text)) nested++;
          else if (next.kind === "punct" && ")]}".includes(next.text)) nested--;
          else if (next.kind === "line" && nested === 0) break;
        }
        each(token.text, index + 2, end);
        index = end - 1;
      }
    }
    at = close + 1;
  };

  const said = (from: number, to: number): string =>
    all
      .slice(from, to)
      .filter((token) => token.kind !== "line")
      .map((token) => (token.kind === "asset" ? `@${token.text}@` : token.kind === "path" ? `<${token.text}>` : token.kind === "string" ? `"${token.text}"` : token.text))
      .join(" ")
      .replace(/ ,/g, ",");

  // The layer's own settings are a parenthesised block before the first prim.
  lines();
  if (is(at, "punct", "(")) {
    block((name, from, to) => {
      if (name === "subLayers") {
        for (let index = from; index < to; index++) {
          if (!is(index, "asset")) continue;
          layer.sublayers.push(all[index]!.text);
          layer.assets.add(all[index]!.text);
        }
      } else if (["defaultPrim", "upAxis", "metersPerUnit", "kilogramsPerUnit", "timeCodesPerSecond", "framesPerSecond", "startTimeCode", "endTimeCode"].includes(name)) {
        layer.settings.push(`${name} ${said(from, to)}`);
      } else if (name === "doc" || name === "comment") {
        layer.settings.push(`${name} ${clip(said(from, to), 200)}`);
      }
    });
  }

  // What each open brace belongs to: a prim, a variant (whose contents are its prim's), or a value to step through.
  const scopes: { prim?: Prim; path: string; value: boolean; variants?: string[] }[] = [{ path: "", value: false }];
  let round = 0;
  let square = 0;
  let fresh = true;

  while (at < all.length) {
    const token = all[at]!;
    const top = scopes[scopes.length - 1]!;
    const statement = fresh && round === 0 && square === 0 && !top.value;
    fresh = false;

    if (token.kind === "line") {
      fresh = true;
      at++;
    } else if (token.kind === "punct") {
      if (token.text === "(") round++;
      else if (token.text === ")") round--;
      else if (token.text === "[") square++;
      else if (token.text === "]") square--;
      else if (token.text === "{") {
        // Prims, variant sets and variants open their own braces below; any other brace is a value (a dictionary).
        scopes.push({ prim: top.prim, path: top.path, value: true });
        fresh = true;
      } else if (token.text === "}") {
        if (scopes.length > 1) scopes.pop();
        fresh = true;
      }
      at++;
    } else if (statement && token.kind === "word" && ["def", "over", "class"].includes(token.text)) {
      at++;
      const type = is(at, "word") ? all[at++]!.text : "";
      const name = is(at, "string") ? all[at++]!.text : "?";
      const prim: Prim = { path: `${top.path}/${name}`, specifier: token.text, type, properties: new Set(), relationships: new Set(), arcs: [], facts: [], variantSets: new Map() };
      layer.prims.push(prim);
      lines();
      if (is(at, "punct", "(")) {
        block((key, from, to) => {
          if (ARCS.has(key)) {
            prim.arcs.push(`${key} ${clip(said(from, to), 240)}`);
            for (let index = from; index < to; index++) if (is(index, "asset")) layer.assets.add(all[index]!.text);
          } else if (["kind", "instanceable", "active", "apiSchemas", "variants", "hidden"].includes(key)) {
            prim.facts.push(`${key} ${clip(said(from, to), 160)}`);
          }
        });
        lines();
      }
      if (is(at, "punct", "{")) {
        scopes.push({ prim, path: prim.path, value: false });
        at++;
        fresh = true;
      }
    } else if (statement && top.prim && token.kind === "word" && token.text === "variantSet" && is(at + 1, "string")) {
      const variants: string[] = [];
      top.prim.variantSets.set(all[at + 1]!.text, variants);
      at += 2;
      if (is(at, "punct", "=")) at++;
      lines();
      if (is(at, "punct", "{")) {
        // Its direct children are `"name" { ... }`; each is collected as it is opened below.
        scopes.push({ prim: top.prim, path: top.path, value: false, variants });
        at++;
        fresh = true;
      }
    } else if (statement && token.kind === "string" && is(at + 1, "punct", "{") && top.variants) {
      top.variants.push(token.text);
      scopes.push({ prim: top.prim, path: top.path, value: false });
      at += 2;
      fresh = true;
    } else if (statement && top.prim && token.kind === "word" && /^[A-Za-z_]/.test(token.text)) {
      // A property: optional qualifiers, a type (perhaps an array), a name.
      let index = at;
      while (is(index, "word") && QUALIFIERS.has(all[index]!.text)) index++;
      const type = is(index, "word") ? all[index++]!.text : "";
      if (is(index, "punct", "[") && is(index + 1, "punct", "]")) index += 2;
      const name = is(index, "word") ? all[index]!.text : "";
      if (type === "rel" && name) top.prim.relationships.add(name);
      else if (name.endsWith(".timeSamples") && is(index + 1, "punct", "=") && is(index + 2, "punct", "{")) {
        const attribute = name.slice(0, -".timeSamples".length);
        top.prim.properties.add(attribute);
        const found: Animated = { name: `${top.prim.path}.${attribute}`, samples: 0, first: Infinity, last: -Infinity };
        let depth = 0;
        let nested = 0;
        let end = index + 2;
        for (; end < all.length; end++) {
          const next = all[end]!;
          if (next.kind === "punct" && next.text === "{") depth++;
          else if (next.kind === "punct" && next.text === "}") {
            if (--depth === 0) break;
          } else if (next.kind === "punct" && "([".includes(next.text)) nested++;
          else if (next.kind === "punct" && ")]".includes(next.text)) nested--;
          else if (depth === 1 && nested === 0 && next.kind === "word" && is(end + 1, "punct", ":") && Number.isFinite(Number(next.text))) {
            found.samples++;
            found.first = Math.min(found.first, Number(next.text));
            found.last = Math.max(found.last, Number(next.text));
          }
        }
        layer.animated.push(found);
        at = end + 1;
        continue;
      } else if (name && !name.includes(".connect")) top.prim.properties.add(name);
      at++;
    } else {
      if (token.kind === "asset") layer.assets.add(token.text);
      at++;
    }
  }
  return layer;
}

function readText(source: string, bytes: number, what = "A USD scene in text form"): string {
  const layer = layerOf(source);
  const by = (key: (prim: Prim) => string): string =>
    [...layer.prims.reduce((map, prim) => map.set(key(prim), (map.get(key(prim)) ?? 0) + 1), new Map<string, number>())]
      .sort((a, b) => b[1] - a[1])
      .map(([name, total]) => `${name} ${count(total)}`)
      .join(", ");
  const lines = [`${what} (usda ${layer.version}): ${count(layer.prims.length)} prim(s)${layer.prims.length ? ` (${by((prim) => prim.specifier)})` : ""}; ${size(bytes)}.`];
  if (layer.settings.length) lines.push(`Layer: ${layer.settings.join(", ")}.`);
  if (layer.sublayers.length) lines.push(`Sublayers: ${some(layer.sublayers, 20).shown.map((each) => `@${each}@`).join(", ")}${layer.sublayers.length > 20 ? ", …" : ""}.`);
  if (layer.prims.length) {
    lines.push(`Prims by type: ${by((prim) => prim.type || "(no type)")}.`);
    const { shown, rest } = some(layer.prims, LISTED, "more prim(s)");
    lines.push("Prims:");
    for (const prim of shown) {
      const facts = [
        prim.properties.size ? `${prim.properties.size} attribute(s)` : "",
        prim.relationships.size ? `${prim.relationships.size} relationship(s)` : "",
        ...prim.facts,
        ...prim.arcs,
        ...[...prim.variantSets].map(([name, variants]) => `variant set "${name}" (${variants.join(", ")})`),
      ].filter(Boolean);
      lines.push(`  ${prim.path} [${prim.specifier}${prim.type ? ` ${prim.type}` : ""}]${facts.length ? `: ${facts.join("; ")}` : ""}`);
    }
    if (rest) lines.push(`  ${rest}`);
  }
  if (layer.assets.size) {
    const { shown, rest } = some([...layer.assets], 30, "more");
    lines.push(`Files it refers to (${layer.assets.size}): ${shown.join(", ")}${rest ? `, ${rest}` : ""}.`);
  }
  if (layer.animated.length) {
    const total = layer.animated.reduce((sum, each) => sum + each.samples, 0);
    const first = Math.min(...layer.animated.map((each) => each.first));
    const last = Math.max(...layer.animated.map((each) => each.last));
    lines.push(`Animated attributes: ${count(layer.animated.length)}, with ${count(total)} time sample(s) in all${total ? `, from time ${first} to ${last}` : ""}.`);
    const { shown, rest } = some(layer.animated, 20, "more");
    for (const each of shown) lines.push(`  ${each.name}: ${count(each.samples)} sample(s)${each.samples ? `, time ${each.first} to ${each.last}` : ""}`);
    if (rest) lines.push(`  ${rest}`);
  }
  lines.push(
    "Not read: attribute values (mesh points, transforms, material inputs) are counted and not shown; the files this layer refers to were not opened, so what they add to the scene is not here.",
  );
  return lines.join("\n");
}

// ── The crate form ──────────────────────────────────────────────────────────

/** The names in a crate file: every prim, property, type and token value, in the order the writer met them. */
function crateTokens(bytes: Uint8Array, start: number, modern: boolean): { total: number; names: string[] } {
  const cursor = new Cursor(bytes, start);
  const total = cursor.size();
  let chars: Uint8Array;
  if (modern) {
    const unpacked = cursor.size();
    const packed = cursor.take(cursor.size());
    // One byte says how many LZ4 blocks follow; zero means a single block with no length before it.
    const blocks = packed[0]!;
    if (blocks === 0) chars = lz4Block(packed.subarray(1), unpacked);
    else {
      const parts: Uint8Array[] = [];
      const inner = new Cursor(packed, 1);
      for (let index = 0; index < blocks; index++) parts.push(lz4Block(inner.take(inner.i32()), unpacked));
      chars = Buffer.concat(parts);
    }
    if (chars.length !== unpacked) throw new Error("the token table did not unpack to the size it declares");
  } else {
    chars = cursor.take(cursor.size());
  }
  const names = utf8(chars).split("\0");
  if (names[names.length - 1] === "") names.pop();
  return { total, names };
}

function readCrate(bytes: Uint8Array, what = "A USD scene in binary crate form"): string {
  const version = `${bytes[8]}.${bytes[9]}.${bytes[10]}`;
  const lines = [`${what} (usdc, crate version ${version}); ${size(bytes.length)}.`];
  const unread: string[] = [];
  try {
    const cursor = new Cursor(bytes, 16);
    const toc = new Cursor(bytes, cursor.size());
    const sections = new Map<string, { start: number; size: number }>();
    const total = toc.size();
    if (total > 64) throw new Error("its table of contents is damaged");
    for (let index = 0; index < total; index++) {
      const name = latin1(toc.take(16)).replace(/\0.*$/, "");
      sections.set(name, { start: toc.size(), size: toc.size() });
    }
    lines.push(`Sections: ${[...sections].map(([name, section]) => `${name} ${size(section.size)}`).join(", ")}.`);
    // From crate version 0.4.0 the tables are compressed and each begins with its count.
    const modern = bytes[8]! > 0 || bytes[9]! >= 4;
    const counts: string[] = [];
    const paths = sections.get("PATHS");
    if (paths) counts.push(`${count(new Cursor(bytes, paths.start).size())} path(s) (prims and their properties)`);
    const specs = sections.get("SPECS");
    if (specs && modern) counts.push(`${count(new Cursor(bytes, specs.start).size())} spec(s)`);
    const named = sections.get("TOKENS");
    if (named) {
      try {
        const { total: declared, names } = crateTokens(bytes, named.start, modern);
        counts.push(`${count(declared)} name token(s)`);
        const { shown, rest } = some(names.filter((name) => name && name.length <= 80), 120, "more");
        lines.push(`It holds ${counts.join(", ")}.`);
        lines.push(`Names in it (prim, property and type names and token values, in no meaningful order): ${shown.join(", ")}${rest ? `, ${rest}` : ""}.`);
      } catch (err) {
        lines.push(`It holds ${[...counts, `${count(new Cursor(bytes, named.start).size())} name token(s)`].join(", ")}.`);
        unread.push(`the name tokens could not be unpacked (${(err as Error).message})`);
      }
    } else if (counts.length) lines.push(`It holds ${counts.join(", ")}.`);
  } catch (err) {
    unread.push(`its table of contents could not be read (${(err as Error).message})`);
  }
  unread.push(
    "the scene itself: which prims there are, their types, their hierarchy, references, attribute values and time samples are in compressed tables that are not decoded here. `usdcat` writes the text form, which is read in full",
  );
  lines.push(`Not read: ${unread.join("; ")}.`);
  return lines.join("\n");
}

// ── The package form ────────────────────────────────────────────────────────

const isLayer = (name: string): boolean => /\.usd[ac]?$/i.test(name);

function readPackage(bytes: Uint8Array): string {
  const members = membersOf(bytes);
  const lines = [`A USD package (usdz, a zip archive): ${count(members.length)} file(s); ${size(bytes.length)}.`];
  const { shown, rest } = some(members, 40, "more file(s)");
  lines.push(`Files: ${shown.map((member) => `${member.name} (${size(member.size)})`).join(", ")}${rest ? `, ${rest}` : ""}.`);
  const root: Member | undefined = members[0] && isLayer(members[0].name) ? members[0] : members.find((member) => isLayer(member.name));
  const others = members.filter((member) => member !== root);
  if (root) {
    try {
      const content = contentOf(bytes, root);
      lines.push(
        startsWith(content, CRATE)
          ? readCrate(content, `Its root layer, ${root.name}, is a USD scene in binary crate form`)
          : startsWith(content, TEXT)
            ? readText(utf8(content), content.length, `Its root layer, ${root.name}, is a USD scene in text form`)
            : `Its root layer, ${root.name}, is neither the text nor the crate form of USD and was not read.`,
      );
    } catch (err) {
      lines.push(`Not read: its root layer, ${root.name} (${(err as Error).message}).`);
    }
  } else {
    lines.push("Not read: it has no USD layer in it to read.");
  }
  if (others.length) lines.push(`Not read: the other ${count(others.length)} file(s) in the package (textures, further layers) were listed and not opened.`);
  return lines.join("\n");
}

/** Whether a zip archive is a USD package: its first file is a layer, as the format requires. */
function packaged(bytes: Uint8Array, declared: boolean): boolean {
  if (!isZip(bytes)) return false;
  if (declared) return true;
  try {
    const first = membersOf(bytes)[0];
    return first !== undefined && isLayer(first.name) && headOf(bytes, first, 8) !== undefined;
  } catch {
    return false;
  }
}

export const usd: Format = {
  name: "a USD scene",
  mimes: ["model/vnd.usda", "model/vnd.usdz+zip", "model/vnd.usd+zip", "model/vnd.usdc", "model/vnd.usd", "model/usd", "application/x-usd"],
  extensions: ["usd", "usda", "usdc", "usdz"],
  loose: ["text/plain", "application/zip", "application/x-zip-compressed"],
  sniff: (bytes, declared) => startsWith(bytes, TEXT) || startsWith(bytes, CRATE) || packaged(bytes, declared),
  read: (bytes) => (startsWith(bytes, TEXT) ? readText(utf8(bytes), bytes.length) : startsWith(bytes, CRATE) ? readCrate(bytes) : readPackage(bytes)),
};
