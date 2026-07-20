import { describe, expect, it, vi } from "vitest";
import { createUndoSlot, isEditableTarget, isUndoHotkey } from "./undo";

/** Slot with a controllable clock so TTL is testable without waiting. */
function slotAt(start = 0) {
  let now = start;
  const slot = createUndoSlot({ ttlMs: 1000, now: () => now });
  return { slot, advance: (ms: number) => (now += ms) };
}

describe("createUndoSlot", () => {
  it("hands back the entry that was pushed", () => {
    const { slot } = slotAt();
    const run = vi.fn();
    slot.push("the scan", run);

    const entry = slot.take();
    expect(entry?.label).toBe("the scan");
    entry?.run();
    expect(run).toHaveBeenCalledOnce();
  });

  it("only lets an action be undone once", () => {
    const { slot } = slotAt();
    slot.push("the scan", vi.fn());

    expect(slot.take()).not.toBeNull();
    expect(slot.take()).toBeNull();
  });

  it("drops the entry once the window has passed", () => {
    const { slot, advance } = slotAt();
    slot.push("the scan", vi.fn());

    advance(1001);
    expect(slot.take()).toBeNull();
  });

  it("keeps the entry right up to the deadline", () => {
    const { slot, advance } = slotAt();
    slot.push("the scan", vi.fn());

    advance(1000);
    expect(slot.take()).not.toBeNull();
  });

  it("holds only the newest action", () => {
    const { slot } = slotAt();
    const older = vi.fn();
    slot.push("the scan", older);
    slot.push("3 clips", vi.fn());

    expect(slot.take()?.label).toBe("3 clips");
    expect(older).not.toHaveBeenCalled();
  });

  it("restarts the window when a new action replaces an old one", () => {
    const { slot, advance } = slotAt();
    slot.push("the scan", vi.fn());
    advance(900);
    slot.push("3 clips", vi.fn());

    advance(900);
    expect(slot.take()?.label).toBe("3 clips");
  });

  it("lets an owner withdraw its own entry", () => {
    const { slot } = slotAt();
    const token = slot.push("the scan", vi.fn());

    slot.clear(token);
    expect(slot.take()).toBeNull();
  });

  it("does not let a stale owner withdraw someone else's entry", () => {
    // A panel unmounting must not wipe an undo the next panel just registered.
    const { slot } = slotAt();
    const stale = slot.push("the scan", vi.fn());
    slot.push("3 clips", vi.fn());

    slot.clear(stale);
    expect(slot.take()?.label).toBe("3 clips");
  });

  it("reports nothing pending once the window lapses", () => {
    const { slot, advance } = slotAt();
    slot.push("the scan", vi.fn());
    expect(slot.peek()).toBe("the scan");

    advance(1001);
    expect(slot.peek()).toBeNull();
  });
});

describe("isUndoHotkey", () => {
  const ev = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

  it("accepts ctrl+z and cmd+z", () => {
    expect(isUndoHotkey(ev({ key: "z", ctrlKey: true }))).toBe(true);
    expect(isUndoHotkey(ev({ key: "z", metaKey: true }))).toBe(true);
  });

  it("ignores a bare z so typing in the search box is unaffected", () => {
    expect(isUndoHotkey(ev({ key: "z" }))).toBe(false);
  });

  it("ignores shift+ctrl+z, which means redo elsewhere", () => {
    expect(isUndoHotkey(ev({ key: "z", ctrlKey: true, shiftKey: true }))).toBe(false);
  });

  it("matches regardless of caps lock", () => {
    expect(isUndoHotkey(ev({ key: "Z", ctrlKey: true }))).toBe(true);
  });
});

describe("isEditableTarget", () => {
  function input(type: string, readOnly = false) {
    const el = document.createElement("input");
    el.type = type;
    el.readOnly = readOnly;
    return el;
  }

  function textarea(readOnly = false) {
    const el = document.createElement("textarea");
    el.readOnly = readOnly;
    return el;
  }

  it("treats text fields as editable so native undo wins there", () => {
    expect(isEditableTarget(input("text"))).toBe(true);
    expect(isEditableTarget(textarea())).toBe(true);
  });

  it("treats a read-only textarea as not editable", () => {
    // The OCR result box is read-only: there is no text edit to undo, so
    // ctrl+z there should restore the cleared scan instead.
    expect(isEditableTarget(textarea(true))).toBe(false);
    expect(isEditableTarget(input("text", true))).toBe(false);
  });

  it("ignores inputs that hold no text", () => {
    // The colour picker's R/G/B sliders are inputs too.
    expect(isEditableTarget(input("range"))).toBe(false);
    expect(isEditableTarget(input("checkbox"))).toBe(false);
  });

  it("respects contenteditable, including on an ancestor", () => {
    const host = document.createElement("div");
    host.setAttribute("contenteditable", "true");
    const child = document.createElement("span");
    host.appendChild(child);

    expect(isEditableTarget(host)).toBe(true);
    expect(isEditableTarget(child)).toBe(true);
    expect(isEditableTarget(document.createElement("div"))).toBe(false);
  });

  it("tolerates a null target", () => {
    expect(isEditableTarget(null)).toBe(false);
  });
});
