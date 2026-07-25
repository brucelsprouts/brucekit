/**
 * The glyph catalog: every character this module can hand you, grouped into
 * browsable categories.
 *
 * Accented Latin is *derived* rather than typed out. Walking the Latin blocks
 * and reading each character's NFD decomposition gives us the base letter, the
 * diacritic, and enough to synthesize the Unicode-style name — ~700 letters
 * with no hand-entry, and therefore no transcription errors. Everything else
 * is a hand-written list, because there is no structure to exploit.
 *
 * Emoji are deliberately absent. Windows already has a picker for those, and
 * they would bury the characters this module exists for. The rule is enforced
 * by data.test.ts against EMOJI_PRESENTATION below, not by good intentions.
 */

export type Glyph = {
  /** The character itself — this is what lands on the clipboard. */
  c: string;
  /** Unicode-style name, uppercase. */
  name: string;
  /** Extra lowercase search terms. */
  alias?: string[];
  /** For letter variants: the plain ASCII letter underneath, e.g. "e" for "é". */
  base?: string;
  /** Stand-in shown in the grid for characters with no visible form. */
  label?: string;
};

export type Category = {
  id: string;
  /** Chip text — short, it has to fit a row of them. */
  label: string;
  glyphs: Glyph[];
};

// --- helpers ---------------------------------------------------------------

/** `[char, name, ...aliases]` — the compact form the hand-written lists use. */
type Row = [string, string, ...string[]];

function rows(list: Row[]): Glyph[] {
  return list.map(([c, name, ...alias]) => (alias.length > 0 ? { c, name, alias } : { c, name }));
}

/** `[char, base, name, ...aliases]` — for letters that carry a base. */
type LetterRow = [string, string, string, ...string[]];

function letterRows(list: LetterRow[]): Glyph[] {
  return list.map(([c, base, name, ...alias]) => ({
    c,
    name,
    base: base === "" ? undefined : base,
    ...(alias.length > 0 ? { alias } : {}),
  }));
}

// --- derived Latin letters -------------------------------------------------

/**
 * Combining marks we can name. A character whose decomposition contains a mark
 * outside this table is skipped rather than given a wrong name — the catalog
 * would rather be short than lie about what a character is.
 */
const MARKS: Record<number, [string, string]> = {
  0x0300: ["GRAVE", "grave"],
  0x0301: ["ACUTE", "acute"],
  0x0302: ["CIRCUMFLEX", "circumflex"],
  0x0303: ["TILDE", "tilde"],
  0x0304: ["MACRON", "macron"],
  0x0306: ["BREVE", "breve"],
  0x0307: ["DOT ABOVE", "dot"],
  0x0308: ["DIAERESIS", "umlaut"],
  0x0309: ["HOOK ABOVE", "hook"],
  0x030a: ["RING ABOVE", "ring"],
  0x030b: ["DOUBLE ACUTE", "double acute"],
  0x030c: ["CARON", "caron"],
  0x030f: ["DOUBLE GRAVE", "double grave"],
  0x0311: ["INVERTED BREVE", "inverted breve"],
  0x0313: ["COMMA ABOVE", "comma above"],
  0x031b: ["HORN", "horn"],
  0x0323: ["DOT BELOW", "dot below"],
  0x0324: ["DIAERESIS BELOW", "umlaut below"],
  0x0325: ["RING BELOW", "ring below"],
  0x0326: ["COMMA BELOW", "comma below"],
  0x0327: ["CEDILLA", "cedilla"],
  0x0328: ["OGONEK", "ogonek"],
  0x032d: ["CIRCUMFLEX BELOW", "circumflex below"],
  0x032e: ["BREVE BELOW", "breve below"],
  0x0330: ["TILDE BELOW", "tilde below"],
  0x0331: ["MACRON BELOW", "macron below"],
};

/** Latin blocks worth walking: Latin-1 Supplement through Extended Additional. */
const LETTER_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00c0, 0x024f],
  [0x1e00, 0x1eff],
];

/**
 * Build every precomposed Latin letter we can describe. Sorted by base letter
 * rather than codepoint, so browsing reads a, á, â, ä … b, c, ç … instead of
 * jumping between alphabets every few cells.
 */
export function deriveLetters(): Glyph[] {
  const out: Glyph[] = [];

  for (const [lo, hi] of LETTER_RANGES) {
    for (let cp = lo; cp <= hi; cp++) {
      const c = String.fromCodePoint(cp);
      const decomposed = c.normalize("NFD");
      if (decomposed.length < 2) continue;

      const base = decomposed[0];
      if (!/[A-Za-z]/.test(base)) continue;

      const marks = [...decomposed.slice(1)].map((m) => MARKS[m.codePointAt(0) ?? 0]);
      if (marks.some((m) => m === undefined)) continue;

      const casing = base === base.toUpperCase() ? "CAPITAL" : "SMALL";
      out.push({
        c,
        name: `LATIN ${casing} LETTER ${base.toUpperCase()} WITH ${marks
          .map((m) => m[0])
          .join(" AND ")}`,
        alias: [base.toLowerCase(), ...marks.map((m) => m[1])],
        base,
      });
    }
  }

  return out.sort(byBaseThenCase);
}

function byBaseThenCase(a: Glyph, b: Glyph): number {
  const ab = (a.base ?? "").toLowerCase();
  const bb = (b.base ?? "").toLowerCase();
  // Letters that answer to no base (thorn, ezh) go last rather than opening
  // the category — browsing should start at A, not at the leftovers.
  if (ab === "" || bb === "") {
    if (ab !== bb) return ab === "" ? 1 : -1;
    return (a.c.codePointAt(0) ?? 0) - (b.c.codePointAt(0) ?? 0);
  }
  if (ab !== bb) return ab < bb ? -1 : 1;
  // Lowercase first within a letter: it's the form you reach for more often.
  const aUpper = a.base === a.base?.toUpperCase();
  const bUpper = b.base === b.base?.toUpperCase();
  if (aUpper !== bUpper) return aUpper ? 1 : -1;
  return (a.c.codePointAt(0) ?? 0) - (b.c.codePointAt(0) ?? 0);
}

