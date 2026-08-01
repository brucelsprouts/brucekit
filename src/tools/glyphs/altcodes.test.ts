import { describe, expect, it } from "vitest";
import { altCode, altCodeHint } from "./altcodes";
import { ALL_GLYPHS } from "./data";

describe("altCode", () => {
  it("reads Latin-1 characters straight off the codepoint", () => {
    expect(altCode("é")).toEqual({ digits: "0233", scheme: "ansi" });
    expect(altCode("ñ")).toEqual({ digits: "0241", scheme: "ansi" });
    expect(altCode("©")).toEqual({ digits: "0169", scheme: "ansi" });
    expect(altCode("±")).toEqual({ digits: "0177", scheme: "ansi" });
    expect(altCode(" ")).toEqual({ digits: "0160", scheme: "ansi" }); // NBSP
    expect(altCode("ÿ")).toEqual({ digits: "0255", scheme: "ansi" });
  });

  it("covers the Windows-1252 0x80–0x9F block", () => {
    expect(altCode("€")).toEqual({ digits: "0128", scheme: "ansi" });
    expect(altCode("‚")).toEqual({ digits: "0130", scheme: "ansi" });
    expect(altCode("…")).toEqual({ digits: "0133", scheme: "ansi" });
    expect(altCode("“")).toEqual({ digits: "0147", scheme: "ansi" });
    expect(altCode("—")).toEqual({ digits: "0151", scheme: "ansi" });
    expect(altCode("™")).toEqual({ digits: "0153", scheme: "ansi" });
    expect(altCode("Ÿ")).toEqual({ digits: "0159", scheme: "ansi" });
  });

  it("falls back to OEM codes for characters ANSI cannot reach", () => {
    expect(altCode("√")).toEqual({ digits: "251", scheme: "oem" });
    expect(altCode("≈")).toEqual({ digits: "247", scheme: "oem" });
    expect(altCode("─")).toEqual({ digits: "196", scheme: "oem" });
    expect(altCode("█")).toEqual({ digits: "219", scheme: "oem" });
    expect(altCode("π")).toEqual({ digits: "227", scheme: "oem" });
    expect(altCode("♥")).toEqual({ digits: "3", scheme: "oem" });
    expect(altCode("♪")).toEqual({ digits: "13", scheme: "oem" });
    expect(altCode("→")).toEqual({ digits: "26", scheme: "oem" });
  });

  it("prefers ANSI when a character sits in both tables", () => {
    // • is CP1252 0x95 and CP437 0x07; ° is Latin-1 0xB0 and CP437 0xF8.
    expect(altCode("•")).toEqual({ digits: "0149", scheme: "ansi" });
    expect(altCode("°")).toEqual({ digits: "0176", scheme: "ansi" });
    expect(altCode("¶")).toEqual({ digits: "0182", scheme: "ansi" });
  });

  it("returns null for characters with no numpad code", () => {
    expect(altCode("⇒")).toBeNull();
    expect(altCode("₹")).toBeNull();
    expect(altCode("ℝ")).toBeNull();
    expect(altCode("Ǎ")).toBeNull();
    expect(altCode("​")).toBeNull(); // zero width space
  });

  it("ignores multi-codepoint input", () => {
    expect(altCode("é")).toBeNull(); // e + combining acute, not precomposed
    expect(altCode("")).toBeNull();
  });

  it("pads ANSI codes to four digits and leaves OEM codes bare", () => {
    expect(altCode("¡")?.digits).toBe("0161");
    expect(altCode("☺")?.digits).toBe("1");
  });
});

describe("altCodeHint", () => {
  it("spells out the keystroke", () => {
    expect(altCodeHint({ digits: "0233", scheme: "ansi" })).toContain("0233");
    expect(altCodeHint({ digits: "0233", scheme: "ansi" })).toContain("numeric keypad");
  });

  it("calls out the missing leading zero on OEM codes", () => {
    expect(altCodeHint({ digits: "241", scheme: "oem" })).toContain("leading zero");
  });
});

describe("against the catalog", () => {
  it("never produces a code that decodes back to a different character", () => {
    // Every ANSI code must round-trip: byte NNN in Windows-1252 is the glyph.
    const wrong = ALL_GLYPHS.filter((g) => {
      const code = altCode(g.c);
      if (code === null || code.scheme !== "ansi") return false;
      const byte = Number.parseInt(code.digits, 10);
      // Latin-1 is the only stretch we can verify arithmetically; the 0x80–0x9F
      // pairs are checked by name above.
      return byte >= 0xa0 && String.fromCodePoint(byte) !== g.c;
    });
    expect(wrong.map((g) => g.name)).toEqual([]);
  });

  it("finds codes for a useful share of the catalog", () => {
    const covered = ALL_GLYPHS.filter((g) => altCode(g.c) !== null).length;
    expect(covered).toBeGreaterThan(150);
  });
});
