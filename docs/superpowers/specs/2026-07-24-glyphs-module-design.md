# Glyphs — special character picker (module design)

Date: 2026-07-24

## Purpose

A brucekit module for inserting characters a keyboard doesn't have: accented
letters, typographic punctuation, currency, math, arrows, Greek, fractions,
box-drawing, and marks. Search it, browse it, copy it.

Emoji are explicitly out of scope — Windows already has a picker for those
(`Win+.`), and mixing them in would bury the characters this module exists for.

## Contract

A `panel` tool at `src/tools/glyphs/`, auto-registered by the existing
`import.meta.glob` in `src/tools/registry.ts`. No edits to any other source
file except `src/styles/global.css`, which is where every module's styles
already live.

No new Rust. Copying goes through `writeText` from
`@tauri-apps/plugin-clipboard-manager`, the same path the color picker uses.

```
id:          "glyphs"
name:        "Special characters"
description: (none — see Layout)
kind:        "panel"
keepOpen:    false
```

## Layout

```
★ [é][—][→][€]                             pinned rail, survives everything
> _____________________________  148        search, auto-focused, live hit count
[ RECENT ][ LETTERS ][ PUNCT ][ MATH ][ … ] category chips, Tab cycles
┌────┬────┬────┬────┬────┬────┬────┐
│ é  │ ê  │ ë  │ ē  │ ĕ  │ ė  │ ę  │        glyph grid, arrows move highlight
└────┴────┴────┴────┴────┴────┴────┘
é  LATIN SMALL LETTER E WITH ACUTE          status line for the selection
CLICK/ENTER copy · ★ CTRL+P pin · TAB       hint row
```

The name lives in a fixed status line rather than a tooltip: no hover flicker,
and it reads correctly during keyboard navigation, which a tooltip does not.
No codepoint — it is a lookup detail, not something worth a permanent slot,
and `u+00e9` still works as a *query*.

The module deliberately declares no `description`. A subtitle in the panel
header would be one more line of chrome between the user and a dense grid of
characters; the keywords carry the search terms it would have provided.

Search and category are mutually exclusive views. A non-empty query searches
the whole catalog and the chip row shows no active chip; clicking a chip clears
the query. One selection model, no ambiguity about what the grid is showing.

## Finding a character

1. **Base-letter expansion.** A single-letter query is special-cased: `e`
   ranks `è é ê ë ē ĕ ė ę ě` above everything else. Case is honored — `E`
   puts the capitals first.
2. **Name / alias search.** `euro`, `em dash`, `degree`, `check`, `arrow
   right`. Multi-token queries require every token to match.
3. **Codepoint.** `u+00e9`, `U+00E9`, `0x00e9`, or bare `00e9`.
4. **The character itself.** Pasting `é` finds `é` — useful for identifying
   something you already have.
5. **Category browse.** Chips filter the grid.

