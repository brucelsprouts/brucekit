import { describe, expect, it } from "vitest";
import { BY_CHAR, type Glyph } from "./data";
import { MAX_RECENT, hydrateChars, pushRecent, togglePin } from "./lists";

describe("pushRecent", () => {
  it("puts the newest character first", () => {
    expect(pushRecent(["é"], "€")).toEqual(["€", "é"]);
  });

  it("moves a repeat up instead of duplicating it", () => {
    expect(pushRecent(["€", "é", "—"], "—")).toEqual(["—", "€", "é"]);
  });

  it("caps the list", () => {
    const long = Array.from({ length: MAX_RECENT }, (_, i) => String(i));
    const next = pushRecent(long, "new");
    expect(next).toHaveLength(MAX_RECENT);
    expect(next[0]).toBe("new");
    expect(next).not.toContain(String(MAX_RECENT - 1));
  });
});

describe("togglePin", () => {
  it("adds a new pin at the end", () => {
    expect(togglePin(["€"], "é")).toEqual(["€", "é"]);
  });

  it("removes a pin that is already there", () => {
    expect(togglePin(["€", "é", "—"], "é")).toEqual(["€", "—"]);
  });

  it("leaves every other pin where it was", () => {
    // A pin is a fixed position to aim at; pinning something else must not
    // shuffle the rail out from under it.
    const pins = ["a", "b", "c", "d"];
    expect(togglePin(togglePin(pins, "e"), "e")).toEqual(pins);
    expect(togglePin(pins, "b")).toEqual(["a", "c", "d"]);
  });

  it("starts from an empty list", () => {
    expect(togglePin([], "€")).toEqual(["€"]);
  });
});

describe("hydrateChars", () => {
  it("resolves stored characters back to glyphs, in order", () => {
    expect(hydrateChars(["€", "é"], BY_CHAR).map((g) => g.name)).toEqual([
      "EURO SIGN",
      "LATIN SMALL LETTER E WITH ACUTE",
    ]);
  });

  it("drops characters the catalog no longer knows", () => {
    const known: ReadonlyMap<string, Glyph> = new Map([["a", { c: "a", name: "A" }]]);
    expect(hydrateChars(["a", "gone"], known).map((g) => g.c)).toEqual(["a"]);
  });

  it("handles an empty list", () => {
    expect(hydrateChars([], BY_CHAR)).toEqual([]);
  });
});
