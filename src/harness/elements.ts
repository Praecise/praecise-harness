/**
 * A screen worked by what is on it instead of by where things are.
 *
 * `computer()` gives a model a picture and a pointer. This gives it the list a screen
 * reader is given: each thing on the screen with its kind, its name and a reference,
 * and actions that take the reference. A model that reads `button "Send" [ref_7]` and
 * clicks `ref_7` does not need a picture to find the button, and cannot miss it by a few
 * pixels.
 *
 * It is a second tool beside the first and not more actions on it, because an endpoint
 * that has a computer tool of its own knows that tool's members and no others. This one
 * is a plain function everywhere. The two share a screen, and an action that fails
 * through either stops the rest of the turn through both.
 *
 * A reference is only ever the thing it was read as. A screen refuses one whose element
 * has gone or changed, and nothing here retries it against a position.
 *
 * The guard is told what is being pressed. An action names the element's kind and name
 * as they were last read, which a click at a coordinate never could.
 */

import type { LocalTool, ToolContext } from "../compile/plan.js";
import type { Action, FunctionSpec } from "../define.js";
import { HALTED, haltsOf, type Button, type Point, type Region, type Screen, type ScreenElement } from "./computer.js";

export interface ElementsOptions {
  /** The tool's name. Default `"elements"`. */
  name?: string;
  /** Said after the tool's own description: what this screen is. */
  about?: string;
  /**
   * After an action, say which elements appeared, went or changed. On by default: it is
   * a few lines where a screenshot is a picture.
   */
  changes?: boolean;
  /** Milliseconds to let the screen settle before reading what changed. Default 400. */
  settleMs?: number;
  /** The most characters one reading may return. Default 50,000. */
  limit?: number;
}

export const ELEMENTS = "elements";

/** The most matches `find` returns. */
const MATCHES = 20;
/** The most lines said about what an action changed. */
const CHANGES = 24;

const ACTIONS: Record<string, { op: string; button?: Button; count?: number }> = {
  read: { op: "read" },
  read_page: { op: "read" },
  find: { op: "find" },
  text: { op: "text" },
  get_page_text: { op: "text" },
  click: { op: "click" },
  left_click: { op: "click", button: "left" },
  right_click: { op: "click", button: "right" },
  middle_click: { op: "click", button: "middle" },
  double_click: { op: "click", count: 2 },
  triple_click: { op: "click", count: 3 },
  hover: { op: "hover" },
  fill: { op: "fill" },
  form_input: { op: "fill" },
  scroll_to: { op: "scroll_to" },
};

const MODIFIERS = new Set(["shift", "ctrl", "control", "alt", "super", "meta", "cmd", "command"]);

function fail(message: string): never {
  throw new Error(message);
}

const clipped = (text: string, to: number): string => (text.length > to ? `${text.slice(0, to - 1)}…` : text);

/** An element in one line: `button "Send" (disabled) [ref_7]`. */
export function describeElement(element: ScreenElement): string {
  return (
    element.role +
    (element.name ? ` ${JSON.stringify(clipped(element.name, 200))}` : "") +
    (element.value ? ` = ${JSON.stringify(clipped(element.value, 200))}` : "") +
    (element.states?.length ? ` (${element.states.join(", ")})` : "") +
    ` [${element.ref}]`
  );
}

function flat(list: readonly ScreenElement[], into: ScreenElement[] = []): ScreenElement[] {
  for (const element of list) {
    into.push(element);
    if (element.children) flat(element.children, into);
  }
  return into;
}

function outline(list: readonly ScreenElement[], depth: number, lines: string[]): string[] {
  for (const element of list) {
    lines.push(`${"  ".repeat(depth)}${describeElement(element)}`);
    if (element.children) outline(element.children, depth + 1, lines);
  }
  return lines;
}

const centreOf = (box: Region): Point => ({ x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) });

const pause = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const cancelled = (): Error => (signal?.reason instanceof Error ? signal.reason : new Error("cancelled"));
    if (signal?.aborted) return reject(cancelled());
    const stop = (): void => {
      clearTimeout(timer);
      reject(cancelled());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal?.addEventListener("abort", stop, { once: true });
  });

function modifiersOf(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) return [];
  const named = value.toLowerCase().split("+").map((part) => part.trim()).filter(Boolean);
  const unknown = named.filter((part) => !MODIFIERS.has(part));
  if (unknown.length) fail(`"${unknown.join("+")}" is not a key that can be held during a click; use shift, ctrl, alt or super`);
  return named;
}

/** A reference, given as `ref` or as the `target` an endpoint's own browser tool gives. */
function refOf(args: Record<string, unknown>): string | undefined {
  const target = args.target;
  const given =
    typeof args.ref === "string"
      ? args.ref
      : typeof target === "object" && target !== null && typeof (target as { ref?: unknown }).ref === "string"
        ? (target as { ref: string }).ref
        : undefined;
  return given?.trim() || undefined;
}

