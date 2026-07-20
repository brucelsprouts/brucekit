import { describe, expect, it } from "vitest";
import { formatColor, hsvToRgb, parseHex, rgbToHex, rgbToHsl, rgbToHsv } from "./color";

describe("rgbToHex", () => {
  it("formats channels as #RRGGBB uppercase", () => {
    expect(rgbToHex({ r: 255, g: 255, b: 255 })).toBe("#FFFFFF");
    expect(rgbToHex({ r: 0, g: 0, b: 0 })).toBe("#000000");
    expect(rgbToHex({ r: 18, g: 52, b: 86 })).toBe("#123456");
  });

  it("clamps and rounds out-of-range channels", () => {
    expect(rgbToHex({ r: -5, g: 300, b: 127.6 })).toBe("#00FF80");
  });
});

describe("rgbToHsl", () => {
  it("converts primaries", () => {
    expect(rgbToHsl({ r: 255, g: 0, b: 0 })).toEqual({ h: 0, s: 100, l: 50 });
    expect(rgbToHsl({ r: 0, g: 128, b: 0 })).toEqual({ h: 120, s: 100, l: 25 });
    expect(rgbToHsl({ r: 0, g: 0, b: 255 })).toEqual({ h: 240, s: 100, l: 50 });
  });

  it("gives zero saturation for greys", () => {
    expect(rgbToHsl({ r: 255, g: 255, b: 255 })).toEqual({ h: 0, s: 0, l: 100 });
    expect(rgbToHsl({ r: 128, g: 128, b: 128 })).toEqual({ h: 0, s: 0, l: 50 });
  });
});

describe("formatColor", () => {
  const teal = { r: 77, g: 224, b: 176 };

  it("renders each format", () => {
    expect(formatColor(teal, "hex")).toBe("#4DE0B0");
    expect(formatColor(teal, "rgb")).toBe("rgb(77, 224, 176)");
    expect(formatColor(teal, "hsl")).toBe("hsl(160, 70%, 59%)");
  });
});

describe("parseHex", () => {
  it("parses 6-digit hex with or without a leading #", () => {
    expect(parseHex("#4DE0B0")).toEqual({ r: 77, g: 224, b: 176 });
    expect(parseHex("4de0b0")).toEqual({ r: 77, g: 224, b: 176 });
  });

  it("expands 3-digit shorthand", () => {
    expect(parseHex("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex("0a0")).toEqual({ r: 0, g: 170, b: 0 });
  });

  it("rejects malformed input", () => {
    expect(parseHex("nope")).toBeNull();
    expect(parseHex("#12")).toBeNull();
    expect(parseHex("#12345g")).toBeNull();
    expect(parseHex("")).toBeNull();
  });

  it("round-trips with rgbToHex", () => {
    expect(rgbToHex(parseHex("#123456")!)).toBe("#123456");
  });
});

describe("HSV conversion", () => {
  it("maps the primaries onto their hue spokes", () => {
    expect(rgbToHsv({ r: 255, g: 0, b: 0 })).toEqual({ h: 0, s: 1, v: 1 });
    expect(rgbToHsv({ r: 0, g: 255, b: 0 })).toEqual({ h: 120, s: 1, v: 1 });
    expect(rgbToHsv({ r: 0, g: 0, b: 255 })).toEqual({ h: 240, s: 1, v: 1 });
  });

  it("treats greys as hueless and unsaturated", () => {
    expect(rgbToHsv({ r: 0, g: 0, b: 0 })).toEqual({ h: 0, s: 0, v: 0 });
    expect(rgbToHsv({ r: 128, g: 128, b: 128 })).toMatchObject({ h: 0, s: 0 });
  });

  it("round-trips arbitrary colors within a rounding step", () => {
    for (const rgb of [
      { r: 77, g: 224, b: 176 },
      { r: 18, g: 52, b: 86 },
      { r: 255, g: 140, b: 0 },
      { r: 7, g: 7, b: 9 },
    ]) {
      const back = hsvToRgb(rgbToHsv(rgb));
      expect(Math.abs(back.r - rgb.r)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.g - rgb.g)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.b - rgb.b)).toBeLessThanOrEqual(1);
    }
  });

  it("wraps hue and clamps s/v instead of producing out-of-gamut bytes", () => {
    expect(hsvToRgb({ h: 360, s: 1, v: 1 })).toEqual({ r: 255, g: 0, b: 0 });
    expect(hsvToRgb({ h: -120, s: 1, v: 1 })).toEqual({ r: 0, g: 0, b: 255 });
    expect(hsvToRgb({ h: 0, s: 5, v: 5 })).toEqual({ r: 255, g: 0, b: 0 });
    expect(hsvToRgb({ h: 0, s: -1, v: -1 })).toEqual({ r: 0, g: 0, b: 0 });
  });
});