Recents (last 24, persisted in the module's namespaced settings) get their own
chip and are the default view when the module has history.

There is no way to clear recents, deliberately. The list is capped at 24 and
rolls over on its own, so it can only ever be 24 characters of clutter — not
enough to earn a destructive control sitting in the chip row.

## Pins

Every cell carries a corner star: click it to pin, click it again to unpin,
or press `Ctrl+P` to pin whatever the highlight is on. Pinned characters
appear in a rail above the search field that is unaffected by the query or the
category — the whole point of pinning is a fixed position to aim at, so one
click on the rail copies, always, from anywhere in the module.

The star is a sibling of the copy target, not nested inside it: nested buttons
are invalid markup, and more practically a click near the corner must mean pin
and only pin. Stars stay at `opacity: 0` until a cell is hovered or selected —
500 cells wearing 500 stars would be louder than the characters they belong
to — but a *lit* star is always visible, so pin state is legible from the grid
and not only from the rail.

New pins append rather than insert. A rail that reshuffled every time you
pinned something else would destroy the muscle memory that makes it useful.

## Data

`data.ts` exports a catalog of `Glyph { c, name, alias?, base? }` grouped into
`Category { id, label, glyphs }`.

Accented Latin is **derived, not typed**: the builder walks codepoints
U+00C0–U+024F, keeps those whose NFD decomposition starts with an ASCII letter
and continues with known combining marks, and synthesizes the Unicode-style
name (`LATIN SMALL LETTER E WITH ACUTE`), the aliases (`acute`, `e`), and the
`base` field from the decomposition. 518 letters with zero hand-entry and no
transcription errors. Letters that don't decompose (`ø æ œ ß ł đ þ ð ħ ŋ ı ŧ ƒ`)
are listed explicitly.

Letters sort by base rather than codepoint, so browsing reads `à á â ã ä å ā ă`
then `b`, `c`, `ç` — not the codepoint order that scatters each letter's
variants across four Unicode blocks.

The remaining categories are hand-written lists with names and aliases:
punctuation & dashes, currency, math & logic, arrows & keys, Greek,
super/subscript, fractions & Roman numerals, box-drawing & blocks, shapes &
marks, legal & misc. 1,048 glyphs total.

A last group has no visible form at all — non-breaking space, zero-width
space, soft hyphen, the bidi marks. They are genuinely useful and genuinely
un-renderable, so each carries a `label` (`NBSP`, `ZWSP`) that the cell shows
in a dashed box; an empty cell would be indistinguishable from a font failure.

**The no-emoji rule is enforced by a test, not by discipline.** `data.test.ts`
asserts that no glyph contains a codepoint at or above U+1F000, none appears in
the BMP `Emoji_Presentation=Yes` set (exported from `data.ts`), and none carries
a variation selector. Monochrome text-presentation symbols (`★ ✓ ♥ ⚠`) stay;
their color-by-default neighbours (`⭐ ✅ ❌ ⚡`) are excluded by the same rule.

## Modules

| File | Responsibility |
|---|---|
| `index.tsx` | Module manifest |
| `icon.tsx` | Monochrome SVG icon |
| `data.ts` | Catalog, categories, emoji deny-set |
| `search.ts` | **Pure.** Codepoint parse, ranking, category filter |
| `lists.ts` | **Pure.** Recents and pin list operations |
| `GlyphsPanel.tsx` | UI, keyboard, clipboard, persistence |

Ranking logic and recents operations live outside the component so they are
unit-testable in isolation, matching `color.ts`, `graph.ts`, and `format.ts`.

### Ranking

| Match | Score |
|---|---|
| Query is the character itself | 120 |
| Codepoint match | 110 |
| Single-letter query, base matches with case | 100 |
| Single-letter query, base matches ignoring case | 90 |
| Exact name | 80 |
| Name prefix | 70 |
| Exact alias | 65 |
| Multi-token, all tokens matched | 55 |
| Name substring | 50 |
| Alias substring | 40 |

Ties break on catalog order, so results never shuffle between keystrokes.

## Keyboard

The search input holds focus at all times; the grid is driven from a key
handler on the panel wrapper.

| Key | Action |
|---|---|
| Arrows | Move the highlight (column count read from the live grid template) |
| Home / End | First / last result |
| Enter | Copy the highlighted glyph |
| Ctrl+P | Pin / unpin the highlighted glyph |
| Tab / Shift+Tab | Cycle category chips |
| Esc | Handled by the launcher — closes the panel |

Grid cells are real buttons with `aria-label`, but carry `tabIndex={-1}` and
return focus to the input after a click, so the typing target never moves.

## Behavior on copy

Write the character, toast `Copied é · LATIN SMALL LETTER E WITH ACUTE`, push
to recents, and **stay open** — collecting several characters in a row is the
common case. A rejected clipboard write surfaces as an error toast via
`errorMessage`; panel state is untouched.

The panel renders inside the launcher's existing per-tool error boundary, so a
throw here cannot take down the launcher.

## Tests

- `search.test.ts` — base expansion and case priority, codepoint forms,
  literal-character lookup, multi-token AND, ranking order, tie stability,
  empty query.
- `lists.test.ts` — recents insert, dedupe-to-front, cap at 24; pin toggle,
  append order, stability of other pins; hydrate against the catalog and drop
  unknown characters.
- `data.test.ts` — unique characters, every glyph named, every derived letter
  has a `base`, no emoji, no variation selectors, categories non-empty.
- `GlyphsPanel.test.tsx` — renders a grid, filters on typing, arrow keys move
  the selection, Enter copies and toasts, clicking a cell copies, the star and
  Ctrl+P pin, the rail survives an unrelated query and copies on one click,
  and the rail stays hidden until something is pinned.
