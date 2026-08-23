import { describe, expect, it } from "vitest";
import { routeKeyDown, routeKeyUp, type KeyContext, type Overlay } from "../src/keys.js";
import { AutosaveGate, shouldAutosaveOnSceneChange } from "../src/autosave.js";

/**
 * The keyboard bugs worth testing are all about context: a shortcut that
 * still drives the story from under a dialog, or an arrow key stolen from a
 * settings dropdown. Both are invisible when a handler is tested alone.
 */

const ctx = (key: string, over: Partial<KeyContext> = {}): KeyContext => ({
  key,
  targetTag: "div",
  targetEditable: false,
  overlay: "none",
  ...over,
});
const action = (key: string, over: Partial<KeyContext> = {}) => routeKeyDown(ctx(key, over)).action;

const GAMEPLAY_KEYS = ["ArrowUp", "ArrowDown", " ", "Enter", "a", "l", "s", "d", "q", "r", "o", "t"];
const MODAL: Overlay[] = ["settings", "menu", "confirm", "title"];

describe("during play", () => {
  it("advances on the keys a reader reaches for", () => {
    expect(action("ArrowDown")).toBe("advance");
    expect(action(" ")).toBe("advance");
    expect(action("Enter")).toBe("advance");
  });

  it("opens the backlog with up, and closes it with up again", () => {
    expect(action("ArrowUp")).toBe("openBacklog");
    expect(action("ArrowUp", { overlay: "backlog" })).toBe("closeBacklog");
  });

  it("also leaves the backlog with down, Escape or L", () => {
    expect(action("ArrowDown", { overlay: "backlog" })).toBe("closeBacklog");
    expect(action("Escape", { overlay: "backlog" })).toBe("closeBacklog");
    expect(action("l", { overlay: "backlog" })).toBe("closeBacklog");
  });

  it("never advances the story from inside the backlog", () => {
    for (const k of [" ", "Enter", "t", "s", "d", "q"]) {
      expect(action(k, { overlay: "backlog" }), `${k} in backlog`).toBe("none");
    }
  });

  it("stops the page scrolling when the arrows mean something", () => {
    expect(routeKeyDown(ctx("ArrowUp")).preventDefault).toBe(true);
    expect(routeKeyDown(ctx("ArrowDown")).preventDefault).toBe(true);
    expect(routeKeyDown(ctx("ArrowUp", { overlay: "backlog" })).preventDefault).toBe(true);
    // and leaves keys it does not claim to the browser
    expect(routeKeyDown(ctx("Tab")).preventDefault).toBe(false);
  });

  it("maps the letter shortcuts", () => {
    expect(action("a")).toBe("toggleAuto");
    expect(action("A")).toBe("toggleAuto");
    expect(action("l")).toBe("toggleBacklog");
    expect(action("s")).toBe("openSave");
    expect(action("d")).toBe("openLoad");
    expect(action("q")).toBe("quickSave");
    expect(action("r")).toBe("openRecords");
    expect(action("o")).toBe("openSettings");
    expect(action("t")).toBe("returnToTitle");
    expect(action("Control")).toBe("skipOn");
    expect(routeKeyUp("Control").action).toBe("skipOff");
    expect(routeKeyUp("a").action).toBe("none");
  });
});

describe("while a modal surface is open", () => {
  it("runs no gameplay shortcut behind Settings, Save/Load, a dialog or the title", () => {
    for (const overlay of MODAL) {
      for (const key of GAMEPLAY_KEYS) {
        expect(action(key, { overlay }), `${key} behind ${overlay}`).toBe("none");
      }
    }
  });

  it("in particular never advances the story or returns to the title", () => {
    for (const overlay of MODAL) {
      expect(action("ArrowDown", { overlay })).not.toBe("advance");
      expect(action(" ", { overlay })).not.toBe("advance");
      expect(action("t", { overlay })).not.toBe("returnToTitle");
    }
  });

  it("closes the surface on Escape instead", () => {
    for (const overlay of ["settings", "menu", "confirm"] as Overlay[]) {
      expect(action("Escape", { overlay })).toBe("closeOverlay");
    }
    // the title screen is the resting state, not something to escape from
    expect(action("Escape", { overlay: "title" })).toBe("none");
    expect(action("Escape")).toBe("none");
  });

  it("keeps RECORDS modal, closing on Escape or R only", () => {
    expect(action("Escape", { overlay: "records" })).toBe("closeRecords");
    expect(action("r", { overlay: "records" })).toBe("closeRecords");
    expect(action("R", { overlay: "records" })).toBe("closeRecords");
    for (const k of ["ArrowDown", " ", "Enter", "t"]) {
      expect(action(k, { overlay: "records" }), `${k} in records`).toBe("none");
    }
  });
});

