/**
 * Windows numpad ("Alt") codes for catalog characters.
 *
 * Two schemes exist and both still work on Windows 11:
 *
 *   Alt + 0NNN  reads NNN as a Windows-1252 (ANSI) byte — é is Alt+0233.
 *   Alt + NNN   reads NNN as a CP437 (OEM) byte — ± is Alt+241, ♥ is Alt+3.
 *
 * ANSI wins when a character is reachable both ways: it covers more of the
 * catalog and behaves the same in every app that takes Alt codes at all. The
 * OEM tables are the fallback, and they earn their keep — the box-drawing,
 * card-suit, and half of the math characters here have no ANSI code at all.
 *
 * Anything outside both tables genuinely has no numpad code (typing it would
 * need the registry's hex-input hack), so those glyphs get null rather than a
 * code that doesn't work.
 */

/**
 * Windows-1252 bytes 0x80–0x9F, the only stretch where byte and codepoint
 * disagree. Written as pairs rather than a positional string because the range
 * has five unassigned slots, and a table with holes in it is a table that
 * silently shifts by one the day someone edits it.
 *
 * The rest of the range (0xA0–0xFF) is Latin-1, where byte equals codepoint.
 */
const CP1252_HIGH: ReadonlyArray<readonly [string, number]> = [
  ["€", 0x80],
  ["‚", 0x82],
  ["ƒ", 0x83],
  ["„", 0x84],
  ["…", 0x85],
  ["†", 0x86],
  ["‡", 0x87],
  ["ˆ", 0x88],
  ["‰", 0x89],
  ["Š", 0x8a],
  ["‹", 0x8b],
  ["Œ", 0x8c],
  ["Ž", 0x8e],
  ["‘", 0x91],
  ["’", 0x92],
  ["“", 0x93],
  ["”", 0x94],
  ["•", 0x95],
  ["–", 0x96],
  ["—", 0x97],
  ["˜", 0x98],
  ["™", 0x99],
  ["š", 0x9a],
  ["›", 0x9b],
  ["œ", 0x9c],
  ["ž", 0x9e],
  ["Ÿ", 0x9f],
];

/** CP437 bytes 0x01–0x1F — the ones that made Alt+3 a heart. */
const CP437_LOW = "☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼";

/** CP437 bytes 0x80–0xFE, in order — 127 characters, no gaps. */
const CP437_HIGH =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»" +
  "░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀" +
  "αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■";

/** Positional string → char-to-byte lookup. First occurrence wins. */
function invert(chars: string, first: number): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  [...chars].forEach((c, i) => {
    if (!map.has(c)) map.set(c, first + i);
  });
  return map;
}

const ANSI = new Map(CP1252_HIGH);
const OEM_LOW = invert(CP437_LOW, 0x01);
const OEM_HIGH = invert(CP437_HIGH, 0x80);

export type AltCode = {
  /** Exactly what to type after Alt, leading zero included: "0233", "241". */
  digits: string;
  /** Which table it came from — the hint explains the difference. */
  scheme: "ansi" | "oem";
};

/**
 * The numpad code for a character, or null if it has none.
 *
 * Only single-codepoint characters can have one, which rules out nothing in
 * the catalog today but keeps the function honest if a ligature shows up.
 */
export function altCode(c: string): AltCode | null {
  if ([...c].length !== 1) return null;

  const cp = c.codePointAt(0) ?? 0;

  // Latin-1 range: the ANSI byte is the codepoint. Below 0xA0 lies ASCII and
  // the C1 controls, neither of which needs an Alt code.
  if (cp >= 0xa0 && cp <= 0xff) return { digits: pad(cp), scheme: "ansi" };

  const ansi = ANSI.get(c);
  if (ansi !== undefined) return { digits: pad(ansi), scheme: "ansi" };

  const oem = OEM_HIGH.get(c) ?? OEM_LOW.get(c);
  if (oem !== undefined) return { digits: String(oem), scheme: "oem" };

  return null;
}

/** ANSI codes are always typed as four digits — Alt+0233, never Alt+233. */
function pad(byte: number): string {
  return `0${byte}`.padStart(4, "0");
}

/** Hover text spelling out how to use the code, since "ALT 0233" alone won't. */
export function altCodeHint(code: AltCode): string {
  const how = `Hold Alt and type ${code.digits} on the numeric keypad (Num Lock on)`;
  return code.scheme === "ansi" ? how : `${how} — legacy OEM code, note the missing leading zero`;
}
