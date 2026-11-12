/// <reference types="node" />
// Declared here for the same reason as at the package root: this entry's declarations
// reach `define.ts`, which names `Buffer` and `node:*`, and whether those are in scope is
// the consumer's decision, not one a published .d.ts may rely on.

/**
 * `@praecise/harness/formats`: readers for the binary formats robots and scenes are
 * recorded in.
 *
 * The framework ships readers for what is already text (SenML, tensors as JSON, CSV,
 * glTF). What a robot actually writes is binary: a log in MCAP or a ROS bag, a dataset
 * in Parquet and Arrow, a cloud of points, a scene in USD, an array from NumPy. Reading
 * those means parsing containers, which is a few thousand lines an app that never sees a
 * robot should not load. So they are here, in the package and off by default, as a
 * plugin:
 *
 *   import { formats } from "@praecise/harness/formats";
 *   export default defineConfig({ plugins: [formats()] });
 *
 * Each is a reader in the ordinary sense: it turns an attachment into what a model can
 * read (what the thing is, how big, over what time, which channels or columns with
 * their types and counts, a bounded sample) and never the payload. The data is not
 * rewritten; a tool handed the same attachment gets every byte.
 *
 * Every rendering ends by saying what was not read. Nothing here has a dependency: the
 * parsers are written out, and where a container uses a compression Node does not have,
 * what is outside the compressed part is read and the rest is named.
 */

import type { Plugin } from "../define.js";
import { registerReader } from "../harness/modality.js";
import type { Attachment } from "../harness/types.js";
import { arrow } from "./arrow.js";
import type { Format } from "./bytes.js";
import { offered, readAs } from "./bytes.js";
import { lerobot } from "./lerobot.js";
import { mcap } from "./mcap.js";
import { npy } from "./npy.js";
import { parquet } from "./parquet.js";
import { pcd } from "./pcd.js";
import { ply } from "./ply.js";
import { rosbag, rosbag2 } from "./rosbag.js";
import { splat, splatPly } from "./splat.js";
import { usd } from "./usd.js";

/**
 * The formats, by the name an app turns one off with.
 *
 * In the order they are registered. A later registration is asked first, so the splat
 * reader sees a PLY file before the reader that would call it a point cloud.
 */
const FORMATS = {
  npy: [npy],
  usd: [usd],
  pointcloud: [pcd, ply],
  splat: [splatPly, splat],
  arrow: [arrow],
  parquet: [parquet],
  lerobot: [lerobot],
  rosbag: [rosbag, rosbag2],
  mcap: [mcap],
} satisfies Record<string, Format[]>;

export type FormatName = keyof typeof FORMATS;

/** The names `formats({ only })` and `formats({ except })` take. */
export const formatNames = Object.keys(FORMATS) as FormatName[];

export interface FormatsOptions {
  /** Register these and no others. */
  only?: readonly FormatName[];
  /** Register all but these. */
  except?: readonly FormatName[];
}

/** What has been registered in this process, so loading the plugin in two apps does not ask every reader twice. */
const REGISTERED = new Set<Format>();

/**
 * Register the readers directly, for an app that is built in code and has no config to
 * list a plugin in. Safe to call more than once.
 */
export function registerFormats(options: FormatsOptions = {}): void {
  for (const name of formatNames) {
    if (options.only && !options.only.includes(name)) continue;
    if (options.except?.includes(name)) continue;
    for (const format of FORMATS[name] as Format[]) {
      if (REGISTERED.has(format)) continue;
      REGISTERED.add(format);
      registerReader(
        format.name,
        (mime) => offered(format, mime),
        (attachment) => readAs(format, attachment),
      );
    }
  }
}

/**
 * The plugin: list it under `plugins` in `praecise.config.ts`, or in the `config` given
 * to `createApp`.
 */
export function formats(options: FormatsOptions = {}): Plugin {
  return { name: "formats", setup: () => registerFormats(options) };
}

/**
 * Render one attachment with these readers without registering anything: what a model
 * would be shown, or nothing if it is none of these formats. For a tool that wants the
 * summary itself, and for tests.
 */
export function describeAttachment(attachment: Attachment): string | undefined {
  for (const name of [...formatNames].reverse()) {
    for (const format of [...(FORMATS[name] as Format[])].reverse()) {
      if (!offered(format, attachment.mime)) continue;
      const shown = readAs(format, attachment);
      if (shown) return shown;
    }
  }
  return undefined;
}

export type { Format } from "./bytes.js";
export { arrow, lerobot, mcap, npy, parquet, pcd, ply, rosbag, rosbag2, splat, splatPly, usd };
