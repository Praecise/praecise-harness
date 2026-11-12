/**
 * Clouds, splats and scenes are shown to a model as where they are and what they hold.
 *
 * A point cloud is its fields, its count and the box around it; splats are the same with
 * their opacity and size; a USD scene is its prims, what it references and what moves.
 * Coordinates and attribute values are summarised or counted, never listed.
 */
import { describe, expect, it } from "vitest";

import { describeAttachment } from "../src/formats/index.js";
import { attachment, Bytes, lz4Literals, lzfLiterals, zip } from "./formats-helpers.js";

const read = (bytes: Uint8Array | string, name?: string, mime = "application/octet-stream"): string => describeAttachment(attachment(bytes, mime, name)) ?? "";

/** A grid of points on the plane z = 2, x from 0 to 9 and y from -4 to 5, with an intensity. */
const GRID = Array.from({ length: 100 }, (_, index) => ({ x: index % 10, y: Math.floor(index / 10) - 4, z: 2, intensity: index / 100 }));

const pcdHeader = (data: string, points = GRID.length, extra = ""): string =>
  `# .PCD v0.7 - Point Cloud Data file format\nVERSION 0.7\nFIELDS x y z intensity\nSIZE 4 4 4 4\nTYPE F F F F\nCOUNT 1 1 1 1\nWIDTH ${points}\nHEIGHT 1\nVIEWPOINT 0 0 0 1 0 0 0\nPOINTS ${points}\n${extra}DATA ${data}\n`;

const pcdBinary = (): Buffer => {
  const out = new Bytes().raw(pcdHeader("binary"));
  for (const point of GRID) out.f32(point.x).f32(point.y).f32(point.z).f32(point.intensity);
  return out.done();
};

describe("a PCD point cloud", () => {
  it("is described by its header and its bounds, in binary form", () => {
    const shown = read(pcdBinary(), "scan.pcd");
    expect(shown).toContain("A PCD point cloud (version 0.7): 100 point(s), unorganised, stored as binary");
    expect(shown).toContain("Fields: x (float32), y (float32), z (float32), intensity (float32); 16 bytes a point.");
    expect(shown).toContain("Bounds over all 100 points: x 0 to 9, y -4 to 5, z 2 to 2 (extent 9 x 9 x 0, centre 4.5, 0.5, 2).");
    expect(shown).toContain("  intensity: min 0, max 0.99, mean 0.495");
    expect(shown).toContain("First 5 point(s) (x, y, z, intensity):\n  0, -4, 2, 0\n  1, -4, 2, 0.01");
    expect(shown).toContain("the points themselves are summarised, not listed");
    // Five points are written out, not a hundred.
    expect(shown.split("\n").length).toBeLessThan(16);
  });

  it("reads the same cloud written as text", () => {
    const body = GRID.map((point) => `${point.x} ${point.y} ${point.z} ${point.intensity}`).join("\n");
    const shown = read(`${pcdHeader("ascii")}${body}\n`, undefined, "text/plain");
    expect(shown).toContain("stored as ascii");
    expect(shown).toContain("Bounds over all 100 points: x 0 to 9, y -4 to 5, z 2 to 2");
  });

  it("reads the compressed form, which is LZF over the points laid out a field at a time", () => {
    const columns = new Bytes();
    for (const field of ["x", "y", "z", "intensity"] as const) for (const point of GRID) columns.f32(point[field]);
    const packed = lzfLiterals(columns.done());
    const shown = read(new Bytes().raw(pcdHeader("binary_compressed")).u32(packed.length).u32(columns.length).raw(packed).done());
    expect(shown).toContain("stored as binary_compressed");
    expect(shown).toContain("Bounds over all 100 points: x 0 to 9, y -4 to 5, z 2 to 2");
    expect(shown).toContain("  intensity: min 0, max 0.99");
  });

  it("says a depth image is organised, counts the points with no return, and leaves a packed colour alone", () => {
    const out = new Bytes().raw("VERSION .7\nFIELDS x y z rgb\nSIZE 4 4 4 4\nTYPE F F F U\nCOUNT 1 1 1 1\nWIDTH 4\nHEIGHT 2\nPOINTS 8\nDATA binary\n");
    for (let index = 0; index < 8; index++) {
      const lost = index % 4 === 3;
      out.f32(lost ? Number.NaN : index).f32(lost ? Number.NaN : 1).f32(lost ? Number.NaN : 0.5).u32(0xff8040);
    }
    const shown = read(out.done());
    expect(shown).toContain("8 point(s), organised as 4 x 2 (an image-shaped cloud, as a depth camera gives)");
    expect(shown).toContain("x 0 to 6, y 1 to 1, z 0.5 to 0.5");
    expect(shown).toContain("2 of those points have no position (NaN or infinite)");
    expect(shown).toContain("rgb (packed, padding or multi-valued fields) are named but not summarised");
    expect(shown).not.toContain("16744512");
  });

  it("says when the file holds fewer points than its header promises", () => {
    const whole = pcdBinary();
    const shown = read(whole.subarray(0, whole.length - 16 * 40));
    expect(shown).toContain("The file holds 60 of the 100 points its header promises: it is cut short.");
    expect(shown).toContain("Bounds over 60 of the first 60 points");
  });

  it("samples a large cloud evenly, so a sweep's last points count as much as its first", () => {
    const total = 250_000;
    const out = new Bytes().raw(`VERSION 0.7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\nWIDTH ${total}\nHEIGHT 1\nPOINTS ${total}\nDATA binary\n`);
    const body = new Float32Array(total * 3);
    for (let index = 0; index < total; index++) body.set([index, 0, 0], index * 3);
    const shown = read(out.raw(Buffer.from(body.buffer)).done());
    expect(shown).toContain("Bounds over 100,000 evenly spaced points: x 0 to 249999");
  });

  it("does not take a text file that merely starts with the word VERSION", () => {
    expect(describeAttachment(attachment("VERSION 2 of the plan\nis attached.\n", "text/plain"))).toBeUndefined();
  });
});

