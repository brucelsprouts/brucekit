import { useEffect, useState } from "react";
import { invoke, errorMessage, type Config } from "../core/ipc";
import { toast } from "../core/toast";
import { getTools } from "../tools/registry";

type Props = {
  /** Module ids currently toggled off. */
  disabled: string[];
  /** Module ids currently pinned, in pin order. */
  pinned: string[];
  /** Persist a module toggle (also starts/stops its background service). */
  onToggleModule: (id: string, enabled: boolean) => void | Promise<void>;
  /** Persist a pin (also rebuilds the tray menu). */
  onTogglePin: (id: string, pinned: boolean) => void | Promise<void>;
};

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "OS"]);

/** What the next recorded chord is for: the launcher itself, or one module. */
type RecordTarget = { kind: "global" } | { kind: "module"; id: string };

/** Turn a keyboard event into a Tauri accelerator string, or null if modifier-only. */
export function chordFromEvent(e: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): string | null {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("CommandOrControl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");

  const key = normalizeKey(e.key);
  if (!key) return null;
  parts.push(key);
  return parts.join("+");
}

function normalizeKey(key: string): string | null {
  if (MODIFIER_KEYS.has(key)) return null;
  if (key === " ") return "Space";
  if (key.startsWith("Arrow")) return key.slice(5); // Up / Down / Left / Right
  if (key.length === 1) return key.toUpperCase();
  return key; // F1, Enter, Escape, `, etc.
}