/** Letters with no decomposition to mine — stroked, ligated, or their own thing. */
const STANDALONE_LETTERS = letterRows([
  ["æ", "a", "LATIN SMALL LETTER AE", "ae", "ash"],
  ["Æ", "A", "LATIN CAPITAL LETTER AE", "ae", "ash"],
  ["œ", "o", "LATIN SMALL LIGATURE OE", "oe"],
  ["Œ", "O", "LATIN CAPITAL LIGATURE OE", "oe"],
  ["ø", "o", "LATIN SMALL LETTER O WITH STROKE", "slash", "stroke", "danish"],
  ["Ø", "O", "LATIN CAPITAL LETTER O WITH STROKE", "slash", "stroke", "danish"],
  ["ß", "s", "LATIN SMALL LETTER SHARP S", "eszett", "sharp s", "german"],
  ["ẞ", "S", "LATIN CAPITAL LETTER SHARP S", "eszett", "german"],
  ["ð", "d", "LATIN SMALL LETTER ETH", "eth", "icelandic"],
  ["Ð", "D", "LATIN CAPITAL LETTER ETH", "eth", "icelandic"],
  ["þ", "", "LATIN SMALL LETTER THORN", "thorn", "icelandic"],
  ["Þ", "", "LATIN CAPITAL LETTER THORN", "thorn", "icelandic"],
  ["ł", "l", "LATIN SMALL LETTER L WITH STROKE", "stroke", "polish"],
  ["Ł", "L", "LATIN CAPITAL LETTER L WITH STROKE", "stroke", "polish"],
  ["đ", "d", "LATIN SMALL LETTER D WITH STROKE", "stroke"],
  ["Đ", "D", "LATIN CAPITAL LETTER D WITH STROKE", "stroke"],
  ["ħ", "h", "LATIN SMALL LETTER H WITH STROKE", "stroke"],
  ["Ħ", "H", "LATIN CAPITAL LETTER H WITH STROKE", "stroke"],
  ["ŧ", "t", "LATIN SMALL LETTER T WITH STROKE", "stroke"],
  ["Ŧ", "T", "LATIN CAPITAL LETTER T WITH STROKE", "stroke"],
  ["ŋ", "n", "LATIN SMALL LETTER ENG", "eng"],
  ["Ŋ", "N", "LATIN CAPITAL LETTER ENG", "eng"],
  ["ı", "i", "LATIN SMALL LETTER DOTLESS I", "dotless", "turkish"],
  ["ə", "e", "LATIN SMALL LETTER SCHWA", "schwa"],
  ["Ə", "E", "LATIN CAPITAL LETTER SCHWA", "schwa"],
  ["ƒ", "f", "LATIN SMALL LETTER F WITH HOOK", "florin", "hook"],
  ["ĳ", "i", "LATIN SMALL LIGATURE IJ", "ij", "dutch"],
  ["Ĳ", "I", "LATIN CAPITAL LIGATURE IJ", "ij", "dutch"],
  ["ʒ", "", "LATIN SMALL LETTER EZH", "ezh"],
  ["Ʒ", "", "LATIN CAPITAL LETTER EZH", "ezh"],
]);

// --- Greek -----------------------------------------------------------------

const GREEK_NAMES = [
  "ALPHA",
  "BETA",
  "GAMMA",
  "DELTA",
  "EPSILON",
  "ZETA",
  "ETA",
  "THETA",
  "IOTA",
  "KAPPA",
  "LAMDA",
  "MU",
  "NU",
  "XI",
  "OMICRON",
  "PI",
  "RHO",
  "SIGMA",
  "TAU",
  "UPSILON",
  "PHI",
  "CHI",
  "PSI",
  "OMEGA",
];

/**
 * Greek is regular enough to generate: capitals run Α–Ω with one reserved hole,
 * smalls run α–ω with final sigma wedged in the middle.
 */
export function deriveGreek(): Glyph[] {
  const out: Glyph[] = [];

  let i = 0;
  for (let cp = 0x0391; cp <= 0x03a9; cp++) {
    if (cp === 0x03a2) continue; // reserved
    const name = GREEK_NAMES[i++];
    out.push({
      c: String.fromCodePoint(cp),
      name: `GREEK CAPITAL LETTER ${name}`,
      alias: [name.toLowerCase(), "greek"],
    });
  }

  i = 0;
  for (let cp = 0x03b1; cp <= 0x03c9; cp++) {
    if (cp === 0x03c2) {
      out.push({
        c: "ς",
        name: "GREEK SMALL LETTER FINAL SIGMA",
        alias: ["sigma", "final sigma", "greek"],
      });
      continue;
    }
    const name = GREEK_NAMES[i++];
    out.push({
      c: String.fromCodePoint(cp),
      name: `GREEK SMALL LETTER ${name}`,
      alias: [name.toLowerCase(), "greek"],
    });
  }

  return out;
}

const GREEK_VARIANTS = rows([
  ["ϑ", "GREEK THETA SYMBOL", "theta", "greek"],
  ["ϕ", "GREEK PHI SYMBOL", "phi", "greek"],
  ["ϖ", "GREEK PI SYMBOL", "pi", "greek"],
  ["ϒ", "GREEK UPSILON WITH HOOK SYMBOL", "upsilon", "greek"],
  ["ϝ", "GREEK SMALL LETTER DIGAMMA", "digamma", "greek"],
]);

// --- hand-written categories -----------------------------------------------

const PUNCTUATION = rows([
  ["–", "EN DASH", "dash", "range"],
  ["—", "EM DASH", "dash", "long dash"],
  ["‒", "FIGURE DASH", "dash"],
  ["―", "HORIZONTAL BAR", "dash", "quotation dash"],
  ["‑", "NON-BREAKING HYPHEN", "hyphen"],
  ["…", "HORIZONTAL ELLIPSIS", "ellipsis", "dots", "three dots"],
  ["·", "MIDDLE DOT", "interpunct", "dot", "separator"],
  ["•", "BULLET", "dot", "list"],
  ["‣", "TRIANGULAR BULLET", "bullet", "list"],
  ["⁃", "HYPHEN BULLET", "bullet", "list"],
  ["◦", "WHITE BULLET", "bullet", "circle"],
  ["“", "LEFT DOUBLE QUOTATION MARK", "curly quote", "smart quote", "open quote"],
  ["”", "RIGHT DOUBLE QUOTATION MARK", "curly quote", "smart quote", "close quote"],
  ["‘", "LEFT SINGLE QUOTATION MARK", "curly quote", "open quote"],
  ["’", "RIGHT SINGLE QUOTATION MARK", "apostrophe", "curly quote", "close quote"],
  ["‚", "SINGLE LOW-9 QUOTATION MARK", "comma quote"],
  ["„", "DOUBLE LOW-9 QUOTATION MARK", "german quote"],
  ["«", "LEFT-POINTING DOUBLE ANGLE QUOTATION MARK", "guillemet", "french quote"],
  ["»", "RIGHT-POINTING DOUBLE ANGLE QUOTATION MARK", "guillemet", "french quote"],
  ["‹", "SINGLE LEFT-POINTING ANGLE QUOTATION MARK", "guillemet"],
  ["›", "SINGLE RIGHT-POINTING ANGLE QUOTATION MARK", "guillemet"],
  ["¡", "INVERTED EXCLAMATION MARK", "spanish", "exclamation"],
  ["¿", "INVERTED QUESTION MARK", "spanish", "question"],
  ["‽", "INTERROBANG", "question", "exclamation"],
  ["§", "SECTION SIGN", "section", "legal"],
  ["¶", "PILCROW SIGN", "paragraph"],
  ["†", "DAGGER", "footnote", "obelisk"],
  ["‡", "DOUBLE DAGGER", "footnote"],
  ["※", "REFERENCE MARK", "note"],
  ["⁂", "ASTERISM", "stars", "break"],
  ["′", "PRIME", "minutes", "feet"],
  ["″", "DOUBLE PRIME", "seconds", "inches"],
  ["‴", "TRIPLE PRIME"],
  ["‵", "REVERSED PRIME"],
  ["⁓", "SWUNG DASH", "tilde"],
  ["‾", "OVERLINE", "bar"],
  ["⁄", "FRACTION SLASH", "slash", "divide"],
  ["¦", "BROKEN BAR", "pipe"],
  ["‖", "DOUBLE VERTICAL LINE", "pipe", "norm"],
  ["⸗", "DOUBLE OBLIQUE HYPHEN", "hyphen"],
  ["⌜", "TOP LEFT CORNER", "bracket"],
  ["⌝", "TOP RIGHT CORNER", "bracket"],
  ["⌞", "BOTTOM LEFT CORNER", "bracket"],
  ["⌟", "BOTTOM RIGHT CORNER", "bracket"],
  ["「", "LEFT CORNER BRACKET", "japanese", "quote"],
  ["」", "RIGHT CORNER BRACKET", "japanese", "quote"],
]);