const plyVertices = (format: string, extra = ""): string =>
  `ply\nformat ${format} 1.0\ncomment made by a scanner\nelement vertex 4\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\n${extra}end_header\n`;

const CORNERS = [
  [0, 0, 0, 255],
  [2, 0, 0, 0],
  [2, 3, 0, 0],
  [0, 3, -1, 10],
] as const;

describe("a PLY model", () => {
  it("is described by its elements, properties and bounds, in text form", () => {
    const shown = read(`${plyVertices("ascii")}${CORNERS.map((corner) => corner.join(" ")).join("\n")}\n`, "cloud.ply", "text/plain");
    expect(shown).toContain("A PLY point cloud: 4 vertex; stored as text");
    expect(shown).toContain("Properties of vertex: x (float), y (float), z (float), red (uchar).");
    expect(shown).toContain("Comments: made by a scanner");
    expect(shown).toContain("Bounds over all 4 points: x 0 to 2, y 0 to 3, z -1 to 0");
    expect(shown).toContain("  red: min 0, max 255");
  });

  it("reads both byte orders of the binary form", () => {
    const little = new Bytes().raw(plyVertices("binary_little_endian"));
    for (const [x, y, z, red] of CORNERS) little.f32(x).f32(y).f32(z).u8(red);
    expect(read(little.done())).toContain("Bounds over all 4 points: x 0 to 2, y 0 to 3, z -1 to 0");

    const big = Buffer.alloc(4 * 13);
    CORNERS.forEach(([x, y, z, red], index) => {
      big.writeFloatBE(x, index * 13);
      big.writeFloatBE(y, index * 13 + 4);
      big.writeFloatBE(z, index * 13 + 8);
      big.writeUInt8(red, index * 13 + 12);
    });
    const shown = read(Buffer.concat([Buffer.from(plyVertices("binary_big_endian")), big]));
    expect(shown).toContain("stored as big-endian binary");
    expect(shown).toContain("Bounds over all 4 points: x 0 to 2, y 0 to 3, z -1 to 0");
  });

  it("counts a mesh's faces from the header and says they were not read", () => {
    const header = plyVertices("ascii", "element face 2\nproperty list uchar int vertex_indices\n");
    const shown = read(`${header}${CORNERS.map((corner) => corner.join(" ")).join("\n")}\n3 0 1 2\n3 0 2 3\n`);
    expect(shown).toContain("A PLY mesh: 4 vertex, 2 face");
    expect(shown).toContain("Properties of face: vertex_indices (list of int).");
    expect(shown).toContain("the face data is counted from the header and not read");
  });

  it("says when vertices cannot be reached behind a list, and still gives the header", () => {
    const header = "ply\nformat binary_little_endian 1.0\nelement face 1\nproperty list uchar int vertex_indices\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n";
    const shown = read(new Bytes().raw(header).u8(3).i32(0).i32(0).i32(0).f32(1).f32(2).f32(3).done());
    expect(shown).toContain("1 face, 1 vertex");
    expect(shown).toContain("the vertices could not be reached, because an element with list properties is stored before them");
    expect(shown).not.toContain("Bounds");
  });
});

