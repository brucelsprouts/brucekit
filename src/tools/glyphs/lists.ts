import type { Glyph } from "./data";

/**
 * The two character lists the panel keeps: recents, which the module writes
 * for you, and pins, which you curate. Both are stored as plain characters and
 * resolved against the catalog at render time.
 */

/** How many recently-copied characters to keep. One grid row's worth, roughly. */
export const MAX_RECENT = 24;

/**
 * Push a character to the front of the recents list (pure).
 * Re-copying something already in the list moves it up rather than duplicating
 * it, so the list stays a set of distinct characters ordered by last use.
 */
export function pushRecent(list: string[], c: string): string[] {
  return [c, ...list.filter((existing) => existing !== c)].slice(0, MAX_RECENT);
}

/**
 * Pin or unpin a character (pure). New pins go on the end: the rail is a shelf
 * you arrange, and having everything shuffle right each time you pin something
 * would wreck the muscle memory that makes a fixed rail worth having.
 */
export function togglePin(list: string[], c: string): string[] {
  return list.includes(c) ? list.filter((existing) => existing !== c) : [...list, c];
}

/**
 * Turn stored characters back into glyphs (pure). Anything the catalog no
 * longer knows about is dropped rather than rendered nameless — config.json is
 * hand-editable, and a category retired between versions shouldn't leave
 * unlabelled cells sitting in the grid.
 */
export function hydrateChars(chars: string[], byChar: ReadonlyMap<string, Glyph>): Glyph[] {
  const out: Glyph[] = [];
  for (const c of chars) {
    const glyph = byChar.get(c);
    if (glyph !== undefined) out.push(glyph);
  }
  return out;
}
