/**
 * Keyboard routing.
 *
 * Kept as one pure function because the bugs here are all about *context*,
 * not about any individual key: a shortcut that still drives the story while
 * a dialog is open, or an arrow key that scrolls the page instead of moving
 * through a settings dropdown. Both are invisible in a unit test of any
 * single handler and obvious in a table of (overlay, target, key).
 */

export type KeyAction =
  | "none"
  | "advance"
  | "openBacklog"
  | "closeBacklog"
  | "closeOverlay"
  | "closeRecords"
  | "toggleAuto"
  | "toggleBacklog"
  | "openSave"
  | "openLoad"
  | "quickSave"
  | "openRecords"
  | "openSettings"
  | "returnToTitle"
  | "skipOn"
  | "skipOff";

/**
 * Which surface owns the keyboard. Only one at a time; the caller resolves
 * precedence (a confirmation sits on top of whatever opened it).
 */
export type Overlay = "none" | "backlog" | "records" | "settings" | "menu" | "confirm" | "title";

export interface KeyContext {
  key: string;
  /** Lowercased tag name of the event target. */
  targetTag: string;
  /** True when the target is contentEditable. */
  targetEditable: boolean;
  overlay: Overlay;
}

export interface KeyDecision {
  action: KeyAction;
  /** Whether the browser's own handling should be suppressed. */
  preventDefault: boolean;
}

const NONE: KeyDecision = { action: "none", preventDefault: false };
const act = (action: KeyAction, preventDefault = false): KeyDecision => ({ action, preventDefault });

/**
 * Elements that own their own keys. A range slider and a select both use the
 * arrows, and a button uses Enter and Space; stealing those to drive the
 * story makes the settings panel unusable with a keyboard.
 */
const INTERACTIVE_TAGS = new Set(["input", "select", "textarea", "button", "option"]);

function targetOwnsKeys(ctx: KeyContext): boolean {
  return ctx.targetEditable || INTERACTIVE_TAGS.has(ctx.targetTag);
}

export function routeKeyDown(ctx: KeyContext): KeyDecision {
  const { key } = ctx;

  // Escape always reaches the app: it is how a keyboard user gets out of a
  // surface they opened, including out of a control that has focus.
  if (key === "Escape") {
    if (ctx.overlay === "records") return act("closeRecords");
    if (ctx.overlay === "backlog") return act("closeBacklog");
    if (ctx.overlay === "none" || ctx.overlay === "title") return act("none");
    return act("closeOverlay");
  }

  // A focused control keeps its own keys.
  if (targetOwnsKeys(ctx)) return NONE;

  switch (ctx.overlay) {
    case "records":
      return key === "r" || key === "R" ? act("closeRecords") : NONE;

    case "backlog":
      // Up again returns to the story, which is how the player got here.
      if (key === "ArrowUp" || key === "ArrowDown") return act("closeBacklog", true);
      if (key === "l" || key === "L") return act("closeBacklog");
      return NONE;

    // A dialog, a menu, the settings panel and the title screen all own the
    // keyboard completely. Nothing here may reach the story underneath.
    case "settings":
    case "menu":
    case "confirm":
    case "title":
      return NONE;

    case "none":
      break;
  }

  switch (key) {
    case "ArrowUp":
      return act("openBacklog", true);
    case "ArrowDown":
      return act("advance", true);
    case "Enter":
    case " ":
      return act("advance");
    case "a":
    case "A":
      return act("toggleAuto");
    case "l":
    case "L":
      return act("toggleBacklog");
    case "s":
    case "S":
      return act("openSave");
    case "d":
    case "D":
      return act("openLoad");
    case "q":
    case "Q":
      return act("quickSave");
    case "r":
    case "R":
      return act("openRecords");
    case "o":
    case "O":
      return act("openSettings");
    case "t":
    case "T":
      return act("returnToTitle");
    case "Control":
      return act("skipOn");
    default:
      return NONE;
  }
}

/** Ctrl release ends skip, wherever it happens. */
export function routeKeyUp(key: string): KeyDecision {
  return key === "Control" ? act("skipOff") : NONE;
}
