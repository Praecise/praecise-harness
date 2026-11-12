/**
 * Computer use: a model looking at a screen and working it with a pointer and keys.
 *
 * Two halves, and the line between them is the seam. A `Screen` is a driver — it can be
 * photographed, clicked, typed into — and says nothing about models. The tool made from
 * one here is the vocabulary a model drives it with, and it is a `LocalTool` like any
 * other: it passes the guard and the authority, its screenshots come back as
 * attachments on a tool result, and the loop that calls it has no idea it is special.
 * The framework ships one driver (a browser, in `browser.ts`); a desktop, a device or a
 * remote session is another `Screen` an app or a plugin supplies.
 *
 * The vocabulary is deliberately the one the endpoints that have a computer tool of
 * their own already speak: an `action`, a `coordinate` pair, `text`, a `scroll_direction`.
 * That is what lets one handler serve both ways the tool can reach a model. Sent as a
 * plain function it is described by the schema below, which any endpoint with tool
 * calling can use. Sent to an endpoint that declared its native tool
 * (`ModelProvider.computer`), the wire declares that tool instead and the calls arrive in
 * the same shape — so there is nothing to translate, and nothing that works on one path
 * and not the other.
 *
 * What a screen shows was not written by the app. The tool is therefore untrusted:
 * once it has returned anything, every later action in the conversation is marked
 * tainted for the guard and the authority, exactly as after reading an inbox.
 */

import type { LocalTool, ToolContext } from "../compile/plan.js";
import type { Action, FunctionSpec } from "../define.js";
import { attach } from "./modality.js";
import type { Attachment, Message } from "./types.js";

export type Button = "left" | "right" | "middle";

export interface Point {
  x: number;
  y: number;
}

/** A rectangle of the screen, in the same pixels as everything else. */
export interface Region extends Point {
  width: number;
  height: number;
}

/**
 * Something with a picture, a pointer and a keyboard.
 *
 * Coordinates everywhere are in the pixels of what `screenshot()` returns, with the
 * origin at the top left: a driver whose real display is larger than what it shows a
 * model does the scaling, in both directions, and nothing above it knows. Screenshots
 * should be within what the model reading them accepts as an image — an endpoint may
 * refuse a larger one rather than shrink it.
 *
 * The optional methods are the finer controls. A screen without them is complete; the
 * actions that need them are simply not offered to the model.
 */
export interface Screen {
  /** The size of what a screenshot shows. */
  readonly width: number;
  readonly height: number;
  /** A picture of the screen, or of one region of it enlarged to be read. */
  screenshot(region?: Region): Promise<Attachment>;
  move(to: Point): Promise<void>;
  /** Press and release at a point, `count` times; `modifiers` are held throughout. */
  click(at: Point, options: { button: Button; count: number; modifiers: string[] }): Promise<void>;
  /** Press the left button at one point and release it at another. */
  drag(from: Point, to: Point, modifiers: string[]): Promise<void>;
  /** Turn the wheel at a point: `dx` and `dy` in clicks of it, right and down positive. */
  scroll(at: Point, by: { dx: number; dy: number }, modifiers: string[]): Promise<void>;
  /** Type text as a keyboard would enter it. */
  type(text: string): Promise<void>;
  /** Press a key or a chord: `"Return"`, `"ctrl+s"`, `"shift+Tab"`. */
  key(combo: string): Promise<void>;
  /** Where the pointer is. */
  cursor(): Promise<Point>;
  /** Press a button where the pointer is, and leave it down. */
  press?(button: Button): Promise<void>;
  /** Release a button where the pointer is. */
  release?(button: Button): Promise<void>;
  /** Hold a key or chord down for a time. */
  hold?(combo: string, seconds: number, signal?: AbortSignal): Promise<void>;
  /** Go to an address, for a screen that is a browser. */
  open?(url: string): Promise<void>;
  close?(): Promise<void>;
}

export interface ComputerOptions {
  /** The tool's name. Default `"computer"`, which is also what an endpoint's own tool is called. */
  name?: string;
  /** Said after the tool's own description: what this screen is, where it starts. */
  about?: string;
  /**
   * Take a screenshot after every action that can change the screen, and return it with
   * the result. Off by default: a picture costs far more than a sentence, and a model
   * that wants one asks.
   */
  screenshotAfter?: boolean;
  /** Milliseconds to let the screen settle before that screenshot. Default 400. */
  settleMs?: number;
  /** The longest one `wait` may be, in seconds. Default 30. */
  maxWait?: number;
}

export const COMPUTER = "computer";

