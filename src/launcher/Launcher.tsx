import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { filterDisabled, search } from "../tools/registry";
import type { ToolContext, ToolModule } from "../tools/types";
import { errorMessage, invoke } from "../core/ipc";
import { toast } from "../core/toast";
import { makeToolSettings } from "../core/settings";
import { EV_OPEN_SETTINGS, EV_RESET } from "../core/events";
import { SearchBar } from "./SearchBar";
import { ToolGrid } from "./ToolGrid";
import { ToolHost } from "./ToolHost";
import { Settings } from "../components/Settings";

const GRID_COLS = 4;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export function Launcher() {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [activeTool, setActiveTool] = useState<ToolModule | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [disabled, setDisabled] = useState<string[]>([]);
  // Show the selection ring only while the mouse is over a tile or the user is
  // keyboard-navigating — never linger on a tile the mouse merely passed over.
  const [highlightOn, setHighlightOn] = useState(true);
  // Grabbing the header to drag makes the webview lose focus for a beat as the
  // native move loop starts; ignore any blur until this moment passes so the
  // click-away dismiss doesn't fire mid-drag.
  const suppressBlurUntil = useRef(0);

  const results = useMemo(() => filterDisabled(search(query), disabled), [query, disabled]);

  // Toggled-off modules stay out of the grid; the list comes from config.
  useEffect(() => {
    invoke("get_config")
      .then((cfg) => setDisabled(cfg.disabledModules ?? []))
      .catch(() => {
        /* outside a Tauri webview (browser preview) — all modules shown */
      });
  }, []);

  const toggleModule = useCallback(async (id: string, enabled: boolean) => {
    try {
      const cfg = await invoke("set_module_enabled", { id, enabled });
      setDisabled(cfg.disabledModules ?? []);
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
    [makeCtx],
  );

  // Esc: unwind settings → panel → close. Works even when the search box is gone.
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (settingsOpen) setSettingsOpen(false);
      else if (activeTool) setActiveTool(null);
      else void closeLauncher();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsOpen, activeTool, closeLauncher]);

  // Dismiss on blur / click-away (spec §3.1).
  useEffect(() => {
    let unlisten: Promise<() => void> | null = null;
    try {
      unlisten = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
        if (focused) return;
        // A blur inside the grab window is the native drag starting, not a
        // click-away — ignore it so the window survives being dragged.
        if (Date.now() < suppressBlurUntil.current) return;
        setSettingsOpen(false);
        void closeLauncher();
      });
    } catch {
      /* outside a Tauri webview (browser preview) — no focus tracking */
    }
    return () => {
      unlisten?.then((off) => off()).catch(() => {});
    };
  }, [closeLauncher]);

  // Tray/hotkey signals: fresh open resets to the grid; tray "Settings" opens it.
  useEffect(() => {
    const disposers: Array<() => void> = [];
    listen(EV_RESET, () => {
      setQuery("");
      setSelected(0);
      setActiveTool(null);
      setSettingsOpen(false);
      setHighlightOn(true);
    })
      .then((un) => disposers.push(un))
      .catch(() => {});
    listen(EV_OPEN_SETTINGS, () => {
      setActiveTool(null);
      setSettingsOpen(true);
    })
      .then((un) => disposers.push(un))
      .catch(() => {});
    return () => disposers.forEach((d) => d());
  }, []);

  // Grid navigation at window level so ↵ / arrows work even when the search
  // box has lost focus (footer hints must never lie).
  useEffect(() => {
    if (settingsOpen || activeTool) return;
    function onKey(e: globalThis.KeyboardEvent) {
      if (results.length === 0) return;
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setHighlightOn(true);
          setSelected((s) => clamp(s + GRID_COLS, 0, results.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setHighlightOn(true);
          setSelected((s) => clamp(s - GRID_COLS, 0, results.length - 1));
          break;
        case "ArrowRight":
          e.preventDefault();
          setHighlightOn(true);
          setSelected((s) => clamp(s + 1, 0, results.length - 1));
          break;
        case "ArrowLeft":
          e.preventDefault();
          setHighlightOn(true);
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
  }, [settingsOpen, activeTool, results, selected, dispatchTool]);

  return (
    <div className="bk-launcher" data-window="launcher">
      <span className="bk-frame bk-frame--tl" aria-hidden="true" />
      <span className="bk-frame bk-frame--tr" aria-hidden="true" />
      <span className="bk-frame bk-frame--bl" aria-hidden="true" />
      <span className="bk-frame bk-frame--br" aria-hidden="true" />

      {/* Grab the header to move the window. We drive the drag ourselves (rather
          than data-tauri-drag-region) so we can suppress the click-away dismiss
          for the focus blip the OS move loop causes. */}
      <header
        className="bk-sysbar"
        aria-hidden="true"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          suppressBlurUntil.current = Date.now() + 1000;
          try {
            void getCurrentWindow().startDragging().catch(() => {});
          } catch {
            /* outside a Tauri webview (browser preview) — nothing to drag */
          }
        }}
      >
        <span className="bk-sysbar__id">BRUCEKIT</span>
      </header>

      {settingsOpen ? (
        <Settings
          onClose={() => setSettingsOpen(false)}
          disabled={disabled}
          onToggleModule={toggleModule}
        />
      ) : activeTool && activeCtx ? (
        <ToolHost tool={activeTool} ctx={activeCtx} onBack={() => setActiveTool(null)} />
      ) : (
        <>
          <div className="bk-launcher__top">
            <SearchBar
              value={query}
              onChange={(v) => {
                setQuery(v);
                setSelected(0);
                setHighlightOn(true);
              }}
              resultCount={results.length}
            />
            <button
              type="button"
              className="bk-gear"
              onClick={() => setSettingsOpen(true)}
              aria-label="Open settings"
              title="Settings"
            >
              <GearIcon />
            </button>
          </div>
          <div className="bk-divider" aria-hidden="true">
            <span>{"// MODULES"}</span>
          </div>
          <ToolGrid
            tools={results}
            selectedIndex={highlightOn ? selected : -1}
            onSelect={dispatchTool}
            onHover={(i) => {
              setSelected(i);
              setHighlightOn(true);
            }}
            onLeave={() => setHighlightOn(false)}
          />
          <footer className="bk-launcher__hint">
            <span>[↵] launch</span>
            <span>[↑↓←→] move</span>
            <span>[esc] close</span>
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
