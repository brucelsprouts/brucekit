import { describe, expect, it } from "vitest";
import { ALL_GLYPHS, type Glyph } from "./data";
import { parseCodepoint, searchGlyphs } from "./search";

const chars = (glyphs: Glyph[]) => glyphs.map((g) => g.c);

describe("parseCodepoint", () => {
  it("reads every hex form", () => {
    expect(parseCodepoint("u+00e9")).toBe(0xe9);
    expect(parseCodepoint("U+00E9")).toBe(0xe9);
    expect(parseCodepoint("0x00e9")).toBe(0xe9);
    expect(parseCodepoint(" 00E9 ")).toBe(0xe9);
  });

  it("leaves short bare numbers as name searches", () => {
    // "123" is far more likely a name query than U+0123.
    expect(parseCodepoint("123")).toBeNull();
    expect(parseCodepoint("u+123")).toBe(0x123);
  });

  it("rejects non-hex and out-of-range input", () => {
    expect(parseCodepoint("euro")).toBeNull();
    expect(parseCodepoint("u+ffffff")).toBeNull();
  });
});

describe("searchGlyphs", () => {
  it("returns the whole catalog for an empty query", () => {
    expect(searchGlyphs(ALL_GLYPHS, "")).toHaveLength(ALL_GLYPHS.length);
    expect(searchGlyphs(ALL_GLYPHS, "   ")).toHaveLength(ALL_GLYPHS.length);
  });

  it("expands a single letter into its accented variants", () => {
    const top = chars(searchGlyphs(ALL_GLYPHS, "e")).slice(0, 12);
    for (const c of ["è", "é", "ê", "ë"]) {
      expect(top, `expected ${c} near the top`).toContain(c);
    }
  });

  it("puts the matching case first", () => {
    const upper = searchGlyphs(ALL_GLYPHS, "E");
    expect(upper[0].base).toBe("E");
    const lower = searchGlyphs(ALL_GLYPHS, "e");
    expect(lower[0].base).toBe("e");
  });

  it("does not drown a single letter in name substring matches", () => {
    // Nearly every name contains an "e"; results must stay to letters and
    // deliberate prefix/alias hits rather than most of the catalog.
    const results = searchGlyphs(ALL_GLYPHS, "e");
    expect(results.length).toBeLessThan(ALL_GLYPHS.length / 2);
  });

  it("finds by name", () => {
    expect(chars(searchGlyphs(ALL_GLYPHS, "euro sign"))[0]).toBe("€");
    expect(chars(searchGlyphs(ALL_GLYPHS, "em dash"))[0]).toBe("—");
  });

  it("finds by alias", () => {
    expect(chars(searchGlyphs(ALL_GLYPHS, "permille"))[0]).toBe("‰");
    expect(chars(searchGlyphs(ALL_GLYPHS, "backspace"))[0]).toBe("⌫");
  });

  it("requires every token of a multi-word query", () => {
    const results = chars(searchGlyphs(ALL_GLYPHS, "arrow right"));
    expect(results).toContain("→");
    expect(results).not.toContain("←");
  });

  it("finds by codepoint", () => {
    expect(chars(searchGlyphs(ALL_GLYPHS, "u+00e9"))[0]).toBe("é");
    expect(chars(searchGlyphs(ALL_GLYPHS, "20ac"))[0]).toBe("€");
  });

  it("finds a character pasted in as-is", () => {
    expect(chars(searchGlyphs(ALL_GLYPHS, "√"))[0]).toBe("√");
  });

  it("returns nothing for a query that matches nothing", () => {
    expect(searchGlyphs(ALL_GLYPHS, "zzzznotathing")).toEqual([]);
  });

  it("breaks ties on catalog order, so results do not reshuffle", () => {
    const catalog: Glyph[] = [
      { c: "1", name: "ALPHA MARK", alias: ["mark"] },
      { c: "2", name: "BETA MARK", alias: ["mark"] },
      { c: "3", name: "GAMMA MARK", alias: ["mark"] },
    ];
    expect(chars(searchGlyphs(catalog, "mark"))).toEqual(["1", "2", "3"]);
    expect(chars(searchGlyphs([...catalog].reverse(), "mark"))).toEqual(["3", "2", "1"]);
  });

  it("ranks exact name above prefix above substring", () => {
    const catalog: Glyph[] = [
      { c: "1", name: "WIDE SUN SIGN" },
      { c: "2", name: "SUN SIGN" },
      { c: "3", name: "SUN" },
    ];
    expect(chars(searchGlyphs(catalog, "sun"))).toEqual(["3", "2", "1"]);
  });
});