/** What is said for an action that was not run because one before it in the same turn failed. */
export const HALTED = "Not executed: an earlier computer action in this turn failed.";

/** The actions, by the name the handler knows each by, from every name a model may use for it. */
const ACTIONS: Record<string, { op: string; button?: Button; count?: number }> = {
  screenshot: { op: "screenshot" },
  zoom: { op: "zoom" },
  click: { op: "click" },
  left_click: { op: "click", button: "left" },
  right_click: { op: "click", button: "right" },
  middle_click: { op: "click", button: "middle" },
  double_click: { op: "click", count: 2 },
  triple_click: { op: "click", count: 3 },
  move: { op: "move" },
  mouse_move: { op: "move" },
  drag: { op: "drag" },
  left_click_drag: { op: "drag" },
  left_mouse_down: { op: "press" },
  left_mouse_up: { op: "release" },
  scroll: { op: "scroll" },
  type: { op: "type" },
  key: { op: "key" },
  hold_key: { op: "hold" },
  wait: { op: "wait" },
  cursor_position: { op: "cursor" },
  open: { op: "open" },
};

/** What a screen has to be able to do for each of an endpoint's own action names that not every screen can. */
const NEEDS: Record<string, keyof Screen> = {
  left_mouse_down: "press",
  left_mouse_up: "release",
  hold_key: "hold",
};

const MODIFIERS = new Set(["shift", "ctrl", "control", "alt", "super", "meta", "cmd", "command"]);

function fail(message: string): never {
  throw new Error(message);
}

function numberOf(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** A pair of numbers given as `[x, y]`, or as the same thing in a string, which is how some models write it. */
function pairOf(value: unknown): [number, number] | undefined {
  let list: unknown = value;
  if (typeof value === "string") {
    try {
      list = JSON.parse(value);
    } catch {
      list = value.split(/[\s,]+/).filter(Boolean);
    }
  }
  if (!Array.isArray(list) || list.length !== 2) return undefined;
  const x = numberOf(list[0]);
  const y = numberOf(list[1]);
  return x === undefined || y === undefined ? undefined : [x, y];
}

function pointOf(value: unknown, name: string, screen: Screen): Point {
  const pair = pairOf(value) ?? fail(`\`${name}\` has to be [x, y], in pixels of the screenshot`);
  const [x, y] = [Math.round(pair[0]), Math.round(pair[1])];
  if (x < 0 || y < 0 || x >= screen.width || y >= screen.height) {
    fail(`[${x}, ${y}] is off the screen, which is ${screen.width} by ${screen.height}; take a screenshot and read the position from it`);
  }
  return { x, y };
}

/** The modifier keys named in a `text` argument that is being used to hold keys rather than type them. */
function modifiersOf(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) return [];
  const named = value.toLowerCase().split("+").map((part) => part.trim()).filter(Boolean);
  const unknown = named.filter((part) => !MODIFIERS.has(part));
  if (unknown.length) fail(`"${unknown.join("+")}" is not a key that can be held during this action; use shift, ctrl, alt or super`);
  return named;
}

const pause = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason instanceof Error ? signal.reason : new Error("cancelled"));
    const stop = (): void => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("cancelled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal?.addEventListener("abort", stop, { once: true });
  });

/** The schema a model is given when the tool is sent as a plain function. */
function parametersFor(screen: Screen, maxWait: number): Record<string, unknown> {
  const actions = [
    "screenshot",
    "click",
    "double_click",
    "move",
    "drag",
    "scroll",
    "type",
    "key",
    "wait",
    "cursor_position",
    "zoom",
    ...(screen.press && screen.release ? ["left_mouse_down", "left_mouse_up"] : []),
    ...(screen.hold ? ["hold_key"] : []),
    ...(screen.open ? ["open"] : []),
  ];
  const pair = { type: "array", items: { type: "integer" }, minItems: 2, maxItems: 2 };
  return {
    type: "object",
    properties: {
      action: { type: "string", enum: actions, description: "What to do." },
      coordinate: { ...pair, description: "[x, y] in pixels of the screenshot, from the top left. Where to click, move, scroll, or end a drag." },
      start_coordinate: { ...pair, description: "[x, y] where a drag starts." },
      button: { type: "string", enum: ["left", "right", "middle"], description: "Which button, for click. Default left." },
      text: {
        type: "string",
        description:
          'For type: the text to enter. For key: a key or chord, e.g. "Return", "ctrl+s". ' +
          'For click, drag and scroll: keys to hold meanwhile, e.g. "shift".',
      },
      scroll_direction: { type: "string", enum: ["up", "down", "left", "right"] },
      scroll_amount: { type: "integer", description: "How many clicks of the wheel. Default 3." },
      duration: { type: "number", description: `Seconds, for wait${screen.hold ? " and hold_key" : ""}. At most ${maxWait}.` },
      repeat: { type: "integer", description: "How many times to press, for key. Default 1." },
      region: {
        type: "array",
        items: { type: "integer" },
        minItems: 4,
        maxItems: 4,
        description: "[x0, y0, x1, y1]: the part of the screen to enlarge, for zoom.",
      },
      ...(screen.open ? { url: { type: "string", description: "The address to go to, for open." } } : {}),
    },
    required: ["action"],
  };
}

