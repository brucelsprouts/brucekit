import { describe, expect, it } from "vitest";
import {
  ALL_GLYPHS,
  BY_CHAR,
  CATEGORIES,
  EMOJI_PRESENTATION,
  deriveGreek,
  deriveLetters,
} from "./data";

describe("catalog integrity", () => {
  it("has no duplicate characters", () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const g of ALL_GLYPHS) {
      const prev = seen.get(g.c);
      if (prev !== undefined) dupes.push(`${g.c} (${prev} / ${g.name})`);
      seen.set(g.c, g.name);
    }
    expect(dupes).toEqual([]);
  });

  it("names every glyph", () => {
    expect(ALL_GLYPHS.filter((g) => g.name.trim() === "")).toEqual([]);
  });

  it("indexes every glyph by character", () => {
    expect(BY_CHAR.size).toBe(ALL_GLYPHS.length);
  });

  it("gives every category at least one glyph", () => {
    expect(CATEGORIES.filter((c) => c.glyphs.length === 0)).toEqual([]);
  });

  it("labels every invisible character", () => {
    // Anything that renders as nothing must carry a stand-in, or its cell is
    // indistinguishable from a rendering failure.
    const blank = ALL_GLYPHS.filter((g) => /^[\s­​-‏⁠]$/u.test(g.c));
    expect(blank.length).toBeGreaterThan(0);
    expect(blank.filter((g) => g.label === undefined)).toEqual([]);
  });
});

describe("no emoji", () => {
  it("excludes astral-plane characters", () => {
    const astral = ALL_GLYPHS.filter((g) => [...g.c].some((c) => (c.codePointAt(0) ?? 0) >= 0x1f000));
    expect(astral).toEqual([]);
  });

  it("excludes characters that render in color by default", () => {
    const colored = ALL_GLYPHS.filter((g) =>
      [...g.c].some((c) => EMOJI_PRESENTATION.has(c.codePointAt(0) ?? 0)),
    );
    expect(colored).toEqual([]);
  });

  it("excludes variation selectors", () => {
    const varied = ALL_GLYPHS.filter((g) => /[︀-️]/u.test(g.c));
    expect(varied).toEqual([]);
  });
});

describe("deriveLetters", () => {
  const letters = deriveLetters();

  it("covers the common accented letters", () => {
    const chars = new Set(letters.map((g) => g.c));
    for (const c of ["é", "è", "ê", "ë", "ñ", "ü", "ç", "å", "ā", "ő", "ǎ", "ạ", "ế"]) {
      expect(chars.has(c), `missing ${c}`).toBe(true);
    }
  });

  it("gives every derived letter an ASCII base", () => {
    expect(letters.filter((g) => !/^[A-Za-z]$/.test(g.base ?? ""))).toEqual([]);
  });

  it("names letters in Unicode style", () => {
    const acute = letters.find((g) => g.c === "é");
    expect(acute?.name).toBe("LATIN SMALL LETTER E WITH ACUTE");
    expect(acute?.base).toBe("e");
    expect(acute?.alias).toContain("acute");
  });

  it("names multi-mark letters with every mark", () => {
    // ế is e + circumflex + acute.
    expect(letters.find((g) => g.c === "ế")?.name).toBe(
      "LATIN SMALL LETTER E WITH CIRCUMFLEX AND ACUTE",
    );
  });

  it("groups by base letter, lowercase first", () => {
    const bases = letters.map((g) => (g.base ?? "").toLowerCase());
    // Each base appears as one contiguous run rather than scattered by codepoint.
    const runs = bases.filter((b, i) => b !== bases[i - 1]);
    expect(new Set(runs).size).toBe(runs.length);
    expect(letters.find((g) => (g.base ?? "").toLowerCase() === "e")?.base).toBe("e");
  });
});

describe("deriveGreek", () => {
  const greek = deriveGreek();

  it("covers both cases plus final sigma", () => {
    expect(greek).toHaveLength(49);
    expect(greek.find((g) => g.c === "Ω")?.name).toBe("GREEK CAPITAL LETTER OMEGA");
    expect(greek.find((g) => g.c === "π")?.name).toBe("GREEK SMALL LETTER PI");
    expect(greek.find((g) => g.c === "ς")?.name).toBe("GREEK SMALL LETTER FINAL SIGMA");
  });

  it("skips the reserved codepoint", () => {
    expect(greek.some((g) => g.c === "΢")).toBe(false);
  });
});
