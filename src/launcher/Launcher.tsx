import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { search } from "../tools/registry";
import type { ToolContext, ToolModule } from "../tools/types";
import { invoke } from "../core/ipc";
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

  const results = useMemo(() => search(query), [query]);

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
    const unlisten = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused) {
        setSettingsOpen(false);
        void closeLauncher();
      }
    });
    return () => {
      unlisten.then((off) => off()).catch(() => {});
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

  function onSearchKey(e: KeyboardEvent<HTMLInputElement>) {
    if (results.length === 0) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelected((s) => clamp(s + GRID_COLS, 0, results.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelected((s) => clamp(s - GRID_COLS, 0, results.length - 1));
        break;
      case "ArrowRight":
        e.preventDefault();
        setSelected((s) => clamp(s + 1, 0, results.length - 1));
        break;
      case "ArrowLeft":
        e.preventDefault();
        setSelected((s) => clamp(s - 1, 0, results.length - 1));
        break;
      case "Enter":
        e.preventDefault();
        dispatchTool(results[selected] ?? results[0]);
        break;
    }
  }

  return (
    <div className="bk-launcher" data-window="launcher">
      <span className="bk-frame bk-frame--tl" aria-hidden="true" />
      <span className="bk-frame bk-frame--tr" aria-hidden="true" />
      <span className="bk-frame bk-frame--bl" aria-hidden="true" />
      <span className="bk-frame bk-frame--br" aria-hidden="true" />

      {settingsOpen ? (
        <Settings onClose={() => setSettingsOpen(false)} />
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
              }}
              onKeyDown={onSearchKey}
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
          <ToolGrid
            tools={results}
            selectedIndex={selected}
            onSelect={dispatchTool}
            onHover={setSelected}
          />
          <footer className="bk-launcher__hint">
            <span>↵ launch</span>
            <span>↑↓←→ move</span>
            <span>esc close</span>
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
