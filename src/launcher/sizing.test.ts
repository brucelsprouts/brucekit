import { describe, expect, it } from "vitest";
import type { ToolModule } from "../tools/types";
import {
  DEFAULT_PANEL_SIZE,
  SETTINGS_SIZE,
  SETTINGS_VIEW,
  declaredSize,
  isEchoOfCommand,
  resolvePanelSize,
  viewKeyFor,
} from "./sizing";

const tool = (id: string, panelSize?: { width: number; height: number }) =>
  ({ id, name: id, kind: "panel", panelSize }) as ToolModule;

describe("viewKeyFor", () => {
  it("is null at the module grid, which sizes itself", () => {
    expect(viewKeyFor(false, null)).toBeNull();
  });

  it("names the open module", () => {
    expect(viewKeyFor(false, tool("dcheck"))).toBe("dcheck");
  });

  it("puts settings ahead of a tool, mirroring render order", () => {
    // The launcher renders Settings even when a tool is still in state, so the
    // size that gets applied has to describe the view you can actually see.
    expect(viewKeyFor(true, tool("dcheck"))).toBe(SETTINGS_VIEW);
  });
});

describe("declaredSize", () => {
  it("gives settings its own default", () => {
    expect(declaredSize(SETTINGS_VIEW, null)).toEqual(SETTINGS_SIZE);
  });

  it("takes a module's declared size", () => {
    expect(declaredSize("dcheck", tool("dcheck", { width: 860, height: 620 }))).toEqual({
      width: 860,
      height: 620,
    });
  });

  it("is undefined for a module that declares nothing", () => {
    expect(declaredSize("glyphs", tool("glyphs"))).toBeUndefined();
  });
});

describe("resolvePanelSize", () => {
  const declared = { width: 860, height: 620 };
  const legacy = { width: 700, height: 500 };

  it("prefers what the user dragged this view to", () => {
    const stored = { dcheck: { width: 900, height: 700 } };
    expect(resolvePanelSize("dcheck", stored, declared, legacy)).toEqual({
      width: 900,
      height: 700,
    });
  });

  it("does not let one view's stored size leak into another", () => {
    // The whole point of the change: sizing dcheck must not size glyphs.
    const stored = { dcheck: { width: 900, height: 700 } };
    expect(resolvePanelSize("glyphs", stored, undefined, null)).toEqual(DEFAULT_PANEL_SIZE);
  });

  it("falls back to the module's own declared size", () => {
    expect(resolvePanelSize("dcheck", {}, declared, legacy)).toEqual(declared);
  });

  it("falls back to the legacy single size when nothing is declared", () => {
    // An existing install must not lose the one size it had on upgrade.
    expect(resolvePanelSize("glyphs", {}, undefined, legacy)).toEqual(legacy);
  });

  it("falls back to the neutral default when there is nothing at all", () => {
    expect(resolvePanelSize("glyphs", {}, undefined, null)).toEqual(DEFAULT_PANEL_SIZE);
  });

  it("skips a corrupt stored entry rather than clamping the window to it", () => {
    const stored = { dcheck: { width: 0, height: Number.NaN } };
    expect(resolvePanelSize("dcheck", stored, declared, legacy)).toEqual(declared);
  });

  it("returns a copy, so a caller cannot mutate the stored map through it", () => {
    const stored = { dcheck: { width: 900, height: 700 } };
    const size = resolvePanelSize("dcheck", stored, declared, legacy);
    size.width = 1;
    expect(stored.dcheck.width).toBe(900);
  });
});

describe("isEchoOfCommand", () => {
  it("recognizes the resize our own open provoked", () => {
    expect(isEchoOfCommand({ width: 860, height: 620 }, { width: 860, height: 620 })).toBe(true);
  });

  it("forgives sub-pixel drift from the physical-pixel round trip", () => {
    expect(isEchoOfCommand({ width: 860.5, height: 619.6 }, { width: 860, height: 620 })).toBe(
      true,
    );
  });

  it("treats a real drag as a real drag", () => {
    expect(isEchoOfCommand({ width: 900, height: 700 }, { width: 860, height: 620 })).toBe(false);
  });

  it("is false before anything has been commanded", () => {
    expect(isEchoOfCommand({ width: 860, height: 620 }, null)).toBe(false);
  });
});