const CURRENCY = rows([
  ["¢", "CENT SIGN", "cent", "money"],
  ["£", "POUND SIGN", "pound", "sterling", "money"],
  ["¤", "CURRENCY SIGN", "generic", "money"],
  ["¥", "YEN SIGN", "yen", "yuan", "money"],
  ["€", "EURO SIGN", "euro", "money"],
  ["₹", "INDIAN RUPEE SIGN", "rupee", "india", "money"],
  ["₽", "RUBLE SIGN", "ruble", "russia", "money"],
  ["₩", "WON SIGN", "won", "korea", "money"],
  ["₪", "NEW SHEQEL SIGN", "shekel", "israel", "money"],
  ["₫", "DONG SIGN", "dong", "vietnam", "money"],
  ["₺", "TURKISH LIRA SIGN", "lira", "turkey", "money"],
  ["₦", "NAIRA SIGN", "naira", "nigeria", "money"],
  ["₱", "PESO SIGN", "peso", "philippines", "money"],
  ["₴", "HRYVNIA SIGN", "hryvnia", "ukraine", "money"],
  ["₡", "COLON SIGN", "colon", "costa rica", "money"],
  ["₲", "GUARANI SIGN", "guarani", "paraguay", "money"],
  ["₵", "CEDI SIGN", "cedi", "ghana", "money"],
  ["₸", "TENGE SIGN", "tenge", "kazakhstan", "money"],
  ["₼", "MANAT SIGN", "manat", "azerbaijan", "money"],
  ["₾", "LARI SIGN", "lari", "georgia", "money"],
  ["₿", "BITCOIN SIGN", "bitcoin", "btc", "money"],
  ["₭", "KIP SIGN", "kip", "laos", "money"],
  ["₮", "TUGRIK SIGN", "tugrik", "mongolia", "money"],
  ["₨", "RUPEE SIGN", "rupee", "money"],
  ["₣", "FRENCH FRANC SIGN", "franc", "money"],
  ["₤", "LIRA SIGN", "lira", "money"],
  ["₧", "PESETA SIGN", "peseta", "money"],
  ["₯", "DRACHMA SIGN", "drachma", "greece", "money"],
  ["₥", "MILL SIGN", "mill", "money"],
]);

const MATH = rows([
  ["±", "PLUS-MINUS SIGN", "plus minus", "tolerance"],
  ["∓", "MINUS-OR-PLUS SIGN", "minus plus"],
  ["×", "MULTIPLICATION SIGN", "times", "multiply", "cross"],
  ["÷", "DIVISION SIGN", "divide", "obelus"],
  ["−", "MINUS SIGN", "minus", "subtract"],
  ["∗", "ASTERISK OPERATOR", "asterisk", "star"],
  ["∘", "RING OPERATOR", "compose"],
  ["√", "SQUARE ROOT", "root", "radical"],
  ["∛", "CUBE ROOT", "root"],
  ["∜", "FOURTH ROOT", "root"],
  ["∞", "INFINITY", "infinite", "forever"],
  ["≈", "ALMOST EQUAL TO", "approximately", "approx"],
  ["≉", "NOT ALMOST EQUAL TO", "not approx"],
  ["≅", "APPROXIMATELY EQUAL TO", "congruent"],
  ["≠", "NOT EQUAL TO", "not equal", "neq"],
  ["≡", "IDENTICAL TO", "identical", "equivalent"],
  ["≢", "NOT IDENTICAL TO", "not identical"],
  ["≤", "LESS-THAN OR EQUAL TO", "less than", "lte"],
  ["≥", "GREATER-THAN OR EQUAL TO", "greater than", "gte"],
  ["≪", "MUCH LESS-THAN", "much less"],
  ["≫", "MUCH GREATER-THAN", "much greater"],
  ["∝", "PROPORTIONAL TO", "proportional"],
  ["∴", "THEREFORE", "therefore", "proof"],
  ["∵", "BECAUSE", "because", "proof"],
  ["∎", "END OF PROOF", "qed", "tombstone"],
  ["∑", "N-ARY SUMMATION", "sum", "sigma", "total"],
  ["∏", "N-ARY PRODUCT", "product"],
  ["∫", "INTEGRAL", "integral", "calculus"],
  ["∬", "DOUBLE INTEGRAL", "integral"],
  ["∮", "CONTOUR INTEGRAL", "integral", "loop"],
  ["∂", "PARTIAL DIFFERENTIAL", "partial", "derivative"],
  ["∆", "INCREMENT", "delta", "change"],
  ["∇", "NABLA", "del", "gradient"],
  ["∅", "EMPTY SET", "empty", "null", "void"],
  ["∈", "ELEMENT OF", "in", "member"],
  ["∉", "NOT AN ELEMENT OF", "not in"],
  ["∋", "CONTAINS AS MEMBER", "contains"],
  ["⊂", "SUBSET OF", "subset"],
  ["⊃", "SUPERSET OF", "superset"],
  ["⊆", "SUBSET OF OR EQUAL TO", "subset"],
  ["⊇", "SUPERSET OF OR EQUAL TO", "superset"],
  ["∪", "UNION", "union", "or"],
  ["∩", "INTERSECTION", "intersect", "and"],
  ["∀", "FOR ALL", "for all", "universal"],
  ["∃", "THERE EXISTS", "exists", "existential"],
  ["∄", "THERE DOES NOT EXIST", "not exists"],
  ["¬", "NOT SIGN", "not", "negation", "logical not"],
  ["∧", "LOGICAL AND", "and", "conjunction"],
  ["∨", "LOGICAL OR", "or", "disjunction"],
  ["⊕", "CIRCLED PLUS", "xor", "direct sum"],
  ["⊗", "CIRCLED TIMES", "tensor"],
  ["⊥", "UP TACK", "perpendicular", "bottom"],
  ["⊤", "DOWN TACK", "top"],
  ["∥", "PARALLEL TO", "parallel"],
  ["∠", "ANGLE", "angle"],
  ["∟", "RIGHT ANGLE", "angle"],
  ["°", "DEGREE SIGN", "degree", "temperature"],
  ["‰", "PER MILLE SIGN", "permille", "per thousand"],
  ["‱", "PER TEN THOUSAND SIGN", "basis point"],
  ["µ", "MICRO SIGN", "micro", "micron"],
  ["ℵ", "ALEF SYMBOL", "aleph", "cardinal"],
  ["ℏ", "PLANCK CONSTANT OVER TWO PI", "hbar", "planck"],
  ["ℓ", "SCRIPT SMALL L", "litre", "script l"],
  ["ℝ", "DOUBLE-STRUCK CAPITAL R", "reals", "blackboard"],
  ["ℕ", "DOUBLE-STRUCK CAPITAL N", "naturals", "blackboard"],
  ["ℤ", "DOUBLE-STRUCK CAPITAL Z", "integers", "blackboard"],
  ["ℚ", "DOUBLE-STRUCK CAPITAL Q", "rationals", "blackboard"],
  ["ℂ", "DOUBLE-STRUCK CAPITAL C", "complex", "blackboard"],
  ["⌈", "LEFT CEILING", "ceiling", "bracket"],
  ["⌉", "RIGHT CEILING", "ceiling", "bracket"],
  ["⌊", "LEFT FLOOR", "floor", "bracket"],
  ["⌋", "RIGHT FLOOR", "floor", "bracket"],
  ["⟨", "MATHEMATICAL LEFT ANGLE BRACKET", "bracket", "bra"],
  ["⟩", "MATHEMATICAL RIGHT ANGLE BRACKET", "bracket", "ket"],
]);