export function Settings({ disabled, pinned, onToggleModule, onTogglePin }: Props) {
  const [config, setConfig] = useState<Config | null>(null);
  const [recording, setRecording] = useState<RecordTarget | null>(null);
  const tools = getTools();

  useEffect(() => {
    invoke("get_config")
      .then(setConfig)
      .catch((err) => toast(errorMessage(err), { kind: "error" }));
  }, []);

  // Capture the next chord while recording (global or per-module).
  useEffect(() => {
    if (!recording) return;
    const target = recording;
    function onKey(e: globalThis.KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();
      const chord = chordFromEvent(e);
      if (!chord) return; // wait for a non-modifier key
      setRecording(null);
      if (target.kind === "global") applyHotkey(chord);
      else applyModuleHotkey(target.id, chord);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);

  async function applyHotkey(chord: string) {
    try {
      await invoke("set_hotkey", { chord });
      setConfig((c) => (c ? { ...c, hotkey: chord } : c));
      toast(`Hotkey set to ${chord}`, { kind: "success" });
    } catch (err) {
      toast(errorMessage(err), { kind: "error" });
    }
  }

  async function applyModuleHotkey(id: string, chord: string | null) {
    try {
      const cfg = await invoke("set_module_hotkey", { id, chord });
      setConfig(cfg);
      toast(chord ? `${id} bound to ${chord}` : `${id} hotkey cleared`, { kind: "success" });
    } catch (err) {
      toast(errorMessage(err), { kind: "error" });
    }
  }

  async function toggleStartup(enabled: boolean) {
    try {
      await invoke("set_autostart", { enabled });
      setConfig((c) => (c ? { ...c, launchOnStartup: enabled } : c));
    } catch (err) {
      toast(errorMessage(err), { kind: "error" });
    }
  }

  async function toggleEco(enabled: boolean) {
    try {
      const cfg = await invoke("set_eco_mode", { enabled });
      setConfig(cfg);
      toast(enabled ? "Eco mode on — all background work paused" : "Eco mode off", {
        kind: "success",
      });
    } catch (err) {
      toast(errorMessage(err), { kind: "error" });
    }
  }

  const eco = config?.ecoMode ?? false;

  return (
    <section className="bk-settings">
      <header className="bk-host__bar">
        <span className="bk-host__title">Settings</span>
        <span className="bk-host__desc">Hotkeys, background work, and modules</span>
      </header>

      <div className="bk-settings__body">
        <div className="bk-field">
          <span className="bk-label">GLOBAL HOTKEY</span>
          <div className="bk-field__row">
            <code className="bk-chord">{config?.hotkey ?? "…"}</code>
            <button
              type="button"
              className={`bk-btn ${recording?.kind === "global" ? "bk-btn--accent" : ""}`}
              onClick={() =>
                setRecording((r) => (r?.kind === "global" ? null : { kind: "global" }))
              }
            >
              {recording?.kind === "global" ? "Press keys…" : "Rebind"}
            </button>
          </div>
        </div>

        <div className="bk-field">
          <span className="bk-label">STARTUP</span>
          <label className="bk-toggle">
            <input
              type="checkbox"
              checked={config?.launchOnStartup ?? false}
              onChange={(e) => toggleStartup(e.target.checked)}
              disabled={!config}
            />
            <span>Launch brucekit on login</span>
          </label>
        </div>

        <div className="bk-field">
          <span className="bk-label">ECO MODE</span>
          <label className="bk-toggle" title="Master switch over every background service">
            <input
              type="checkbox"
              checked={eco}
              onChange={(e) => toggleEco(e.target.checked)}
              disabled={!config}
              aria-label="Eco mode"
            />
            <span>Pause all background work</span>
          </label>
        </div>

        <div className="bk-field">
          <span className="bk-label">
            MODULES · {tools.length} · {pinned.length} PINNED
          </span>
          <ul className="bk-toollist">
            {tools.map((t) => {
              const enabled = !disabled.includes(t.id);
              const isPinned = pinned.includes(t.id);
              const chord = config?.moduleHotkeys?.[t.id];
              const recordingThis = recording?.kind === "module" && recording.id === t.id;
              return (
                <li
                  key={t.id}
                  className={`bk-toollist__item ${enabled ? "" : "bk-toollist__item--off"}`}
                >
                  <button
                    type="button"
                    className={`bk-pinbtn ${isPinned ? "is-active" : ""}`}
                    onClick={() => void onTogglePin(t.id, !isPinned)}
                    aria-pressed={isPinned}
                    aria-label={`${isPinned ? "Unpin" : "Pin"} ${t.name}`}
                    title={
                      isPinned
                        ? "Unpin — removes it from the top of the grid and the tray menu"
                        : "Pin — sorts it to the top of the grid and adds a tray entry"
                    }
                  >
                    {isPinned ? "★" : "☆"}
                  </button>
                  <span className="bk-toollist__icon">
                    <t.icon size={18} />
                  </span>
                  <span className="bk-toollist__text">
                    <strong>{t.name}</strong>
                    <em>{t.description}</em>
                  </span>
                  <span className="bk-toollist__hotkey">
                    {chord && !recordingThis && <code className="bk-chord">{chord}</code>}
                    <button
                      type="button"
                      className={`bk-btn bk-btn--sm ${recordingThis ? "bk-btn--accent" : ""}`}
                      onClick={() =>
                        setRecording(recordingThis ? null : { kind: "module", id: t.id })
                      }
                      title={`Bind a global hotkey that opens ${t.name} directly`}
                    >
                      {recordingThis ? "Press keys…" : chord ? "Rebind" : "Bind key"}
                    </button>
                    {chord && !recordingThis && (
                      <button
                        type="button"
                        className="bk-btn bk-btn--sm"
                        onClick={() => void applyModuleHotkey(t.id, null)}
                        aria-label={`Clear ${t.name} hotkey`}
                        title="Clear hotkey"
                      >
                        ✕
                      </button>
                    )}
                  </span>
                  <span className="bk-toollist__kind">{t.kind.toUpperCase()}</span>
                  <label
                    className="bk-toggle"
                    title={
                      enabled
                        ? "Disable — hides the tile, frees its hotkey, and stops any background work it does"
                        : "Enable — restores the tile, its hotkey, and any background work it does"
                    }
                  >
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={(e) => void onToggleModule(t.id, e.target.checked)}
                      aria-label={`${t.name} enabled`}
                    />
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </section>
  );
}
