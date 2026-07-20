import type { Rgb } from "../../core/ipc";

/** Color formatting is pure logic, unit-tested on both sides (spec §11). */

export type ColorFormat = "hex" | "rgb" | "hsl";
export const COLOR_FORMATS: readonly ColorFormat[] = ["hex", "rgb", "hsl"] as const;

export type Hsl = { h: number; s: number; l: number };

const clampByte = (n: number): number => Math.max(0, Math.min(255, Math.round(n)));

/** `#RRGGBB` (uppercase). */
export function rgbToHex({ r, g, b }: Rgb): string {
  const hex = (n: number) => clampByte(n).toString(16).padStart(2, "0").toUpperCase();
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rn = clampByte(r) / 255;
  const gn = clampByte(g) / 255;
  const bn = clampByte(b) / 255;

  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  const l = (max + min) / 2;

  let h = 0;
  let s = 0;
  if (delta !== 0) {
    s = delta / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case rn:
        h = ((gn - bn) / delta) % 6;
        break;
      case gn:
        h = (bn - rn) / delta + 2;
        break;
      default:
        h = (rn - gn) / delta + 4;
        break;
    }
    h *= 60;
    if (h < 0) h += 360;
  }

  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

/**
 * HSV is what the 2D picker field is actually shaped like — a hue rail beside
 * a saturation × value square — so the panel converts through here rather than
 * through HSL, whose square is a diamond and whose corners lie.
 */
export type Hsv = { h: number; s: number; v: number };

export function rgbToHsv({ r, g, b }: Rgb): Hsv {
  const rn = clampByte(r) / 255;
  const gn = clampByte(g) / 255;
  const bn = clampByte(b) / 255;

  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;

  let h = 0;
  if (delta !== 0) {
    if (max === rn) h = ((gn - bn) / delta) % 6;
    else if (max === gn) h = (bn - rn) / delta + 2;
    else h = (rn - gn) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }

  return { h, s: max === 0 ? 0 : delta / max, v: max };
}

export function hsvToRgb({ h, s, v }: Hsv): Rgb {
  const hue = ((h % 360) + 360) % 360;
  const sat = Math.min(1, Math.max(0, s));
  const val = Math.min(1, Math.max(0, v));

  const c = val * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = val - c;

  const [r1, g1, b1] =
    hue < 60
      ? [c, x, 0]
      : hue < 120
        ? [x, c, 0]
        : hue < 180
          ? [0, c, x]
          : hue < 240
            ? [0, x, c]
            : hue < 300
              ? [x, 0, c]
              : [c, 0, x];

  return {
    r: clampByte((r1 + m) * 255),
    g: clampByte((g1 + m) * 255),
    b: clampByte((b1 + m) * 255),
  };
}

/** Parse `#RGB` / `#RRGGBB` (leading `#` optional) to an Rgb, or null if invalid. */
export function parseHex(input: string): Rgb | null {
  const s = input.trim().replace(/^#/, "");
  const full = s.length === 3 ? s.replace(/(.)/g, "$1$1") : s;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

/** Render a color in the requested format (spec §11). */
export function formatColor(rgb: Rgb, format: ColorFormat): string {
  switch (format) {
    case "hex":
      return rgbToHex(rgb);
    case "rgb":
      return `rgb(${clampByte(rgb.r)}, ${clampByte(rgb.g)}, ${clampByte(rgb.b)})`;
    case "hsl": {
      const { h, s, l } = rgbToHsl(rgb);
      return `hsl(${h}, ${s}%, ${l}%)`;
    }
  }
}