const ARROWS = rows([
  ["←", "LEFTWARDS ARROW", "arrow", "left", "west"],
  ["↑", "UPWARDS ARROW", "arrow", "up", "north"],
  ["→", "RIGHTWARDS ARROW", "arrow", "right", "east"],
  ["↓", "DOWNWARDS ARROW", "arrow", "down", "south"],
  ["↔", "LEFT RIGHT ARROW", "arrow", "horizontal", "both"],
  ["↕", "UP DOWN ARROW", "arrow", "vertical", "both"],
  ["↖", "NORTH WEST ARROW", "arrow", "diagonal"],
  ["↗", "NORTH EAST ARROW", "arrow", "diagonal"],
  ["↘", "SOUTH EAST ARROW", "arrow", "diagonal"],
  ["↙", "SOUTH WEST ARROW", "arrow", "diagonal"],
  ["↚", "LEFTWARDS ARROW WITH STROKE", "arrow", "not"],
  ["↛", "RIGHTWARDS ARROW WITH STROKE", "arrow", "not"],
  ["↞", "LEFTWARDS TWO HEADED ARROW", "arrow"],
  ["↠", "RIGHTWARDS TWO HEADED ARROW", "arrow"],
  ["↢", "LEFTWARDS ARROW WITH TAIL", "arrow"],
  ["↣", "RIGHTWARDS ARROW WITH TAIL", "arrow", "injection"],
  ["↦", "RIGHTWARDS ARROW FROM BAR", "arrow", "maps to"],
  ["↩", "LEFTWARDS ARROW WITH HOOK", "arrow", "hook"],
  ["↪", "RIGHTWARDS ARROW WITH HOOK", "arrow", "hook"],
  ["↭", "LEFT RIGHT WAVE ARROW", "arrow", "wave"],
  ["↰", "UPWARDS ARROW WITH TIP LEFTWARDS", "arrow", "corner"],
  ["↱", "UPWARDS ARROW WITH TIP RIGHTWARDS", "arrow", "corner"],
  ["↲", "DOWNWARDS ARROW WITH TIP LEFTWARDS", "arrow", "corner"],
  ["↳", "DOWNWARDS ARROW WITH TIP RIGHTWARDS", "arrow", "corner"],
  ["↵", "DOWNWARDS ARROW WITH CORNER LEFTWARDS", "arrow", "newline", "return"],
  ["↶", "ANTICLOCKWISE TOP SEMICIRCLE ARROW", "arrow", "undo"],
  ["↷", "CLOCKWISE TOP SEMICIRCLE ARROW", "arrow", "redo"],
  ["↺", "ANTICLOCKWISE OPEN CIRCLE ARROW", "arrow", "rotate", "reload"],
  ["↻", "CLOCKWISE OPEN CIRCLE ARROW", "arrow", "rotate", "refresh"],
  ["⇐", "LEFTWARDS DOUBLE ARROW", "arrow", "implies"],
  ["⇑", "UPWARDS DOUBLE ARROW", "arrow"],
  ["⇒", "RIGHTWARDS DOUBLE ARROW", "arrow", "implies", "then"],
  ["⇓", "DOWNWARDS DOUBLE ARROW", "arrow"],
  ["⇔", "LEFT RIGHT DOUBLE ARROW", "arrow", "iff", "equivalent"],
  ["⇕", "UP DOWN DOUBLE ARROW", "arrow"],
  ["⇄", "RIGHTWARDS ARROW OVER LEFTWARDS ARROW", "arrow", "swap", "sync"],
  ["⇅", "UPWARDS ARROW LEFTWARDS OF DOWNWARDS ARROW", "arrow", "sort"],
  ["⇆", "LEFTWARDS ARROW OVER RIGHTWARDS ARROW", "arrow", "swap"],
  ["⇉", "RIGHTWARDS PAIRED ARROWS", "arrow"],
  ["⇠", "LEFTWARDS DASHED ARROW", "arrow", "dashed"],
  ["⇡", "UPWARDS DASHED ARROW", "arrow", "dashed"],
  ["⇢", "RIGHTWARDS DASHED ARROW", "arrow", "dashed"],
  ["⇣", "DOWNWARDS DASHED ARROW", "arrow", "dashed"],
  ["➔", "HEAVY WIDE-HEADED RIGHTWARDS ARROW", "arrow", "bold"],
  ["➜", "HEAVY ROUND-TIPPED RIGHTWARDS ARROW", "arrow", "bold"],
  ["➤", "BLACK RIGHTWARDS ARROWHEAD", "arrow", "pointer", "prompt"],
  ["⌘", "PLACE OF INTEREST SIGN", "command", "cmd", "mac", "key"],
  ["⌥", "OPTION KEY", "option", "alt", "mac", "key"],
  ["⌃", "UP ARROWHEAD", "control", "ctrl", "key"],
  ["⇧", "UPWARDS WHITE ARROW", "shift", "key"],
  ["⇪", "UPWARDS WHITE ARROW FROM BAR", "caps lock", "key"],
  ["⇥", "RIGHTWARDS ARROW TO BAR", "tab", "key"],
  ["⇤", "LEFTWARDS ARROW TO BAR", "backtab", "shift tab", "key"],
  ["⌫", "ERASE TO THE LEFT", "backspace", "delete", "key"],
  ["⌦", "ERASE TO THE RIGHT", "delete", "forward delete", "key"],
  ["⏎", "RETURN SYMBOL", "enter", "return", "key"],
  ["⎋", "BROKEN CIRCLE WITH NORTHWEST ARROW", "escape", "esc", "key"],
  ["⌤", "PROJECTIVE", "enter", "key"],
  ["␣", "OPEN BOX", "space", "spacebar", "key"],
  ["⏏", "EJECT SYMBOL", "eject", "key"],
  ["⏻", "POWER SYMBOL", "power", "key"],
]);