const SPLAT_PROPERTIES = ["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2", ...Array.from({ length: 9 }, (_, index) => `f_rest_${index}`), "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"];

describe("Gaussian splats", () => {
  it("in a PLY file are said for what they are, with opacity and scale as the quantities they stand for", () => {
    const header = `ply\nformat binary_little_endian 1.0\nelement vertex 3\n${SPLAT_PROPERTIES.map((name) => `property float ${name}`).join("\n")}\nend_header\n`;
    const out = new Bytes().raw(header);
    const splats = [
      { at: [0, 0, 0], opacity: 0, scale: Math.log(0.5) },
      { at: [4, 2, -1], opacity: 10, scale: Math.log(2) },
      { at: [-4, 1, 1], opacity: -10, scale: 0 },
    ];
    for (const splat of splats) {
      const values: Record<string, number> = { x: splat.at[0]!, y: splat.at[1]!, z: splat.at[2]!, opacity: splat.opacity, scale_0: splat.scale, scale_1: splat.scale, scale_2: splat.scale, rot_0: 1, f_dc_0: 0, f_dc_1: 1.7724538509055159, f_dc_2: -1.7724538509055159 };
      for (const name of SPLAT_PROPERTIES) out.f32(values[name] ?? 0);
    }
    const shown = read(out.done(), "point_cloud.ply");
    expect(shown).toContain("Gaussian splats in a PLY file (as 3D Gaussian Splatting training writes): 3 splat(s), spherical harmonics of degree 1 (26 properties a splat)");
    expect(shown).toContain("Bounds over all 3 points: x -4 to 4, y 0 to 2, z -1 to 1");
    // Stored as -10, 0 and 10 before the sigmoid.
    expect(shown).toContain("Opacity (0 to 1): min 0.000045398, max 0.99995, mean 0.5.");
    // Stored as logarithms.
    expect(shown).toContain("Scale (the radii of each ellipsoid, in scene units): smallest 0.5, largest 2,");
    // 0.5 + 0.2820948 * f_dc: 0.5, 1 and 0.
    expect(shown).toContain("Mean colour (red, green, blue, 0 to 1): 0.5, 1, 0.");
    expect(shown).toContain("rotations and the higher-order colour coefficients are not summarised");
    // Not sixty anonymous fields.
    expect(shown).not.toContain("f_rest_3");
  });

  it("an ordinary PLY is not taken for splats", () => {
    const shown = read(`${plyVertices("ascii")}${CORNERS.map((corner) => corner.join(" ")).join("\n")}\n`);
    expect(shown).toContain("A PLY point cloud");
    expect(shown).not.toContain("Gaussian");
  });

  it("in the 32-byte .splat form are counted and bounded, when the file says that is what it is", () => {
    const out = new Bytes();
    out.f32(0).f32(0).f32(0).f32(0.1).f32(0.1).f32(0.1).raw(Buffer.from([255, 0, 0, 255, 128, 128, 128, 255]));
    out.f32(10).f32(-2).f32(6).f32(0.5).f32(0.2).f32(0.3).raw(Buffer.from([0, 255, 0, 51, 128, 128, 128, 255]));
    const bytes = out.done();
    const shown = read(bytes, "garden.splat");
    expect(shown).toContain("Gaussian splats in the 32-byte .splat form: 2 splat(s); 64 B.");
    expect(shown).toContain("Bounds over all 2 points: x 0 to 10, y -2 to 0, z 0 to 6");
    expect(shown).toContain("Opacity (0 to 1): min 0.2, max 1, mean 0.6.");
    expect(shown).toContain("Scale (the radii of each ellipsoid, in scene units): smallest 0.1, largest 0.5");
    expect(shown).toContain("Mean colour (red, green, blue, 0 to 1): 0.5, 0.5, 0.");
    expect(read(bytes, undefined, "application/x-splat")).toContain("2 splat(s)");
    // It has no magic number, so bytes nobody called splats are not claimed.
    expect(describeAttachment(attachment(bytes, "application/octet-stream"))).toBeUndefined();
    expect(describeAttachment(attachment(bytes, "application/octet-stream", "weights.bin"))).toBeUndefined();
  });

  it("says when a .splat file is not a whole number of records", () => {
    expect(read(Buffer.alloc(70), "cut.splat")).toContain("6 bytes longer than a whole number of splats");
  });
});

