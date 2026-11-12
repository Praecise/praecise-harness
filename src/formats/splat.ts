/**
 * Gaussian splats: a scene as millions of soft ellipsoids, in the two forms it is passed
 * around in.
 *
 * The first is the PLY that 3D Gaussian Splatting training writes. It is an ordinary PLY
 * whose vertices carry a position, a rotation (`rot_0..3`), a scale stored as its
 * logarithm (`scale_0..2`), an opacity stored before its sigmoid, and colour as
 * spherical-harmonic coefficients (`f_dc_*`, `f_rest_*`). Read as a point cloud it would
 * be reported as points with sixty anonymous properties, so it is recognised here and
 * said for what it is, with opacity and scale turned back into the quantities they
 * stand for.
 *
 * The second is the `.splat` file web viewers load: no header, 32 bytes a splat
 * (position and scale as six floats, then colour and rotation as eight bytes). Having no
 * header it has no magic number either, so it is only read when the media type or the
 * file name says that is what it is.
 *
 * Other splat containers (`.spz`, `.ksplat`, compressed PLY) are not read.
 *
 * The PLY property names are those written by the reference 3D Gaussian Splatting
 * implementation; the 32-byte record is as written by `convert.py` in antimatter15/splat,
 * read on 2026-11-13.
 */

import { short, statsOf } from "../harness/modality.js";
import type { Format } from "./bytes.js";
import { count, size, viewOf } from "./bytes.js";
import type { Field } from "./points.js";
import { describePoints, SAMPLED } from "./points.js";
import type { Element, PlyHeader } from "./ply.js";
import { plyFields, plyHeaderOf } from "./ply.js";