const SCRIPTS = rows([
  ["⁰", "SUPERSCRIPT ZERO", "superscript", "0"],
  ["¹", "SUPERSCRIPT ONE", "superscript", "1"],
  ["²", "SUPERSCRIPT TWO", "superscript", "2", "squared"],
  ["³", "SUPERSCRIPT THREE", "superscript", "3", "cubed"],
  ["⁴", "SUPERSCRIPT FOUR", "superscript", "4"],
  ["⁵", "SUPERSCRIPT FIVE", "superscript", "5"],
  ["⁶", "SUPERSCRIPT SIX", "superscript", "6"],
  ["⁷", "SUPERSCRIPT SEVEN", "superscript", "7"],
  ["⁸", "SUPERSCRIPT EIGHT", "superscript", "8"],
  ["⁹", "SUPERSCRIPT NINE", "superscript", "9"],
  ["⁺", "SUPERSCRIPT PLUS SIGN", "superscript", "plus"],
  ["⁻", "SUPERSCRIPT MINUS", "superscript", "minus"],
  ["⁼", "SUPERSCRIPT EQUALS SIGN", "superscript", "equals"],
  ["⁽", "SUPERSCRIPT LEFT PARENTHESIS", "superscript", "paren"],
  ["⁾", "SUPERSCRIPT RIGHT PARENTHESIS", "superscript", "paren"],
  ["ⁿ", "SUPERSCRIPT LATIN SMALL LETTER N", "superscript", "n"],
  ["ⁱ", "SUPERSCRIPT LATIN SMALL LETTER I", "superscript", "i"],
  ["ª", "FEMININE ORDINAL INDICATOR", "superscript", "ordinal", "spanish"],
  ["º", "MASCULINE ORDINAL INDICATOR", "superscript", "ordinal", "spanish"],
  ["₀", "SUBSCRIPT ZERO", "subscript", "0"],
  ["₁", "SUBSCRIPT ONE", "subscript", "1"],
  ["₂", "SUBSCRIPT TWO", "subscript", "2"],
  ["₃", "SUBSCRIPT THREE", "subscript", "3"],
  ["₄", "SUBSCRIPT FOUR", "subscript", "4"],
  ["₅", "SUBSCRIPT FIVE", "subscript", "5"],
  ["₆", "SUBSCRIPT SIX", "subscript", "6"],
  ["₇", "SUBSCRIPT SEVEN", "subscript", "7"],
  ["₈", "SUBSCRIPT EIGHT", "subscript", "8"],
  ["₉", "SUBSCRIPT NINE", "subscript", "9"],
  ["₊", "SUBSCRIPT PLUS SIGN", "subscript", "plus"],
  ["₋", "SUBSCRIPT MINUS", "subscript", "minus"],
  ["₌", "SUBSCRIPT EQUALS SIGN", "subscript", "equals"],
  ["₍", "SUBSCRIPT LEFT PARENTHESIS", "subscript", "paren"],
  ["₎", "SUBSCRIPT RIGHT PARENTHESIS", "subscript", "paren"],
  ["ₐ", "LATIN SUBSCRIPT SMALL LETTER A", "subscript", "a"],
  ["ₑ", "LATIN SUBSCRIPT SMALL LETTER E", "subscript", "e"],
  ["ₒ", "LATIN SUBSCRIPT SMALL LETTER O", "subscript", "o"],
  ["ₓ", "LATIN SUBSCRIPT SMALL LETTER X", "subscript", "x"],
  ["ₕ", "LATIN SUBSCRIPT SMALL LETTER H", "subscript", "h"],
  ["ₖ", "LATIN SUBSCRIPT SMALL LETTER K", "subscript", "k"],
  ["ₗ", "LATIN SUBSCRIPT SMALL LETTER L", "subscript", "l"],
  ["ₘ", "LATIN SUBSCRIPT SMALL LETTER M", "subscript", "m"],
  ["ₙ", "LATIN SUBSCRIPT SMALL LETTER N", "subscript", "n"],
  ["ₚ", "LATIN SUBSCRIPT SMALL LETTER P", "subscript", "p"],
  ["ₛ", "LATIN SUBSCRIPT SMALL LETTER S", "subscript", "s"],
  ["ₜ", "LATIN SUBSCRIPT SMALL LETTER T", "subscript", "t"],
]);

