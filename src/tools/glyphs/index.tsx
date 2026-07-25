import type { ToolModule } from "../types";
import { GlyphsIcon } from "./icon";
import { GlyphsPanel } from "./GlyphsPanel";

/**
 * Special characters — a `panel` tool. Every accent, symbol, arrow, and mark a
 * keyboard doesn't have: type a letter to see its variants, search by name or
 * codepoint, or browse by category. Enter copies.
 *
 * Deliberately no emoji: Windows already has a picker for those (Win+.), and
 * they would bury the characters this exists for.
 */
const glyphs: ToolModule = {
  id: "glyphs",
  name: "Special characters",
  // No `description`: the panel is a dense grid of characters, and a subtitle
  // in its header would be one more line of chrome between you and them. The
  // keywords below carry the search terms a description would have.
  keywords: [
    "special",
    "character",
    "characters",
    "symbol",
    "symbols",
    "glyph",
    "glyphs",
    "unicode",
    "accent",
    "accents",
    "diacritic",
    "umlaut",
    "arrow",
    "math",
    "currency",
    "greek",
    "dash",
    "quote",
    "fraction",
    "charmap",
    "accents symbols arrows math",
  ],
  icon: GlyphsIcon,
  kind: "panel",
  render(ctx) {
    return <GlyphsPanel ctx={ctx} />;
  },
};

export default glyphs;