/**
 * A screen, as a tool a model can call.
 *
 * Several actions in one turn run in the order they were asked for, and the first to
 * fail stops the rest: each of those is answered with a line saying it was not run,
 * because a click aimed at a screen that did not change as expected lands on whatever is
 * there instead.
 */
export function computerTool(screen: Screen, options: ComputerOptions = {}): LocalTool {
  const name = options.name ?? COMPUTER;
  const maxWait = Math.max(0, options.maxWait ?? 30);
  const settle = Math.max(0, options.settleMs ?? 400);
  /** The turns in which an action has failed, by the message that asked for them. */
  const failed = new WeakSet<Message>();

  const shown = async (said: string, changed: boolean, signal?: AbortSignal): Promise<unknown> => {
    if (!changed || !options.screenshotAfter) return said;
    if (settle) await pause(settle, signal);
    return attach(said, await screen.screenshot());
  };

  const act = async (args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> => {
    const asked = String(args.action ?? "");
    const action = ACTIONS[asked] ?? fail(`"${asked}" is not an action; the actions are ${Object.keys(ACTIONS).join(", ")}`);
    const needs = NEEDS[asked];
    if (needs && typeof screen[needs] !== "function") fail(`this screen cannot ${asked}`);

    switch (action.op) {
      case "screenshot":
        return attach(`The screen, ${screen.width} by ${screen.height}.`, await screen.screenshot());

      case "zoom": {
        const box = Array.isArray(args.region) ? args.region.map(numberOf) : [];
        const [x0, y0, x1, y1] = box;
        if (box.length !== 4 || x0 === undefined || y0 === undefined || x1 === undefined || y1 === undefined) {
          fail("`region` has to be [x0, y0, x1, y1], in pixels of the screenshot");
        }
        const left = Math.max(0, Math.min(x0, x1));
        const top = Math.max(0, Math.min(y0, y1));
        const width = Math.min(screen.width, Math.max(x0, x1)) - left;
        const height = Math.min(screen.height, Math.max(y0, y1)) - top;
        if (width < 1 || height < 1) fail("that region has no area on the screen");
        return attach(
          `The screen from [${left}, ${top}] to [${left + width}, ${top + height}], enlarged. Coordinates are still those of the full screenshot.`,
          await screen.screenshot({ x: left, y: top, width, height }),
        );
      }

      case "click": {
        const at = args.coordinate === undefined ? await screen.cursor() : pointOf(args.coordinate, "coordinate", screen);
        const button =
          action.button ?? (["left", "right", "middle"] as const).find((known) => known === args.button) ?? "left";
        const count = action.count ?? 1;
        await screen.click(at, { button, count, modifiers: modifiersOf(args.text) });
        return shown(`Clicked ${button}${count > 1 ? ` ${count} times` : ""} at [${at.x}, ${at.y}].`, true, signal);
      }

      case "move": {
        const to = pointOf(args.coordinate, "coordinate", screen);
        await screen.move(to);
        return shown(`Moved to [${to.x}, ${to.y}].`, true, signal);
      }

      case "drag": {
        const from = pointOf(args.start_coordinate, "start_coordinate", screen);
        const to = pointOf(args.coordinate, "coordinate", screen);
        await screen.drag(from, to, modifiersOf(args.text));
        return shown(`Dragged from [${from.x}, ${from.y}] to [${to.x}, ${to.y}].`, true, signal);
      }

      case "press":
        await screen.press!("left");
        return shown("Pressed the left button.", true, signal);

      case "release":
        await screen.release!("left");
        return shown("Released the left button.", true, signal);

      case "scroll": {
        const at = args.coordinate === undefined ? await screen.cursor() : pointOf(args.coordinate, "coordinate", screen);
        const direction = String(args.scroll_direction ?? "down");
        const amount = Math.max(1, Math.min(100, Math.round(numberOf(args.scroll_amount) ?? 3)));
        const by =
          direction === "up"
            ? { dx: 0, dy: -amount }
            : direction === "down"
              ? { dx: 0, dy: amount }
              : direction === "left"
                ? { dx: -amount, dy: 0 }
                : direction === "right"
                  ? { dx: amount, dy: 0 }
                  : fail("`scroll_direction` has to be up, down, left or right");
        await screen.scroll(at, by, modifiersOf(args.text));
        return shown(`Scrolled ${direction} ${amount} at [${at.x}, ${at.y}].`, true, signal);
      }

      case "type": {
        if (typeof args.text !== "string" || !args.text) fail("`text` is what to type, and it was empty");
        await screen.type(args.text);
        return shown(`Typed ${args.text.length} character(s).`, true, signal);
      }

      case "key": {
        if (typeof args.text !== "string" || !args.text.trim()) fail('`text` is the key to press, e.g. "Return" or "ctrl+s"');
        const times = Math.max(1, Math.min(100, Math.round(numberOf(args.repeat) ?? 1)));
        for (let at = 0; at < times; at++) await screen.key(args.text.trim());
        return shown(`Pressed ${args.text.trim()}${times > 1 ? ` ${times} times` : ""}.`, true, signal);
      }

      case "hold": {
        if (typeof args.text !== "string" || !args.text.trim()) fail("`text` is the key to hold");
        const held = Math.max(0, Math.min(maxWait, numberOf(args.duration) ?? 1));
        await screen.hold!(args.text.trim(), held, signal);
        return shown(`Held ${args.text.trim()} for ${held}s.`, true, signal);
      }

      case "wait": {
        const waited = Math.max(0, Math.min(maxWait, numberOf(args.duration) ?? 1));
        await pause(waited * 1000, signal);
        return `Waited ${waited}s.`;
      }

      case "cursor": {
        const at = await screen.cursor();
        return `The pointer is at [${at.x}, ${at.y}].`;
      }

      case "open": {
        if (!screen.open) fail("this screen cannot be sent to an address");
        if (typeof args.url !== "string" || !args.url.trim()) fail("`url` is the address to go to");
        await screen.open(args.url.trim());
        return shown(`Opened ${args.url.trim()}.`, true, signal);
      }

      default:
        return fail(`"${asked}" is not an action`);
    }
  };

  return {
    name,
    description:
      `Look at and work a screen that is ${screen.width} by ${screen.height} pixels. Take a screenshot to see it; ` +
      `positions are [x, y] in pixels of that screenshot, from the top left. Look before you act and after: ` +
      `what a click did is only known from the next screenshot. Use zoom to read something small.` +
      (options.about ? ` ${options.about}` : ""),
    parameters: parametersFor(screen, maxWait),
    // Most of what it does changes something, and nothing here can tell which click will.
    effect: "write",
    // What a screen shows was written by whoever made the page, not by the app.
    trust: "untrusted",
    native: {
      kind: "computer",
      width: screen.width,
      height: screen.height,
      without: Object.entries(NEEDS).flatMap(([member, method]) => (typeof screen[method] === "function" ? [] : [member])),
    },
    action(args): Action {
      const asked = String(args.action ?? "");
      const op = ACTIONS[asked]?.op ?? fail(`"${asked}" is not an action`);
      const { action: _action, ...detail } = args;
      return {
        operation: `computer.${op}`,
        ...(op === "open" && typeof args.url === "string" ? { counterparty: args.url } : {}),
        detail,
      };
    },
    async run(args, during?: ToolContext) {
      const turn = during?.transcript.at(-1);
      if (turn && failed.has(turn)) return HALTED;
      try {
        return await act(args, during?.signal);
      } catch (err) {
        if (turn) failed.add(turn);
        throw err;
      }
    },
  };
}

/**
 * The same tool as a function, for the places an app's functions go: `functions/`, a
 * plugin's `app.functions`, `createApp({ functions })`.
 *
 *     // functions/computer.ts
 *     export default computer(await browserScreen({ executable: "/usr/bin/chromium" }));
 *
 * An agent lists it under `tools` by the name it is filed under. An endpoint's own
 * computer tool is called `computer`, so that is the name to file it under where one is
 * declared.
 */
export function computer(screen: Screen, options: ComputerOptions = {}): FunctionSpec {
  const tool = computerTool(screen, options);
  return {
    kind: "function",
    description: tool.description,
    schema: tool.parameters,
    effect: tool.effect,
    trust: tool.trust,
    native: tool.native,
    action: (args) => tool.action!(args),
    run: (args, opts) =>
      tool.run(args, opts?.transcript ? { transcript: opts.transcript, signal: opts.signal } : undefined),
  };
}
