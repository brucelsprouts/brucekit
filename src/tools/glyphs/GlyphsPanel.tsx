import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { ToolContext } from "../types";
import { errorMessage } from "../../core/ipc";
import { ALL_GLYPHS, BY_CHAR, CATEGORIES, type Glyph } from "./data";
import { altCode, altCodeHint } from "./altcodes";
import { searchGlyphs } from "./search";
import { hydrateChars, pushRecent, togglePin } from "./lists";

/** The recents pseudo-category. Only offered once there is something in it. */
const RECENT_ID = "recent";
const DEFAULT_CATEGORY = CATEGORIES[0].id;

/**
 * Special characters panel: search or browse the catalog, click or Enter to
 * copy, star to pin.
 *
 * Search and category are one selection, not two filters. A non-empty query
 * searches the whole catalog and no chip is lit; clicking a chip clears the
 * query. Anything else means answering "why is my search finding nothing?"
 * with "because a chip you forgot about is also filtering" — which is exactly
 * the kind of hidden state this UI shouldn't have.
 *
 * Pins are the exception, and deliberately so: the rail sits above the search
 * field and survives every query and category, because the characters you pin
 * are the ones you want without looking for them.
 *
 * The search field keeps focus the entire time the panel is open, including
 * after clicking a cell. Arrow keys drive a highlight through the grid from
 * there, so you can type, steer, and copy without ever moving the caret.
 */