/**
 * A screen's elements, as a tool a model can call.
 *
 * The screen has to be able to `read` and `locate`. What else it can do decides what is
 * offered: `fill` where it can replace a field's contents.
 */
export function elementsTool(screen: Screen, options: ElementsOptions = {}): LocalTool {
  const read = screen.read?.bind(screen) ?? fail("this screen cannot be read as elements: it has no `read`");
  const locate = screen.locate?.bind(screen) ?? fail("this screen cannot be read as elements: it has no `locate`");
  const name = options.name ?? ELEMENTS;
  const settle = Math.max(0, options.settleMs ?? 400);
  const limit = Math.max(1_000, options.limit ?? 50_000);
  const failed = haltsOf(screen);
  /** What each reference was when it was last read, for telling the guard what an action is on. */
  const known = new Map<string, { role: string; name?: string }>();

  const seen = (list: ScreenElement[]): ScreenElement[] => {
    for (const element of flat(list)) known.set(element.ref, { role: element.role, ...(element.name ? { name: element.name } : {}) });
    return list;
  };

  /** What can be worked now, by reference, each as the line it would be read as. */
  const snapshot = async (): Promise<Map<string, string>> =>
    new Map(seen(await read({ filter: "interactive" })).map((element) => [element.ref, describeElement(element)]));

  /** Run something that may change the screen, and say what it changed. */
  const changing = async (said: string, run: () => Promise<void>, signal?: AbortSignal): Promise<string> => {
    if (options.changes === false) {
      await run();
      return said;
    }
    const before = await snapshot();
    await run();
    if (settle) await pause(settle, signal);
    let after: Map<string, string>;
    try {
      after = await snapshot();
    } catch (err) {
      return `${said} What it changed could not be read: ${(err as Error).message}`;
    }
    const lines: string[] = [];
    for (const [ref, line] of after) {
      const was = before.get(ref);
      if (was === undefined) lines.push(`appeared: ${line}`);
      else if (was !== line) lines.push(`changed: ${line}`);
    }
    for (const [ref, line] of before) if (!after.has(ref)) lines.push(`gone: ${line}`);
    if (!lines.length) return `${said} Nothing that can be worked changed.`;
    const more = lines.length - CHANGES;
    return `${said}\n${lines.slice(0, CHANGES).join("\n")}${more > 0 ? `\nand ${more} more; read to see them all` : ""}`;
  };

  const act = async (args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> => {
    const asked = String(args.action ?? "");
    const action = ACTIONS[asked] ?? fail(`"${asked}" is not an action; the actions are read, find, text, click, hover, fill and scroll_to`);
    const ref = refOf(args);

    switch (action.op) {
      case "read": {
        const filter = args.filter === "interactive" ? "interactive" : args.filter === undefined || args.filter === "all" ? "all" : fail('`filter` is "interactive" or "all"');
        const depth = typeof args.depth === "number" && args.depth >= 1 ? Math.round(args.depth) : undefined;
        const there = seen(await read({ filter, ...(ref ? { ref } : {}), ...(depth ? { depth } : {}) }));
        if (!there.length) return filter === "interactive" ? "Nothing here can be pressed or typed into." : "Nothing is on the screen.";
        const text = outline(there, 0, []).join("\n");
        if (text.length > limit) {
          fail(
            `that is ${text.length} characters, more than the ${limit} one reading may return; ` +
              'read with `filter: "interactive"`, a smaller `depth`, or the `ref` of one part',
          );
        }
        return text;
      }

      case "find": {
        const words = typeof args.query === "string" ? args.query.toLowerCase().split(/\s+/).filter(Boolean) : [];
        if (!words.length) fail("`query` is what to look for: words from the element's kind, name or contents");
        const all = flat(seen(await read({ filter: "all" })));
        const found = all.filter((element) => {
          const hay = `${element.role} ${element.name ?? ""} ${element.value ?? ""}`.toLowerCase();
          return words.every((word) => hay.includes(word));
        });
        if (!found.length) return `Nothing on the screen matches "${words.join(" ")}".`;
        const more = found.length - MATCHES;
        return found.slice(0, MATCHES).map(describeElement).join("\n") + (more > 0 ? `\nand ${more} more; use more words` : "");
      }

      case "text": {
        const all = flat(seen(await read({ filter: "all", ...(ref ? { ref } : {}) })));
        const said = all.filter((element) => element.role === "text" && element.name).map((element) => element.name!);
        // A screen that marks no text as text is read by what its outermost named things are called.
        const lines = said.length ? said : all.filter((element) => element.name && !element.children?.length).map((element) => element.name!);
        if (!lines.length) return "There is no text on the screen.";
        const text = lines.join("\n");
        return text.length > limit ? `${text.slice(0, limit)}\n(cut at ${limit} characters of ${text.length}; give the \`ref\` of one part for the rest)` : text;
      }

      case "click": {
        if (!ref) fail("`ref` is the element to click, from read or find");
        const button = action.button ?? (["left", "right", "middle"] as const).find((each) => each === args.button) ?? "left";
        const count = action.count ?? (typeof args.count === "number" && args.count >= 1 && args.count <= 3 ? Math.round(args.count) : 1);
        const modifiers = modifiersOf(args.modifiers);
        let on = "";
        return changing(
          "",
          async () => {
            const element = await locate(ref);
            on = describeElement(element);
            // A screen that can press a thing without the pointer does, for a plain click.
            if (screen.activate && button === "left" && count === 1 && !modifiers.length) await screen.activate(ref);
            else await screen.click(inView(element), { button, count, modifiers });
          },
          signal,
        ).then((changed) => `Clicked ${on}${button === "left" ? "" : ` with the ${button} button`}${count > 1 ? ` ${count} times` : ""}.${changed}`);
      }

      case "hover": {
        if (!ref) fail("`ref` is the element to point at, from read or find");
        let on = "";
        return changing(
          "",
          async () => {
            const element = await locate(ref);
            await screen.move(inView(element));
            on = describeElement(element);
          },
          signal,
        ).then((changed) => `Pointing at ${on}.${changed}`);
      }

      case "fill": {
        if (!screen.fill) fail("this screen cannot fill a field; click it and type");
        if (!ref) fail("`ref` is the field to fill, from read or find");
        if (typeof args.value !== "string") fail("`value` is what the field should hold");
        const value = args.value;
        return changing(`Filled [${ref}] with ${value.length} character(s).`, () => screen.fill!(ref, value), signal);
      }

      case "scroll_to": {
        if (!ref) fail("`ref` is the element to bring into view, from read or find");
        const element = await locate(ref);
        const at = centreOf(element.box);
        return `${describeElement(element)} is in view at [${at.x}, ${at.y}].`;
      }

      default:
        return fail(`"${asked}" is not an action`);
    }
  };

  /** The middle of an element, which has to be on the screen to be pointed at. */
  const inView = (element: ScreenElement & { box: Region }): Point => {
    const at = centreOf(element.box);
    if (at.x < 0 || at.y < 0 || at.x >= screen.width || at.y >= screen.height) {
      fail(`${describeElement(element)} is not in view: its middle is at [${at.x}, ${at.y}] and the screen is ${screen.width} by ${screen.height}`);
    }
    return at;
  };

  const actions = ["read", "find", "text", "click", "hover", ...(screen.fill ? ["fill"] : []), "scroll_to"];

  return {
    name,
    description:
      "Read a screen as the things on it and work them by reference, without a picture. " +
      "`read` lists what is there, each as its kind, its name and a reference in brackets; " +
      '`filter: "interactive"` lists only what can be pressed or typed into. `find` looks for words. ' +
      "`click`, `hover`, `scroll_to`" +
      (screen.fill ? " and `fill`" : "") +
      " take a `ref`. A reference stops working when its element goes or changes: read again. " +
      "After an action you are told what appeared, went or changed." +
      (options.about ? ` ${options.about}` : ""),
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: actions, description: "What to do." },
        ref: { type: "string", description: "An element's reference, from read or find. For read and text: only that element and what is in it." },
        filter: { type: "string", enum: ["interactive", "all"], description: "For read. Default all." },
        depth: { type: "integer", description: "For read: how many levels down to go." },
        query: { type: "string", description: "For find: words from the element's kind, name or contents." },
        ...(screen.fill ? { value: { type: "string", description: "For fill: what the field should hold." } } : {}),
        button: { type: "string", enum: ["left", "right", "middle"], description: "For click. Default left." },
        count: { type: "integer", description: "For click: 2 for a double click, 3 for a triple. Default 1." },
        modifiers: { type: "string", description: 'For click: keys to hold meanwhile, e.g. "shift" or "ctrl+shift".' },
      },
      required: ["action"],
    },
    // Reading changes nothing, but a click may do anything, and it is one tool.
    effect: "write",
    // What a screen says of itself was written by whoever made what is on it.
    trust: "untrusted",
    action(args): Action {
      const asked = String(args.action ?? "");
      const op = ACTIONS[asked]?.op ?? fail(`"${asked}" is not an action`);
      const { action: _action, ...detail } = args;
      const ref = refOf(args);
      const on = ref ? known.get(ref) : undefined;
      return {
        operation: `elements.${op}`,
        detail: { ...detail, ...(on ? { role: on.role, ...(on.name ? { name: on.name } : {}) } : {}) },
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
 * The same tool as a function, for the places an app's functions go.
 *
 *     // functions/elements.ts
 *     export default elements(screen);
 *
 * Beside `computer(screen)` over the same screen, an agent reads and presses by
 * reference and looks at a picture only when what it needs is not in the list.
 */
export function elements(screen: Screen, options: ElementsOptions = {}): FunctionSpec {
  const tool = elementsTool(screen, options);
  return {
    kind: "function",
    description: tool.description,
    schema: tool.parameters,
    effect: tool.effect,
    trust: tool.trust,
    action: (args) => tool.action!(args),
    run: (args, opts) => tool.run(args, opts?.transcript ? { transcript: opts.transcript, signal: opts.signal } : undefined),
  };
}