const NUMBERS = rows([
  ["½", "VULGAR FRACTION ONE HALF", "fraction", "half", "1/2"],
  ["⅓", "VULGAR FRACTION ONE THIRD", "fraction", "third", "1/3"],
  ["⅔", "VULGAR FRACTION TWO THIRDS", "fraction", "2/3"],
  ["¼", "VULGAR FRACTION ONE QUARTER", "fraction", "quarter", "1/4"],
  ["¾", "VULGAR FRACTION THREE QUARTERS", "fraction", "3/4"],
  ["⅕", "VULGAR FRACTION ONE FIFTH", "fraction", "1/5"],
  ["⅖", "VULGAR FRACTION TWO FIFTHS", "fraction", "2/5"],
  ["⅗", "VULGAR FRACTION THREE FIFTHS", "fraction", "3/5"],
  ["⅘", "VULGAR FRACTION FOUR FIFTHS", "fraction", "4/5"],
  ["⅙", "VULGAR FRACTION ONE SIXTH", "fraction", "1/6"],
  ["⅚", "VULGAR FRACTION FIVE SIXTHS", "fraction", "5/6"],
  ["⅐", "VULGAR FRACTION ONE SEVENTH", "fraction", "1/7"],
  ["⅛", "VULGAR FRACTION ONE EIGHTH", "fraction", "1/8"],
  ["⅜", "VULGAR FRACTION THREE EIGHTHS", "fraction", "3/8"],
  ["⅝", "VULGAR FRACTION FIVE EIGHTHS", "fraction", "5/8"],
  ["⅞", "VULGAR FRACTION SEVEN EIGHTHS", "fraction", "7/8"],
  ["⅑", "VULGAR FRACTION ONE NINTH", "fraction", "1/9"],
  ["⅒", "VULGAR FRACTION ONE TENTH", "fraction", "1/10"],
  ["↉", "VULGAR FRACTION ZERO THIRDS", "fraction", "0/3"],
  ["⅟", "FRACTION NUMERATOR ONE", "fraction"],
  ["Ⅰ", "ROMAN NUMERAL ONE", "roman", "1"],
  ["Ⅱ", "ROMAN NUMERAL TWO", "roman", "2"],
  ["Ⅲ", "ROMAN NUMERAL THREE", "roman", "3"],
  ["Ⅳ", "ROMAN NUMERAL FOUR", "roman", "4"],
  ["Ⅴ", "ROMAN NUMERAL FIVE", "roman", "5"],
  ["Ⅵ", "ROMAN NUMERAL SIX", "roman", "6"],
  ["Ⅶ", "ROMAN NUMERAL SEVEN", "roman", "7"],
  ["Ⅷ", "ROMAN NUMERAL EIGHT", "roman", "8"],
  ["Ⅸ", "ROMAN NUMERAL NINE", "roman", "9"],
  ["Ⅹ", "ROMAN NUMERAL TEN", "roman", "10"],
  ["Ⅺ", "ROMAN NUMERAL ELEVEN", "roman", "11"],
  ["Ⅻ", "ROMAN NUMERAL TWELVE", "roman", "12"],
  ["Ⅼ", "ROMAN NUMERAL FIFTY", "roman", "50"],
  ["Ⅽ", "ROMAN NUMERAL ONE HUNDRED", "roman", "100"],
  ["Ⅾ", "ROMAN NUMERAL FIVE HUNDRED", "roman", "500"],
  ["Ⅿ", "ROMAN NUMERAL ONE THOUSAND", "roman", "1000"],
  ["ⅰ", "SMALL ROMAN NUMERAL ONE", "roman", "1"],
  ["ⅱ", "SMALL ROMAN NUMERAL TWO", "roman", "2"],
  ["ⅲ", "SMALL ROMAN NUMERAL THREE", "roman", "3"],
  ["ⅳ", "SMALL ROMAN NUMERAL FOUR", "roman", "4"],
  ["ⅴ", "SMALL ROMAN NUMERAL FIVE", "roman", "5"],
  ["ⅹ", "SMALL ROMAN NUMERAL TEN", "roman", "10"],
  ["⓪", "CIRCLED DIGIT ZERO", "circled", "0"],
  ["①", "CIRCLED DIGIT ONE", "circled", "1"],
  ["②", "CIRCLED DIGIT TWO", "circled", "2"],
  ["③", "CIRCLED DIGIT THREE", "circled", "3"],
  ["④", "CIRCLED DIGIT FOUR", "circled", "4"],
  ["⑤", "CIRCLED DIGIT FIVE", "circled", "5"],
  ["⑥", "CIRCLED DIGIT SIX", "circled", "6"],
  ["⑦", "CIRCLED DIGIT SEVEN", "circled", "7"],
  ["⑧", "CIRCLED DIGIT EIGHT", "circled", "8"],
  ["⑨", "CIRCLED DIGIT NINE", "circled", "9"],
  ["⑩", "CIRCLED NUMBER TEN", "circled", "10"],
  ["№", "NUMERO SIGN", "number", "no"],
]);

const BOX = rows([
  ["─", "BOX DRAWINGS LIGHT HORIZONTAL", "box", "line"],
  ["━", "BOX DRAWINGS HEAVY HORIZONTAL", "box", "line"],
  ["│", "BOX DRAWINGS LIGHT VERTICAL", "box", "line"],
  ["┃", "BOX DRAWINGS HEAVY VERTICAL", "box", "line"],
  ["┄", "BOX DRAWINGS LIGHT TRIPLE DASH HORIZONTAL", "box", "dashed"],
  ["┆", "BOX DRAWINGS LIGHT TRIPLE DASH VERTICAL", "box", "dashed"],
  ["┈", "BOX DRAWINGS LIGHT QUADRUPLE DASH HORIZONTAL", "box", "dashed"],
  ["┊", "BOX DRAWINGS LIGHT QUADRUPLE DASH VERTICAL", "box", "dashed"],
  ["┌", "BOX DRAWINGS LIGHT DOWN AND RIGHT", "box", "corner"],
  ["┐", "BOX DRAWINGS LIGHT DOWN AND LEFT", "box", "corner"],
  ["└", "BOX DRAWINGS LIGHT UP AND RIGHT", "box", "corner"],
  ["┘", "BOX DRAWINGS LIGHT UP AND LEFT", "box", "corner"],
  ["├", "BOX DRAWINGS LIGHT VERTICAL AND RIGHT", "box", "tee"],
  ["┤", "BOX DRAWINGS LIGHT VERTICAL AND LEFT", "box", "tee"],
  ["┬", "BOX DRAWINGS LIGHT DOWN AND HORIZONTAL", "box", "tee"],
  ["┴", "BOX DRAWINGS LIGHT UP AND HORIZONTAL", "box", "tee"],
  ["┼", "BOX DRAWINGS LIGHT VERTICAL AND HORIZONTAL", "box", "cross"],
  ["┏", "BOX DRAWINGS HEAVY DOWN AND RIGHT", "box", "corner"],
  ["┓", "BOX DRAWINGS HEAVY DOWN AND LEFT", "box", "corner"],
  ["┗", "BOX DRAWINGS HEAVY UP AND RIGHT", "box", "corner"],
  ["┛", "BOX DRAWINGS HEAVY UP AND LEFT", "box", "corner"],
  ["┣", "BOX DRAWINGS HEAVY VERTICAL AND RIGHT", "box", "tee"],
  ["┫", "BOX DRAWINGS HEAVY VERTICAL AND LEFT", "box", "tee"],
  ["┳", "BOX DRAWINGS HEAVY DOWN AND HORIZONTAL", "box", "tee"],
  ["┻", "BOX DRAWINGS HEAVY UP AND HORIZONTAL", "box", "tee"],
  ["╋", "BOX DRAWINGS HEAVY VERTICAL AND HORIZONTAL", "box", "cross"],
  ["═", "BOX DRAWINGS DOUBLE HORIZONTAL", "box", "line"],
  ["║", "BOX DRAWINGS DOUBLE VERTICAL", "box", "line"],
  ["╔", "BOX DRAWINGS DOUBLE DOWN AND RIGHT", "box", "corner"],
  ["╗", "BOX DRAWINGS DOUBLE DOWN AND LEFT", "box", "corner"],
  ["╚", "BOX DRAWINGS DOUBLE UP AND RIGHT", "box", "corner"],
  ["╝", "BOX DRAWINGS DOUBLE UP AND LEFT", "box", "corner"],
  ["╠", "BOX DRAWINGS DOUBLE VERTICAL AND RIGHT", "box", "tee"],
  ["╣", "BOX DRAWINGS DOUBLE VERTICAL AND LEFT", "box", "tee"],
  ["╦", "BOX DRAWINGS DOUBLE DOWN AND HORIZONTAL", "box", "tee"],
  ["╩", "BOX DRAWINGS DOUBLE UP AND HORIZONTAL", "box", "tee"],
  ["╬", "BOX DRAWINGS DOUBLE VERTICAL AND HORIZONTAL", "box", "cross"],
  ["╭", "BOX DRAWINGS LIGHT ARC DOWN AND RIGHT", "box", "rounded", "corner"],
  ["╮", "BOX DRAWINGS LIGHT ARC DOWN AND LEFT", "box", "rounded", "corner"],
  ["╰", "BOX DRAWINGS LIGHT ARC UP AND RIGHT", "box", "rounded", "corner"],
  ["╯", "BOX DRAWINGS LIGHT ARC UP AND LEFT", "box", "rounded", "corner"],
  ["╱", "BOX DRAWINGS LIGHT DIAGONAL UPPER RIGHT TO LOWER LEFT", "box", "diagonal"],
  ["╲", "BOX DRAWINGS LIGHT DIAGONAL UPPER LEFT TO LOWER RIGHT", "box", "diagonal"],
  ["╳", "BOX DRAWINGS LIGHT DIAGONAL CROSS", "box", "cross"],
  ["█", "FULL BLOCK", "block", "bar", "solid"],
  ["▉", "LEFT SEVEN EIGHTHS BLOCK", "block", "bar"],
  ["▊", "LEFT THREE QUARTERS BLOCK", "block", "bar"],
  ["▋", "LEFT FIVE EIGHTHS BLOCK", "block", "bar"],
  ["▌", "LEFT HALF BLOCK", "block", "bar"],
  ["▍", "LEFT THREE EIGHTHS BLOCK", "block", "bar"],
  ["▎", "LEFT ONE QUARTER BLOCK", "block", "bar"],
  ["▏", "LEFT ONE EIGHTH BLOCK", "block", "bar"],
  ["▐", "RIGHT HALF BLOCK", "block", "bar"],
  ["▀", "UPPER HALF BLOCK", "block", "bar"],
  ["▄", "LOWER HALF BLOCK", "block", "bar"],
  ["▁", "LOWER ONE EIGHTH BLOCK", "block", "sparkline"],
  ["▂", "LOWER ONE QUARTER BLOCK", "block", "sparkline"],
  ["▃", "LOWER THREE EIGHTHS BLOCK", "block", "sparkline"],
  ["▅", "LOWER FIVE EIGHTHS BLOCK", "block", "sparkline"],
  ["▆", "LOWER THREE QUARTERS BLOCK", "block", "sparkline"],
  ["▇", "LOWER SEVEN EIGHTHS BLOCK", "block", "sparkline"],
  ["░", "LIGHT SHADE", "shade", "dither"],
  ["▒", "MEDIUM SHADE", "shade", "dither"],
  ["▓", "DARK SHADE", "shade", "dither"],
]);

