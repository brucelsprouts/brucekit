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