const SCENE = `#usda 1.0
(
    defaultPrim = "World"
    endTimeCode = 48
    metersPerUnit = 0.01
    startTimeCode = 1
    timeCodesPerSecond = 24
    upAxis = "Z"
    subLayers = [
        @./lights.usda@
    ]
)

def Xform "World" (
    kind = "assembly"
)
{
    def Cube "Box"
    {
        double size = 2
        # a comment with a { brace and a "quote
        string note = "braces } in a string { do not count"
        double3 xformOp:translate.timeSamples = {
            1: (0.1, 0, 0),
            24: (2.4, 0, 0),
            48: (4.8, 0, 0),
        }
        uniform token[] xformOpOrder = ["xformOp:translate"]
    }

    def Mesh "Ground"
    {
        int[] faceVertexCounts = [4]
        int[] faceVertexIndices = [0, 1, 2, 3]
        point3f[] points = [
            (0, 0, 0),
            (1, 0, 0),
            (1, 1, 0),
            (0, 1, 0)
        ]
    }

    def Xform "Arm" (
        customData = {
            dictionary notes = {
                int a = 1
            }
        }
        prepend payload = @./robots/arm_payload.usdc@
        prepend references = @./robots/arm.usd@</Arm>
        variants = {
            string gripper = "suction"
        }
        prepend variantSets = "gripper"
    )
    {
        custom rel target
        prepend rel target = </World/Box>
        variantSet "gripper" = {
            "parallel" {
                def Xform "parallel_tool"
                {
                }

            }
            "suction" {
                def Xform "suction_tool"
                {
                }

            }
        }
    }

    over "Override"
    {
    }
}

class "_class_Thing"
{
}
`;

/** A crate file with a header, a table of contents, and the three sections whose counts are read. */
const crate = (): Buffer => {
  const names = ["World", "Xform", "xformOp:translate", "Mesh", "points"];
  const chars = Buffer.from(`${names.join("\0")}\0`);
  // One byte for "a single block", then the block.
  const packed = Buffer.concat([Buffer.from([0]), lz4Literals(chars)]);
  const tokens = new Bytes().u64(names.length).u64(chars.length).u64(packed.length).raw(packed).done();
  const paths = new Bytes().u64(9).raw(Buffer.alloc(24)).done();
  const specs = new Bytes().u64(7).raw(Buffer.alloc(24)).done();
  const start = 24;
  const sections: [string, Buffer][] = [["TOKENS", tokens], ["PATHS", paths], ["SPECS", specs]];
  const body = Buffer.concat(sections.map(([, bytes]) => bytes));
  const toc = new Bytes().u64(sections.length);
  let at = start;
  for (const [name, bytes] of sections) {
    toc.raw(Buffer.concat([Buffer.from(name), Buffer.alloc(16 - name.length)])).u64(at).u64(bytes.length);
    at += bytes.length;
  }
  return new Bytes().raw("PXR-USDC").raw(Buffer.from([0, 8, 0, 0, 0, 0, 0, 0])).u64(start + body.length).raw(body).raw(toc.done()).done();
};