const SHAPES = rows([
  ["●", "BLACK CIRCLE", "circle", "dot", "filled"],
  ["○", "WHITE CIRCLE", "circle", "dot", "hollow"],
  ["◉", "FISHEYE", "circle", "radio", "selected"],
  ["◎", "BULLSEYE", "circle", "target"],
  ["◌", "DOTTED CIRCLE", "circle", "placeholder"],
  ["◐", "CIRCLE WITH LEFT HALF BLACK", "circle", "half"],
  ["◑", "CIRCLE WITH RIGHT HALF BLACK", "circle", "half"],
  ["■", "BLACK SQUARE", "square", "filled", "stop"],
  ["□", "WHITE SQUARE", "square", "hollow"],
  ["▢", "WHITE SQUARE WITH ROUNDED CORNERS", "square", "rounded"],
  ["▣", "WHITE SQUARE CONTAINING BLACK SMALL SQUARE", "square"],
  ["▪", "BLACK SMALL SQUARE", "square", "bullet"],
  ["▫", "WHITE SMALL SQUARE", "square", "bullet"],
  ["▬", "BLACK RECTANGLE", "rectangle", "bar"],
  ["◆", "BLACK DIAMOND", "diamond", "filled"],
  ["◇", "WHITE DIAMOND", "diamond", "hollow"],
  ["◈", "WHITE DIAMOND CONTAINING BLACK SMALL DIAMOND", "diamond"],
  ["◊", "LOZENGE", "diamond"],
  ["▲", "BLACK UP-POINTING TRIANGLE", "triangle", "up", "increase"],
  ["△", "WHITE UP-POINTING TRIANGLE", "triangle", "up"],
  ["▼", "BLACK DOWN-POINTING TRIANGLE", "triangle", "down", "decrease"],
  ["▽", "WHITE DOWN-POINTING TRIANGLE", "triangle", "down"],
  ["◀", "BLACK LEFT-POINTING TRIANGLE", "triangle", "left", "previous"],
  ["▶", "BLACK RIGHT-POINTING TRIANGLE", "triangle", "right", "play", "next"],
  ["◤", "BLACK UPPER LEFT TRIANGLE", "triangle", "corner"],
  ["◥", "BLACK UPPER RIGHT TRIANGLE", "triangle", "corner"],
  ["◣", "BLACK LOWER LEFT TRIANGLE", "triangle", "corner"],
  ["◢", "BLACK LOWER RIGHT TRIANGLE", "triangle", "corner"],
  ["★", "BLACK STAR", "star", "favorite", "filled"],
  ["☆", "WHITE STAR", "star", "favorite", "hollow"],
  ["✦", "BLACK FOUR POINTED STAR", "star", "sparkle"],
  ["✧", "WHITE FOUR POINTED STAR", "star", "sparkle"],
  ["✱", "HEAVY ASTERISK", "asterisk", "star"],
  ["✳", "EIGHT SPOKED ASTERISK", "asterisk", "star"],
  ["❖", "BLACK DIAMOND MINUS WHITE X", "diamond", "ornament"],
  ["✓", "CHECK MARK", "check", "tick", "done", "yes"],
  ["✔", "HEAVY CHECK MARK", "check", "tick", "done", "yes"],
  ["✗", "BALLOT X", "cross", "x", "no", "fail"],
  ["✘", "HEAVY BALLOT X", "cross", "x", "no", "fail"],
  ["☐", "BALLOT BOX", "checkbox", "empty", "todo"],
  ["☑", "BALLOT BOX WITH CHECK", "checkbox", "checked", "done"],
  ["☒", "BALLOT BOX WITH X", "checkbox", "rejected"],
  ["⚠", "WARNING SIGN", "warning", "caution", "alert"],
  ["♠", "BLACK SPADE SUIT", "spade", "card", "suit"],
  ["♣", "BLACK CLUB SUIT", "club", "card", "suit"],
  ["♥", "BLACK HEART SUIT", "heart", "card", "suit", "love"],
  ["♦", "BLACK DIAMOND SUIT", "diamond", "card", "suit"],
  ["♪", "EIGHTH NOTE", "music", "note"],
  ["♫", "BEAMED EIGHTH NOTES", "music", "note"],
  ["♬", "BEAMED SIXTEENTH NOTES", "music", "note"],
  ["♭", "MUSIC FLAT SIGN", "music", "flat"],
  ["♮", "MUSIC NATURAL SIGN", "music", "natural"],
  ["♯", "MUSIC SHARP SIGN", "music", "sharp"],
  ["☼", "WHITE SUN WITH RAYS", "sun", "weather", "brightness"],
  ["☽", "FIRST QUARTER MOON", "moon", "night"],
  ["☾", "LAST QUARTER MOON", "moon", "night"],
  ["⚑", "BLACK FLAG", "flag", "marker"],
  ["⚐", "WHITE FLAG", "flag", "marker"],
  ["⚙", "GEAR", "gear", "settings", "cog"],
  ["⚖", "SCALES", "scales", "balance", "justice"],
  ["⚛", "ATOM SYMBOL", "atom", "science", "physics"],
  ["☢", "RADIOACTIVE SIGN", "radioactive", "hazard"],
  ["☣", "BIOHAZARD SIGN", "biohazard", "hazard"],
  ["⚕", "STAFF OF AESCULAPIUS", "medical", "health"],
  ["✂", "BLACK SCISSORS", "scissors", "cut"],
  ["✈", "AIRPLANE", "plane", "flight", "travel"],
  ["✉", "ENVELOPE", "mail", "email", "letter"],
  ["✎", "LOWER RIGHT PENCIL", "pencil", "edit", "write"],
  ["✍", "WRITING HAND", "write", "sign"],
  ["☞", "WHITE RIGHT POINTING INDEX", "hand", "pointer", "note"],
  ["☜", "WHITE LEFT POINTING INDEX", "hand", "pointer"],
  ["⌂", "HOUSE", "home", "house"],
  ["⌁", "ELECTRIC ARROW", "electric", "power"],
]);