export function GlyphsPanel({ ctx }: { ctx: ToolContext }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>(DEFAULT_CATEGORY);
  const [recent, setRecent] = useState<string[]>([]);
  const [pinned, setPinned] = useState<string[]>([]);
  const [selected, setSelected] = useState(0);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  /** Guards the persistence effects until the stored state has been read. */
  const ready = useRef(false);

  // Restore pins, recents, and the last category once.
  useEffect(() => {
    let alive = true;
    Promise.all([
      ctx.settings.get<string[]>("pinned", []),
      ctx.settings.get<string[]>("recent", []),
      ctx.settings.get<string>("category", DEFAULT_CATEGORY),
    ])
      .then(([pins, chars, cat]) => {
        if (!alive) return;
        setPinned(pins);
        setRecent(chars);
        // A stored category that no longer exists (or "recent" with an empty
        // list) would render a blank grid with no lit chip, so fall back.
        const known = cat === RECENT_ID ? chars.length > 0 : CATEGORIES.some((c) => c.id === cat);
        setCategory(known ? cat : DEFAULT_CATEGORY);
      })
      .catch(() => {})
      .finally(() => {
        ready.current = true;
      });
    return () => {
      alive = false;
    };
  }, [ctx]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const recentGlyphs = useMemo(() => hydrateChars(recent, BY_CHAR), [recent]);
  const pinnedGlyphs = useMemo(() => hydrateChars(pinned, BY_CHAR), [pinned]);
  const isPinned = useCallback((c: string) => pinned.includes(c), [pinned]);

  const chips = useMemo(() => {
    const base = CATEGORIES.map((c) => ({ id: c.id, label: c.label }));
    return recentGlyphs.length > 0 ? [{ id: RECENT_ID, label: "RECENT" }, ...base] : base;
  }, [recentGlyphs.length]);

  const searching = query.trim() !== "";

  const results = useMemo(() => {
    if (searching) return searchGlyphs(ALL_GLYPHS, query);
    if (category === RECENT_ID) return recentGlyphs;
    return CATEGORIES.find((c) => c.id === category)?.glyphs ?? [];
  }, [searching, query, category, recentGlyphs]);

  // Any change to what's on screen puts the highlight back on the first cell.
  useEffect(() => {
    setSelected(0);
  }, [query, category]);

  // Keep the highlight inside the list as it shrinks under a longer query.
  const active = results.length === 0 ? null : results[Math.min(selected, results.length - 1)];

  const copy = useCallback(
    async (glyph: Glyph) => {
      try {
        await writeText(glyph.c);
        ctx.toast(`Copied ${glyph.label ?? glyph.c} · ${glyph.name}`, { kind: "success" });
        setRecent((prev) => {
          const next = pushRecent(prev, glyph.c);
          void ctx.settings.set("recent", next).catch(() => {});
          return next;
        });
      } catch (err) {
        ctx.toast(errorMessage(err), { kind: "error" });
      }
    },
    [ctx],
  );

  const pin = useCallback(
    (glyph: Glyph) => {
      setPinned((prev) => {
        const next = togglePin(prev, glyph.c);
        void ctx.settings.set("pinned", next).catch(() => {});
        return next;
      });
      inputRef.current?.focus();
    },
    [ctx],
  );

  function chooseCategory(id: string) {
    setCategory(id);
    setQuery("");
    if (ready.current) void ctx.settings.set("category", id).catch(() => {});
    inputRef.current?.focus();
  }

  /**
   * How many cells sit on a row right now. Read off the live grid rather than
   * computed from a constant, so vertical movement stays correct at every
   * launcher width the user might have dragged to.
   */
  function columns(): number {
    const grid = gridRef.current;
    if (!grid) return 1;
    const template = getComputedStyle(grid).gridTemplateColumns;
    const count = template.split(" ").filter((part) => part.trim() !== "" && part !== "none").length;
    return Math.max(1, count);
  }

  function move(delta: number) {
    if (results.length === 0) return;
    setSelected((prev) => Math.min(results.length - 1, Math.max(0, prev + delta)));
  }

  function cycleCategory(step: number) {
    const index = chips.findIndex((c) => c.id === category);
    // While searching no chip is lit, so Tab enters the row at its start.
    const from = searching || index < 0 ? -1 : index;
    const next = (from + step + chips.length * 2) % chips.length;
    chooseCategory(chips[next].id);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    // Ctrl+P pins without leaving the keyboard, mirroring the star.
    if (e.key.toLowerCase() === "p" && (e.ctrlKey || e.metaKey)) {
      if (active) pin(active);
      e.preventDefault();
      return;
    }

    switch (e.key) {
      case "ArrowRight":
        move(1);
        break;
      case "ArrowLeft":
        move(-1);
        break;
      case "ArrowDown":
        move(columns());
        break;
      case "ArrowUp":
        move(-columns());
        break;
      case "Home":
        setSelected(0);
        break;
      case "End":
        setSelected(Math.max(0, results.length - 1));
        break;
      case "Enter":
        if (active) void copy(active);
        break;
      case "Tab":
        cycleCategory(e.shiftKey ? -1 : 1);
        break;
      default:
        return; // let the keystroke reach the input
    }
    e.preventDefault();
  }

  // Follow the highlight when arrow keys walk it off the visible rows.
  useEffect(() => {
    gridRef.current
      ?.querySelector(`[data-index="${selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected, results]);

  return (
    <div className="bk-glyphs" onKeyDown={onKeyDown}>
      {pinnedGlyphs.length > 0 && (
        <div className="bk-glyphs__pins" aria-label="Pinned characters">
          <span className="bk-glyphs__pins-mark" aria-hidden="true">
            ★
          </span>
          <div className="bk-glyphs__pins-rail">
            {pinnedGlyphs.map((glyph) => (
              <GlyphCell
                key={glyph.c}
                glyph={glyph}
                pinned
                onCopy={() => void copy(glyph)}
                onPin={() => pin(glyph)}
              />
            ))}
          </div>
        </div>
      )}

      <div className="bk-glyphs__search">
        <span className="bk-search__prompt" aria-hidden="true">
          &gt;
        </span>
        <input
          ref={inputRef}
          className="bk-glyphs__input"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="letter, name, or u+00e9"
          aria-label="Search characters"
          spellCheck={false}
          autoComplete="off"
        />
        <span className="bk-glyphs__count">{results.length}</span>
      </div>

      <div className="bk-glyphs__chips" role="tablist" aria-label="Categories">
        {chips.map((chip) => (
          <button
            key={chip.id}
            type="button"
            role="tab"
            aria-selected={!searching && category === chip.id}
            className="bk-glyphs__chip"
            data-active={!searching && category === chip.id}
            tabIndex={-1}
            onClick={() => chooseCategory(chip.id)}
          >
            {chip.label}
          </button>
        ))}
      </div>

      {results.length === 0 ? (
        <div className="bk-glyphs__empty">
          <span className="bk-label">NO MATCH</span>
        </div>
      ) : (
        <div className="bk-glyphs__grid" ref={gridRef} role="listbox" aria-label="Characters">
          {results.map((glyph, index) => (
            <GlyphCell
              key={glyph.c}
              glyph={glyph}
              index={index}
              selected={index === selected}
              pinned={isPinned(glyph.c)}
              onHover={() => setSelected(index)}
              onCopy={() => {
                setSelected(index);
                void copy(glyph);
              }}
              onPin={() => pin(glyph)}
            />
          ))}
        </div>
      )}

      <div className="bk-glyphs__status">
        {active ? (
          <>
            <span className="bk-glyphs__status-char">{active.label ?? active.c}</span>
            <span className="bk-glyphs__status-name">{active.name}</span>
            <AltCodeTag glyph={active} />
          </>
        ) : (
          <span className="bk-glyphs__status-name">—</span>
        )}
      </div>

      <div className="bk-glyphs__hint">
        <span className="bk-label">CLICK / ENTER COPY</span>
        <span className="bk-label">★ CTRL+P PIN</span>
        <span className="bk-label">TAB CATEGORY</span>
      </div>
    </div>
  );
}

/**
 * The highlighted character's Windows numpad code, when it has one.
 *
 * Renders nothing rather than "—" for the many characters that have none: an
 * absent tag reads as "not applicable", while a dash in a fixed slot invites
 * you to keep glancing at a field that is empty most of the time.
 */
function AltCodeTag({ glyph }: { glyph: Glyph }) {
  const code = altCode(glyph.c);
  if (code === null) return null;
  return (
    <span className="bk-glyphs__status-alt" title={altCodeHint(code)}>
      ALT&nbsp;{code.digits}
    </span>
  );
}

type CellProps = {
  glyph: Glyph;
  index?: number;
  selected?: boolean;
  pinned?: boolean;
  onCopy: () => void;
  onPin: () => void;
  onHover?: () => void;
};

/**
 * One character: the whole face copies, and a corner star pins.
 *
 * The star is a sibling of the copy target rather than nested inside it —
 * nested buttons are invalid, and more practically, a click near the corner
 * has to mean pin and only pin. It stays hidden until the cell is approached
 * so a wall of 500 cells doesn't read as a wall of 500 stars, but a lit star
 * on a pinned cell is always visible: pin state has to be legible at a glance
 * from the grid, not just from the rail.
 */
function GlyphCell({ glyph, index, selected, pinned, onCopy, onPin, onHover }: CellProps) {
  const code = altCode(glyph.c);
  const title = code === null ? glyph.name : `${glyph.name} · Alt ${code.digits}`;
  return (
    <div
      className="bk-glyphs__cell"
      role="option"
      aria-selected={selected === true}
      data-index={index}
      data-selected={selected === true}
      data-pinned={pinned === true}
      onMouseEnter={onHover}
    >
      <button
        type="button"
        className="bk-glyphs__hit"
        aria-label={glyph.name}
        title={title}
        tabIndex={-1}
        onClick={onCopy}
      >
        {glyph.label ? (
          <span className="bk-glyphs__stand-in">{glyph.label}</span>
        ) : (
          <span className="bk-glyphs__char">{glyph.c}</span>
        )}
      </button>
      <button
        type="button"
        className={`bk-glyphs__pin ${pinned ? "is-active" : ""}`}
        aria-label={pinned ? `Unpin ${glyph.name}` : `Pin ${glyph.name}`}
        title={pinned ? "Unpin" : "Pin"}
        tabIndex={-1}
        onClick={onPin}
      >
        {pinned ? "★" : "☆"}
      </button>
    </div>
  );
}
