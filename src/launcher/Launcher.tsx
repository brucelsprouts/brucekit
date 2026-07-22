import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { filterDisabled, getTools, search, sortPinned } from "../tools/registry";
import type { ToolContext, ToolModule } from "../tools/types";
import { errorMessage, invoke } from "../core/ipc";
import { toast } from "../core/toast";
import { isEditableTarget, isUndoHotkey, undoSlot } from "../core/undo";
import { makeToolSettings } from "../core/settings";
import { EV_OPEN_SETTINGS, EV_OPEN_TOOL, EV_RESET } from "../core/events";
import { SearchBar } from "./SearchBar";
import { ToolGrid } from "./ToolGrid";
import { ToolHost } from "./ToolHost";
import { NavBar } from "./NavBar";
import { Settings } from "../components/Settings";

const GRID_COLS = 4;

/** Logical width the module grid sizes itself to: `GRID_COLS` tiles + gutters. */
const GRID_WIDTH = 540;
/** Panel size before the user has ever dragged one. */
const DEFAULT_PANEL_SIZE = { width: 720, height: 520 };

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export function Launcher() {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [activeTool, setActiveTool] = useState<ToolModule | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [disabled, setDisabled] = useState<string[]>([]);
  const [pinned, setPinned] = useState<string[]>([]);
  // Bumped by the refresh control; used as a React key so the current view is
  // torn down and rebuilt rather than merely re-rendered — a panel that has
  // gone stale (dead listener, bad fetch) comes back clean.
  const [viewNonce, setViewNonce] = useState(0);
  // What is driving the highlight. Only "keys" paints the ring from React —
  // pointer highlighting is left to `.bk-tile:hover`, which cannot outlive the
  // cursor. A JS-painted hover ring could: mouseleave never fires when the tile
  // unmounts underneath the pointer (launching a tool, a search that filters
  // the tile away) or when the window hides, and the tile stayed lit.
  const [highlight, setHighlight] = useState<"none" | "mouse" | "keys">("none");
  // Mouse-forward target: the view (panel/settings) most recently backed out
  // of. Cleared whenever a view is opened by normal means, like browser
  // history's forward stack. Mirrored into state so the forward button can
  // render enabled/disabled — the ref stays the source of truth for handlers.
  const forwardView = useRef<{ kind: "settings" } | { kind: "tool"; tool: ToolModule } | null>(
    null,
  );
  const [canGoForward, setCanGoForward] = useState(false);
  // Click-away dismissal lives on the Rust side (window::on_launcher_blur):
  // it can see the global cursor at blur time, so resize grabs and header
  // drags are forgiven while real click-aways still hide the window.

  const setForward = useCallback((view: typeof forwardView.current) => {
    forwardView.current = view;
    setCanGoForward(view !== null);
  }, []);

  const results = useMemo(
    () => sortPinned(filterDisabled(search(query), disabled), pinned),
    [query, disabled, pinned],
  );

  // The grid splits into a pinned section and the rest, but only at rest:
  // while searching, relevance owns the order and a split would just fragment
  // the ranking. Both sections index into `results`, so keyboard nav is one
  // continuous run across them.
  const pinnedCount = query.trim() ? 0 : results.filter((t) => pinned.includes(t.id)).length;

  // Toggled-off modules stay out of the grid; pins order what's left.
  useEffect(() => {
    invoke("get_config")
      .then((cfg) => {
        setDisabled(cfg.disabledModules ?? []);
        setPinned(cfg.pinnedModules ?? []);
        if (cfg.launcherSize) panelSize.current = cfg.launcherSize;
      })
      .catch(() => {
        /* outside a Tauri webview (browser preview) — all modules shown */
      });
  }, []);

  const toggleModule = useCallback(async (id: string, enabled: boolean) => {
    try {
      const cfg = await invoke("set_module_enabled", { id, enabled });
      setDisabled(cfg.disabledModules ?? []);
      setPinned(cfg.pinnedModules ?? []);
    } catch (err) {
      toast(errorMessage(err), { kind: "error" });
    }
  }, []);

  const togglePin = useCallback(async (id: string, next: boolean) => {
    try {
      const cfg = await invoke("set_module_pinned", { id, pinned: next });
      setPinned(cfg.pinnedModules ?? []);
    } catch (err) {
      toast(errorMessage(err), { kind: "error" });
    }
  }, []);

  useEffect(() => {
    setSelected((s) => clamp(s, 0, Math.max(0, results.length - 1)));
  }, [results.length]);

  const closeLauncher = useCallback(async () => {
    try {
      await getCurrentWindow().hide();
    } catch {
      /* window may already be hidden */
    }
  }, []);

  const makeCtx = useCallback(
    (tool: ToolModule): ToolContext => ({
      invoke,
      toast,
      closeLauncher: () => void closeLauncher(),
      settings: makeToolSettings(tool.id),
    }),
    [closeLauncher],
  );

  const activeCtx = useMemo(
    () => (activeTool ? makeCtx(activeTool) : null),
    [activeTool, makeCtx],
  );

  // Dispatch is guarded so a throwing tool produces a toast, nothing more (§7).
  const dispatchTool = useCallback(
    (tool: ToolModule) => {
      if (tool.kind === "panel") {
        setForward(null);
        setActiveTool(tool);
        return;
      }
      try {
        const result = tool.activate?.(makeCtx(tool));
        if (result instanceof Promise) {
          result.catch((err) => {
            console.error(`[brucekit] "${tool.id}" activate() rejected`, err);
            toast(`${tool.name} failed`, { kind: "error" });
          });
        }
      } catch (err) {
        console.error(`[brucekit] "${tool.id}" activate() threw`, err);
        toast(`${tool.name} failed`, { kind: "error" });
      }
    },
    [makeCtx, setForward],
  );

  const atRoot = !settingsOpen && !activeTool;
  // The scrolling module-grid column, measured to size the window to it.
  const sectionsRef = useRef<HTMLDivElement | null>(null);
  // Same flag, readable from the resize listener — that subscription is set up
  // once, so it would otherwise close over `atRoot` as it stood on mount.
  const atRootRef = useRef(atRoot);
  atRootRef.current = atRoot;
  // Panel size, mirrored out of config so opening a panel can size the window
  // synchronously. Kept fresh by the resize listener below.
  const panelSize = useRef(DEFAULT_PANEL_SIZE);

  // One implementation behind all three back affordances: Esc, mouse button 3,
  // and the ◀ control. Unwinds one level and records what it left for forward.
  const goBack = useCallback(() => {
    if (settingsOpen) {
      setForward({ kind: "settings" });
      setSettingsOpen(false);
    } else if (activeTool) {
      setForward({ kind: "tool", tool: activeTool });
      setActiveTool(null);
    }
  }, [settingsOpen, activeTool, setForward]);

  const goForward = useCallback(() => {
    // Forward only applies from the grid, and only after a back.
    if (!atRoot) return;
    const view = forwardView.current;
    if (!view) return;
    setForward(null);
    if (view.kind === "settings") setSettingsOpen(true);
    else setActiveTool(view.tool);
  }, [atRoot, setForward]);

  const refresh = useCallback(() => {
    setViewNonce((n) => n + 1);
    if (atRoot) {
      setQuery("");
      setSelected(0);
      setHighlight("none");
      invoke("get_config")
        .then((cfg) => {
          setDisabled(cfg.disabledModules ?? []);
          setPinned(cfg.pinnedModules ?? []);
        })
        .catch(() => {});
    }
  }, [atRoot]);

  // Esc: unwind settings → panel → close. Works even when the search box is gone.
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (atRoot) void closeLauncher();
      else goBack();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [atRoot, goBack, closeLauncher]);

  // Ctrl+Z runs whatever destructive action a panel last registered. Not scoped
  // to the grid — the undo that matters is the one for the panel you're in.
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (!isUndoHotkey(e) || isEditableTarget(e.target)) return;
      const entry = undoSlot.take();
      if (!entry) return;
      e.preventDefault();
      Promise.resolve(entry.run())
        .then(() => toast(`Restored ${entry.label}`, { kind: "success" }))
        .catch((err) => toast(errorMessage(err), { kind: "error" }));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Mouse back/forward (buttons 3/4) walk the same view stack as the buttons.
  useEffect(() => {
    function onMouseUp(e: globalThis.MouseEvent) {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      if (e.button === 3) goBack();
      else goForward();
    }
    // Swallow the down half too so the webview never treats it as history nav.
    function onMouseDown(e: globalThis.MouseEvent) {
      if (e.button === 3 || e.button === 4) e.preventDefault();
    }
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [goBack, goForward]);

  // Tray/hotkey signals: fresh open resets to the grid; tray "Settings" opens it.
  useEffect(() => {
    const disposers: Array<() => void> = [];
    listen(EV_RESET, () => {
      setQuery("");
      setSelected(0);
      setActiveTool(null);
      setSettingsOpen(false);
      setHighlight("none");
      setForward(null);
    })
      .then((un) => disposers.push(un))
      .catch(() => {});
    listen(EV_OPEN_SETTINGS, () => {
      setForward(null);
      setActiveTool(null);
      setSettingsOpen(true);
    })
      .then((un) => disposers.push(un))
      .catch(() => {});
    return () => disposers.forEach((d) => d());
  }, [setForward]);

  // Per-module hotkey (and tray pin entries): Rust shows the window and names
  // the tool to open.
  useEffect(() => {
    let dispose = () => {};
    listen<string>(EV_OPEN_TOOL, (event) => {
      const tool = getTools().find((t) => t.id === event.payload);
      if (!tool) return;
      setQuery("");
      setSelected(0);
      setSettingsOpen(false);
      setHighlight("none");
      setForward(null);
      setActiveTool(null);
      dispatchTool(tool);
    })
      .then((un) => {
        dispose = un;
      })
      .catch(() => {});
    return () => dispose();
  }, [dispatchTool, setForward]);

  // A `keepOpen` panel pins the launcher against click-away for as long as
  // it's the active view. Syncing on every change of `activeTool` — including
  // back to null — is what guarantees the pin is released when you leave.
  useEffect(() => {
    invoke("set_keep_open", { enabled: activeTool?.keepOpen === true }).catch(() => {
      /* outside a Tauri webview (browser preview) — nothing to pin */
    });
  }, [activeTool]);

  // The grid fits the window to itself instead of sitting in whatever window it
  // inherits. Its natural height moves with the pin count — a pinned section
  // costs a divider plus a row — so no fixed height is right for every user,
  // and the surplus shows up as a dead band between the last tile row and the
  // hint footer.
  //
  // Height comes from summing the section's children, not from measuring the
  // section itself: that box is the flex child that absorbs slack, so its size
  // is a function of the window height we are trying to compute. The chrome
  // around it (`box.top` above, the footer strip below) is height-independent
  // precisely because the footer stays flush to the bottom.
  // Deliberately a *layout* effect, and deliberately not deferred to a frame:
  // the launcher spends most of its life hidden, and a hidden window's
  // animation frames don't run. Measuring here reads the layout React has
  // already committed, so the window is the right size before the hotkey ever
  // shows it — rather than snapping to size a frame after it appears.
  useLayoutEffect(() => {
    if (!atRoot) return;
    const sections = sectionsRef.current;
    if (!sections) return;
    const kids = Array.from(sections.children);
    if (kids.length === 0) return;
    const box = sections.getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(sections).rowGap) || 0;
    const content =
      kids.reduce((h, el) => h + el.getBoundingClientRect().height, 0) +
      gap * (kids.length - 1);
    // A zero measurement means the webview has no usable layout yet. Sending it
    // would clamp the window to its minimum and make that the size the user
    // sees on open, so sit this round out — a later render will measure again.
    if (content <= 0) return;
    const height = Math.ceil(box.top + content + (window.innerHeight - box.bottom));
    invoke("resize_launcher", { width: GRID_WIDTH, height }).catch(() => {
      /* outside a Tauri webview (browser preview) — nothing to resize */
    });
  }, [atRoot, results.length, pinnedCount]);

  // Opening a panel hands back the size the user last dragged a panel to.
  // dcheck's graph is meant to be watched while you work in another window, so
  // panels keep their own dimensions rather than inheriting the grid's.
  //
  // Read from the cached ref, not from a fresh `get_config`: that round-trip
  // outlasts the render, so the panel would paint at the grid's compact size
  // and then jump.
  useLayoutEffect(() => {
    if (atRoot) return;
    invoke("resize_launcher", panelSize.current).catch(() => {
      /* outside a Tauri webview (browser preview) — nothing to resize */
    });
  }, [atRoot]);

  // Persist the size the user drags the window to (debounced — the OS streams
  // resize events during the drag). Stored logical so DPI changes don't warp it.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unlisten: Promise<() => void> | null = null;
    try {
      const win = getCurrentWindow();
      unlisten = win.onResized(({ payload }) => {
        // Only panels have a size worth remembering. The grid computes its own,
        // and recording that would overwrite the panel size with a number the
        // user never chose.
        if (atRootRef.current) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          win
            .scaleFactor()
            .then((sf) => {
              const logical = payload.toLogical(sf);
              const size = { width: logical.width, height: logical.height };
              // Mirror it back so the next panel opens at this size without
              // waiting to re-read config.
              panelSize.current = size;
              return invoke("set_launcher_size", size);
            })
            .catch(() => {});
        }, 400);
      });
    } catch {
      /* outside a Tauri webview (browser preview) — nothing to persist */
    }
    return () => {
      if (timer) clearTimeout(timer);
      unlisten?.then((off) => off()).catch(() => {});
    };
  }, []);

  // Grid navigation at window level so ↵ / arrows work even when the search
  // box has lost focus (footer hints must never lie).
  useEffect(() => {
    if (!atRoot) return;
    function onKey(e: globalThis.KeyboardEvent) {
      if (results.length === 0) return;
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setHighlight("keys");
          setSelected((s) => clamp(s + GRID_COLS, 0, results.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setHighlight("keys");
          setSelected((s) => clamp(s - GRID_COLS, 0, results.length - 1));
          break;
        case "ArrowRight":
          e.preventDefault();
          setHighlight("keys");
          setSelected((s) => clamp(s + 1, 0, results.length - 1));
          break;
        case "ArrowLeft":
          e.preventDefault();
          setHighlight("keys");
          setSelected((s) => clamp(s - 1, 0, results.length - 1));
          break;
        case "Enter":
          e.preventDefault();
          dispatchTool(results[selected] ?? results[0]);
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [atRoot, results, selected, dispatchTool]);

  const gridProps = {
    selectedIndex: highlight === "keys" ? selected : -1,
    pinned,
    onSelect: dispatchTool,
    onTogglePin: (tool: ToolModule) => void togglePin(tool.id, !pinned.includes(tool.id)),
    // Hover still moves the selection so ↵ launches the tile under the cursor;
    // only the painting of it belongs to CSS.
    onHover: (i: number) => {
      setSelected(i);
      setHighlight("mouse");
    },
    onLeave: () => setHighlight("none"),
  };

  return (
    <div className="bk-launcher" data-window="launcher">
      <span className="bk-frame bk-frame--tl" aria-hidden="true" />
      <span className="bk-frame bk-frame--tr" aria-hidden="true" />
      <span className="bk-frame bk-frame--bl" aria-hidden="true" />
      <span className="bk-frame bk-frame--br" aria-hidden="true" />

      {/* Grab the header to move the window (blur forgiveness is Rust-side). */}
      <header
        className="bk-sysbar"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          try {
            void getCurrentWindow().startDragging().catch(() => {});
          } catch {
            /* outside a Tauri webview (browser preview) — nothing to drag */
          }
        }}
      >
        <span className="bk-sysbar__id">BRUCEKIT</span>
        <span className="bk-sysbar__crumb" aria-hidden="true">
          {settingsOpen ? "/ settings" : activeTool ? `/ ${activeTool.name}` : ""}
        </span>
        <NavBar
          canGoBack={!atRoot}
          canGoForward={canGoForward}
          onBack={goBack}
          onForward={goForward}
          onRefresh={refresh}
          onClose={() => void closeLauncher()}
        />
      </header>

      {settingsOpen ? (
        <Settings
          key={`settings-${viewNonce}`}
          disabled={disabled}
          pinned={pinned}
          onToggleModule={toggleModule}
          onTogglePin={togglePin}
        />
      ) : activeTool && activeCtx ? (
        <ToolHost key={`${activeTool.id}-${viewNonce}`} tool={activeTool} ctx={activeCtx} />
      ) : (
        <>
          <div className="bk-launcher__top">
            <SearchBar
              value={query}
              onChange={(v) => {
                setQuery(v);
                setSelected(0);
                // Typing aims the ↵ target at the top hit but does not ring it:
                // the cursor is in the search box, not on a tile.
                setHighlight("none");
              }}
              resultCount={results.length}
            />
            <button
              type="button"
              className="bk-gear"
              onClick={() => {
                setForward(null);
                setSettingsOpen(true);
              }}
              aria-label="Open settings"
              title="Settings"
            >
              <GearIcon />
            </button>
          </div>

          <div className="bk-launcher__sections" ref={sectionsRef}>
            {pinnedCount > 0 && (
              <>
                <div className="bk-divider" aria-hidden="true">
                  <span>{"// PINNED"}</span>
                </div>
                <ToolGrid {...gridProps} tools={results.slice(0, pinnedCount)} />
              </>
            )}
            <div className="bk-divider" aria-hidden="true">
              <span>{pinnedCount > 0 ? "// ALL MODULES" : "// MODULES"}</span>
            </div>
            <ToolGrid
              {...gridProps}
              tools={results.slice(pinnedCount)}
              indexOffset={pinnedCount}
            />
          </div>

          <footer className="bk-launcher__hint">
            <span>[↵] launch</span>
            <span>[↑↓←→] move</span>
            <span>[☆] pin</span>
          </footer>
        </>
      )}
    </div>
  );
}

function GearIcon() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