describe("when a control has focus", () => {
  const CONTROLS = ["input", "select", "textarea", "button", "option"];

  it("leaves its keys to the browser, so sliders and dropdowns work", () => {
    for (const tag of CONTROLS) {
      for (const key of ["ArrowUp", "ArrowDown", " ", "Enter"]) {
        const d = routeKeyDown(ctx(key, { targetTag: tag, overlay: "settings" }));
        expect(d.action, `${key} on <${tag}>`).toBe("none");
        expect(d.preventDefault, `${key} on <${tag}> must not be swallowed`).toBe(false);
      }
    }
  });

  it("does the same for an editable element", () => {
    const d = routeKeyDown(ctx("ArrowUp", { targetTag: "div", targetEditable: true }));
    expect(d.action).toBe("none");
    expect(d.preventDefault).toBe(false);
  });

  it("does the same during play, not only inside a panel", () => {
    // the in-game control row is made of buttons; Space must press the
    // focused button rather than advance the story behind it
    expect(action(" ", { targetTag: "button" })).toBe("none");
    expect(action("ArrowDown", { targetTag: "button" })).toBe("none");
  });

  it("still lets Escape out of a focused control", () => {
    expect(action("Escape", { targetTag: "select", overlay: "settings" })).toBe("closeOverlay");
    expect(action("Escape", { targetTag: "input", overlay: "confirm" })).toBe("closeOverlay");
  });
});

describe("autosave policy", () => {
  it("does not autosave the scene a session starts in", () => {
    expect(shouldAutosaveOnSceneChange("new", 0)).toBe(false);
    expect(shouldAutosaveOnSceneChange("restore", 0)).toBe(false);
  });

  it("autosaves genuine scene transitions afterwards", () => {
    for (const start of ["new", "restore"] as const) {
      expect(shouldAutosaveOnSceneChange(start, 1)).toBe(true);
      expect(shouldAutosaveOnSceneChange(start, 2)).toBe(true);
      expect(shouldAutosaveOnSceneChange(start, 99)).toBe(true);
    }
  });

  it("means a rewind or a load cannot overwrite the autosave by itself", () => {
    // restore() enters a scene as part of restoring; that entry is index 0
    // and must not be mistaken for the player travelling somewhere
    expect(shouldAutosaveOnSceneChange("restore", 0)).toBe(false);
  });
});

describe("the autosave gate, in the order a session actually uses it", () => {
  /**
   * Regression: the counter used to be reset *after* the GameSession was
   * constructed. Both start() and restore() enter a scene from inside that
   * call, so the reset landed too late - the session's own entry was numbered
   * as a real transition and the next real one was suppressed in its place,
   * losing the autosave for a whole scene after every rewind. Pure policy
   * tests cannot see this; the ordering is the bug.
   */
  it("suppresses the session's own scene entry and autosaves the next", () => {
    const gate = new AutosaveGate();
    gate.begin("restore");              // before GameSession.restore(...)
    expect(gate.sceneEntered(), "restore's own scene entry").toBe(false);
    expect(gate.sceneEntered(), "the first genuine transition").toBe(true);
    expect(gate.sceneEntered()).toBe(true);
  });

  it("does the same for a new game", () => {
    const gate = new AutosaveGate();
    gate.begin("new");
    expect(gate.sceneEntered(), "the opening scene").toBe(false);
    expect(gate.sceneEntered()).toBe(true);
  });

  it("re-arms cleanly for each session, so a rewind mid-run still works", () => {
    const gate = new AutosaveGate();
    gate.begin("new");
    gate.sceneEntered();                // opening
    expect(gate.sceneEntered()).toBe(true);
    expect(gate.sceneEntered()).toBe(true);
    // the player rewinds: a new session begins
    gate.begin("restore");
    expect(gate.sceneEntered(), "the rewind's own entry").toBe(false);
    expect(gate.sceneEntered(), "play continues into a new scene").toBe(true);
  });

  it("shows what arming too late would have done", () => {
    // the shape of the original bug, kept as documentation
    const gate = new AutosaveGate();
    gate.sceneEntered();                // restore's entry, counted before begin
    gate.begin("restore");              // reset arrives too late
    expect(gate.sceneEntered(), "the real transition is wrongly suppressed").toBe(false);
  });
});