const MISC = rows([
  ["©", "COPYRIGHT SIGN", "copyright", "legal"],
  ["®", "REGISTERED SIGN", "registered", "trademark", "legal"],
  ["™", "TRADE MARK SIGN", "trademark", "tm", "legal"],
  ["℠", "SERVICE MARK", "service mark", "sm", "legal"],
  ["℗", "SOUND RECORDING COPYRIGHT", "phonogram", "legal"],
  ["℅", "CARE OF", "care of", "address"],
  ["℡", "TELEPHONE SIGN", "telephone", "phone"],
  ["℞", "PRESCRIPTION TAKE", "prescription", "rx", "medical"],
  ["℮", "ESTIMATED SYMBOL", "estimated", "packaging"],
  ["⌀", "DIAMETER SIGN", "diameter", "engineering"],
  ["⏚", "EARTH GROUND", "ground", "earth", "electrical"],
  ["⌬", "BENZENE RING", "benzene", "chemistry"],
  ["☠", "SKULL AND CROSSBONES", "skull", "poison", "danger"],
  ["☯", "YIN YANG", "yin yang", "balance"],
  ["☮", "PEACE SYMBOL", "peace"],
  ["⚭", "MARRIAGE SYMBOL", "marriage"],
]);

/**
 * Characters with no visible form. They are genuinely useful — a non-breaking
 * space is the fix for a line break landing between a number and its unit —
 * but an empty grid cell tells you nothing, so each carries a short label the
 * cell shows in its place.
 */
const INVISIBLE: Glyph[] = [
  { c: " ", name: "NO-BREAK SPACE", alias: ["nbsp", "space", "hard space"], label: "NBSP" },
  { c: " ", name: "EN SPACE", alias: ["space"], label: "ENSP" },
  { c: " ", name: "EM SPACE", alias: ["space"], label: "EMSP" },
  { c: " ", name: "THIN SPACE", alias: ["space"], label: "THSP" },
  { c: " ", name: "HAIR SPACE", alias: ["space"], label: "HRSP" },
  { c: " ", name: "NARROW NO-BREAK SPACE", alias: ["nbsp", "space"], label: "NNBSP" },
  { c: "​", name: "ZERO WIDTH SPACE", alias: ["zwsp", "space", "break"], label: "ZWSP" },
  { c: "‌", name: "ZERO WIDTH NON-JOINER", alias: ["zwnj"], label: "ZWNJ" },
  { c: "‍", name: "ZERO WIDTH JOINER", alias: ["zwj", "join"], label: "ZWJ" },
  { c: "⁠", name: "WORD JOINER", alias: ["no break"], label: "WJ" },
  { c: "­", name: "SOFT HYPHEN", alias: ["shy", "hyphen"], label: "SHY" },
  { c: "‎", name: "LEFT-TO-RIGHT MARK", alias: ["ltr", "bidi"], label: "LRM" },
  { c: "‏", name: "RIGHT-TO-LEFT MARK", alias: ["rtl", "bidi"], label: "RLM" },
];

// --- the catalog -----------------------------------------------------------

export const CATEGORIES: Category[] = [
  {
    id: "letters",
    label: "LETTERS",
    glyphs: [...deriveLetters(), ...STANDALONE_LETTERS].sort(byBaseThenCase),
  },
  { id: "punctuation", label: "PUNCT", glyphs: PUNCTUATION },
  { id: "currency", label: "CURRENCY", glyphs: CURRENCY },
  { id: "math", label: "MATH", glyphs: MATH },
  { id: "arrows", label: "ARROWS", glyphs: ARROWS },
  { id: "greek", label: "GREEK", glyphs: [...deriveGreek(), ...GREEK_VARIANTS] },
  { id: "scripts", label: "SUPER/SUB", glyphs: SCRIPTS },
  { id: "numbers", label: "NUMBERS", glyphs: NUMBERS },
  { id: "box", label: "BOX", glyphs: BOX },
  { id: "shapes", label: "SHAPES", glyphs: SHAPES },
  { id: "misc", label: "MISC", glyphs: [...MISC, ...INVISIBLE] },
];

/** Every glyph, in category order — the corpus search runs over. */
export const ALL_GLYPHS: Glyph[] = CATEGORIES.flatMap((cat) => cat.glyphs);

/** Character → glyph, for rehydrating persisted recents. */
export const BY_CHAR: ReadonlyMap<string, Glyph> = new Map(ALL_GLYPHS.map((g) => [g.c, g]));

/**
 * BMP characters with Emoji_Presentation=Yes — the ones that render in color
 * by default even without a variation selector. Excluded from the catalog so
 * the grid stays monochrome; their text-presentation neighbours (★ ✓ ⚠) stay.
 */
export const EMOJI_PRESENTATION: ReadonlySet<number> = new Set([
  0x231a, 0x231b, 0x23e9, 0x23ea, 0x23eb, 0x23ec, 0x23f0, 0x23f3, 0x25fd, 0x25fe, 0x2614, 0x2615,
  0x2648, 0x2649, 0x264a, 0x264b, 0x264c, 0x264d, 0x264e, 0x264f, 0x2650, 0x2651, 0x2652, 0x2653,
  0x267f, 0x2693, 0x26a1, 0x26aa, 0x26ab, 0x26bd, 0x26be, 0x26c4, 0x26c5, 0x26ce, 0x26d4, 0x26ea,
  0x26f2, 0x26f3, 0x26f5, 0x26fa, 0x26fd, 0x2705, 0x270a, 0x270b, 0x2728, 0x274c, 0x274e, 0x2753,
  0x2754, 0x2755, 0x2757, 0x2795, 0x2796, 0x2797, 0x27b0, 0x27bf, 0x2b1b, 0x2b1c, 0x2b50, 0x2b55,
]);