describe("a USD scene", () => {
  it("in text form is its layer settings and every prim with its type and path", () => {
    const shown = read(SCENE, "scene.usda", "text/plain");
    expect(shown).toContain("A USD scene in text form (usda 1.0): 8 prim(s) (def 6, over 1, class 1)");
    expect(shown).toContain('Layer: defaultPrim "World", endTimeCode 48, metersPerUnit 0.01, startTimeCode 1, timeCodesPerSecond 24, upAxis "Z".');
    expect(shown).toContain("Sublayers: @./lights.usda@.");
    expect(shown).toContain("Prims by type: Xform 4, (no type) 2, Cube 1, Mesh 1.");
    expect(shown).toContain('  /World [def Xform]: kind "assembly"');
    expect(shown).toContain("  /World/Box [def Cube]: 4 attribute(s)");
    expect(shown).toContain("  /World/Ground [def Mesh]: 3 attribute(s)");
    expect(shown).toContain("  /World/Override [over]");
    expect(shown).toContain("  /_class_Thing [class]");
  });

  it("says what a prim references, pulls in and varies over, and puts a variant's prims under it", () => {
    const shown = read(SCENE, "scene.usda");
    expect(shown).toContain("  /World/Arm [def Xform]: 1 relationship(s);");
    expect(shown).toContain("payload @./robots/arm_payload.usdc@");
    expect(shown).toContain("references @./robots/arm.usd@ </Arm>");
    expect(shown).toContain('variant set "gripper" (parallel, suction)');
    expect(shown).toContain("  /World/Arm/parallel_tool [def Xform]");
    expect(shown).toContain("Files it refers to (3): ./lights.usda, ./robots/arm_payload.usdc, ./robots/arm.usd.");
  });

  it("summarises what is animated, and counts attribute values without showing them", () => {
    const shown = read(SCENE, "scene.usda");
    expect(shown).toContain("Animated attributes: 1, with 3 time sample(s) in all, from time 1 to 48.");
    expect(shown).toContain("  /World/Box.xformOp:translate: 3 sample(s), time 1 to 48");
    expect(shown).toContain("Not read: attribute values (mesh points, transforms, material inputs) are counted and not shown");
    expect(shown).not.toContain("(1, 1, 0)");
    expect(shown).not.toContain("2.4");
  });

  it("in crate form is its version, its sections, its counts and its names, with a plain statement of what is not decoded", () => {
    const shown = read(crate(), "scene.usdc");
    expect(shown).toContain("A USD scene in binary crate form (usdc, crate version 0.8.0)");
    expect(shown).toContain("Sections: TOKENS");
    expect(shown).toContain("It holds 9 path(s) (prims and their properties), 7 spec(s), 5 name token(s).");
    expect(shown).toContain("World, Xform, xformOp:translate, Mesh, points.");
    expect(shown).toContain("Not read: the scene itself: which prims there are, their types, their hierarchy");
    // A crate file under the extension both forms share.
    expect(read(crate(), "scene.usd")).toContain("binary crate form");
  });

  it("still describes a crate file whose tables it cannot follow", () => {
    const bytes = crate();
    const shown = read(bytes.subarray(0, 60), "cut.usdc");
    expect(shown).toContain("crate version 0.8.0");
    expect(shown).toContain("its table of contents could not be read");
  });

  it("as a package lists its files and reads its root layer, whichever form that is", () => {
    const texture = Buffer.alloc(300, 7);
    const text = read(zip([{ name: "scene.usda", data: Buffer.from(SCENE) }, { name: "textures/wood.png", data: texture }]), "scene.usdz");
    expect(text).toContain("A USD package (usdz, a zip archive): 2 file(s)");
    expect(text).toContain("Files: scene.usda (");
    expect(text).toContain("textures/wood.png (300 B)");
    expect(text).toContain("Its root layer, scene.usda, is a USD scene in text form (usda 1.0): 8 prim(s)");
    expect(text).toContain("the other 1 file(s) in the package (textures, further layers) were listed and not opened");

    const binary = read(zip([{ name: "scene.usdc", data: crate() }]), undefined, "model/vnd.usdz+zip");
    expect(binary).toContain("Its root layer, scene.usdc, is a USD scene in binary crate form");
    // Told by what is in it, under a media type that only says "zip".
    expect(read(zip([{ name: "scene.usdc", data: crate() }]), undefined, "application/zip")).toContain("A USD package");
    expect(describeAttachment(attachment(zip([{ name: "readme.txt", data: Buffer.from("hi") }]), "application/zip"))).toBeUndefined();
  });
});