/** The properties that make a PLY vertex a Gaussian and not a point. */
const GAUSSIAN = ["x", "y", "z", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"];

function gaussians(header: PlyHeader | undefined): Element | undefined {
  const vertex = header?.elements.find((element) => element.name === "vertex");
  const names = new Set(vertex?.properties.map((property) => property.name));
  return vertex && GAUSSIAN.every((name) => names.has(name)) ? vertex : undefined;
}

/** The first spherical-harmonic coefficient as the colour it gives when looked at straight on. */
const SH_C0 = 0.28209479177387814;
const clamp = (value: number): number => Math.min(1, Math.max(0, value));

/** What is said of opacity, scale and colour over evenly spaced splats: the ranges, and where most of the mass is. */
function appearance(fields: Map<string, Field>, reach: number): string[] {
  const looked = Math.min(reach, SAMPLED);
  const step = reach <= SAMPLED ? 1 : (reach - 1) / (SAMPLED - 1);
  const over = (name: string): number[] => {
    const field = fields.get(name);
    return field ? Array.from({ length: looked }, (_, index) => field.at(Math.round(index * step))) : [];
  };
  const lines: string[] = [];
  const opacity = statsOf(over("opacity"));
  if (opacity) lines.push(`Opacity (0 to 1): min ${short(opacity.min)}, max ${short(opacity.max)}, mean ${short(opacity.mean)}.`);
  const scales = ["scale_0", "scale_1", "scale_2"].map((name) => statsOf(over(name))).filter((each) => each !== undefined);
  if (scales.length === 3) {
    lines.push(
      `Scale (the radii of each ellipsoid, in scene units): smallest ${short(Math.min(...scales.map((each) => each.min)))}, ` +
        `largest ${short(Math.max(...scales.map((each) => each.max)))}, mean ${short(scales.reduce((total, each) => total + each.mean, 0) / 3)}.`,
    );
  }
  const colour = ["red", "green", "blue"].map((name) => statsOf(over(name))).filter((each) => each !== undefined);
  if (colour.length === 3) lines.push(`Mean colour (red, green, blue, 0 to 1): ${colour.map((each) => short(each.mean)).join(", ")}.`);
  return lines;
}

function readPly(bytes: Uint8Array): string | undefined {
  const header = plyHeaderOf(bytes);
  const vertex = gaussians(header);
  if (!header || !vertex) return undefined;
  const rest = vertex.properties.filter((property) => property.name.startsWith("f_rest_")).length;
  // Degree d has (d + 1)^2 coefficients per colour channel, one of which is f_dc.
  const degree = Math.sqrt(rest / 3 + 1) - 1;
  const lines = [
    `Gaussian splats in a PLY file (as 3D Gaussian Splatting training writes): ${count(vertex.count)} splat(s), ` +
      `${Number.isInteger(degree) ? `spherical harmonics of degree ${degree}` : `${rest} higher-order colour coefficients`} ` +
      `(${vertex.properties.length} properties a splat), stored as ${header.format}; ${size(bytes.length)}.`,
  ];
  const unread: string[] = [];
  const found = plyFields(bytes, header, vertex);
  if (found) {
    const raw = new Map(found.fields.map((field) => [field.name, field]));
    const position = ["x", "y", "z"].map((name) => raw.get(name)!);
    if (found.reach < vertex.count && header.format !== "ascii") {
      lines.push(`The file holds ${count(found.reach)} of the ${count(vertex.count)} splats its header promises: it is cut short.`);
    }
    lines.push(...describePoints(position, vertex.count, found.reach).lines);
    // Stored as a logit, a logarithm and a harmonic coefficient; said as what they mean.
    const derived = new Map<string, Field>([
      ["opacity", { name: "opacity", at: (index) => 1 / (1 + Math.exp(-raw.get("opacity")!.at(index))) }],
      ...["scale_0", "scale_1", "scale_2"].map((name): [string, Field] => [name, { name, at: (index) => Math.exp(raw.get(name)!.at(index)) }]),
      ...(["red", "green", "blue"] as const)
        .map((name, channel): [string, Field] | undefined => {
          const coefficient = raw.get(`f_dc_${channel}`);
          return coefficient ? [name, { name, at: (index) => clamp(0.5 + SH_C0 * coefficient.at(index)) }] : undefined;
        })
        .filter((entry) => entry !== undefined),
    ]);
    lines.push(...appearance(derived, found.reach));
  } else {
    unread.push("the splats could not be reached in this file's layout, so only the header is described");
  }
  unread.push("rotations and the higher-order colour coefficients are not summarised", "the splats themselves are summarised, not listed");
  lines.push(`Not read: ${unread.join("; ")}.`);
  return lines.join("\n");
}

/** One record of a `.splat` file. */
const RECORD = 32;

function readRaw(bytes: Uint8Array): string {
  const total = Math.floor(bytes.length / RECORD);
  const view = viewOf(bytes);
  const float = (name: string, offset: number): Field => ({ name, at: (index) => view.getFloat32(index * RECORD + offset, true) });
  const byte = (name: string, offset: number): Field => ({ name, at: (index) => view.getUint8(index * RECORD + offset) / 255 });
  const lines = [`Gaussian splats in the 32-byte .splat form: ${count(total)} splat(s); ${size(bytes.length)}.`];
  if (bytes.length % RECORD) lines.push(`The file is ${bytes.length % RECORD} bytes longer than a whole number of splats: it is cut short or is not this format.`);
  lines.push(...describePoints([float("x", 0), float("y", 4), float("z", 8)], total).lines);
  lines.push(
    ...appearance(
      new Map([float("scale_0", 12), float("scale_1", 16), float("scale_2", 20), byte("red", 24), byte("green", 25), byte("blue", 26), byte("opacity", 27)].map((field) => [field.name, field])),
      total,
    ),
  );
  lines.push(
    "Not read: rotations are not summarised; the splats themselves are summarised, not listed. This form keeps one colour a splat and no view-dependent colour.",
  );
  return lines.join("\n");
}

export const splatPly: Format = {
  name: "Gaussian splats",
  mimes: ["application/x-ply", "application/ply", "model/ply", "model/x-ply", "text/x-ply", "application/x-gaussian-splat+ply"],
  extensions: ["ply"],
  loose: ["text/plain"],
  // A PLY that is not splats is the PLY reader's, not an error of this one.
  shared: true,
  sniff: (bytes) => gaussians(plyHeaderOf(bytes)) !== undefined,
  read: readPly,
};

export const splat: Format = {
  name: "Gaussian splats",
  mimes: ["application/x-splat", "application/x-gaussian-splat", "model/x-splat", "model/splat"],
  extensions: ["splat"],
  sniff: (bytes, declared) => declared && bytes.length >= RECORD,
  read: readRaw,
};
