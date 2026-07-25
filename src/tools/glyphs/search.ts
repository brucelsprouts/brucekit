import type { Glyph } from "./data";

/**
 * Ranking for the glyph picker (pure — the whole of the panel's find logic).
 *
 * The ordering is built around what a single keystroke means. Typing `e` is
 * overwhelmingly "show me the e's with things on them", not "show me every
 * character whose name contains an e" — so a single-letter query matches the
 * `base` field first and only falls through to names when nothing has that
 * base. Everything longer than one character is a name search.
 */

export const SCORE = {
  literal: 120,
  codepoint: 110,
  baseExact: 100,
  baseLoose: 90,
  nameExact: 80,
  namePrefix: 70,
  aliasExact: 65,
  allTokens: 55,
  nameIncludes: 50,
  aliasIncludes: 40,
} as const;

/**
 * Read a codepoint query: `u+00e9`, `U+00E9`, `0x00e9`, or a bare `00e9`.
 * Bare hex needs at least four digits so `123` stays a name search rather than
 * silently becoming U+0123.
 */
export function parseCodepoint(query: string): number | null {
  const q = query.trim().toLowerCase();
  const prefixed = /^(?:u\+|0x)([0-9a-f]{1,6})$/.exec(q);
  const bare = /^([0-9a-f]{4,6})$/.exec(q);
  const hex = prefixed?.[1] ?? bare?.[1];
  if (hex === undefined) return null;
  const cp = Number.parseInt(hex, 16);
  return Number.isNaN(cp) || cp > 0x10ffff ? null : cp;
}

/** Score one glyph against a prepared query. Negative means "no match". */
function scoreGlyph(glyph: Glyph, q: string, tokens: string[], cp: number | null): number {
  if (glyph.c === q) return SCORE.literal;
  if (cp !== null && glyph.c.codePointAt(0) === cp) return SCORE.codepoint;

  const name = glyph.name.toLowerCase();
  const aliases = glyph.alias ?? [];

  const singleLetter = q.length === 1 && /[a-z]/i.test(q);
  if (singleLetter && glyph.base !== undefined) {
    if (glyph.base === q) return SCORE.baseExact;
    if (glyph.base.toLowerCase() === q.toLowerCase()) return SCORE.baseLoose;
  }

  // Case is only meaningful for base matching (E vs e); names are matched flat.
  const flat = q.toLowerCase();
  if (name === flat) return SCORE.nameExact;
  if (name.startsWith(flat)) return SCORE.namePrefix;
  if (aliases.some((a) => a === flat)) return SCORE.aliasExact;

  // A single letter stops here. Falling through to substring matching would
  // drag in every glyph whose name merely contains that letter — which for a
  // vowel is most of the catalog, burying the accents you actually asked for.
  if (singleLetter) return -1;

  // Multi-word queries are an AND across name + aliases, so "arrow right"
  // finds the right arrow rather than everything with either word.
  if (tokens.length > 1) {
    const haystack = `${name} ${aliases.join(" ")}`;
    return tokens.every((t) => haystack.includes(t)) ? SCORE.allTokens : -1;
  }

  if (name.includes(q)) return SCORE.nameIncludes;
  if (aliases.some((a) => a.includes(q))) return SCORE.aliasIncludes;
  return -1;
}

/**
 * Rank a catalog against a query. Ties break on catalog position, so results
 * never reshuffle between keystrokes that don't change the match set.
 */
export function searchGlyphs(glyphs: Glyph[], query: string): Glyph[] {
  const raw = query.trim();
  if (raw === "") return [...glyphs];

  // Case matters for base matching (E vs e) but nowhere else.
  const q = raw.length === 1 ? raw : raw.toLowerCase();
  const tokens = raw.toLowerCase().split(/\s+/).filter(Boolean);
  const cp = parseCodepoint(raw);

  return glyphs
    .map((glyph, index) => ({ glyph, index, score: scoreGlyph(glyph, q, tokens, cp) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.glyph);
}
