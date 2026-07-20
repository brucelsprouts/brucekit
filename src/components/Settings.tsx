import { useEffect, useState } from "react";
import { invoke, errorMessage, type Config } from "../core/ipc";
import { toast } from "../core/toast";
import { getTools } from "../tools/registry";

type Props = {
  onClose: () => void;
  /** Module ids currently toggled off. */
  disabled: string[];
  /** Persist a module toggle (also starts/stops its background service). */
  onToggleModule: (id: string, enabled: boolean) => void | Promise<void>;
};

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "OS"]);

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

export function Settings({ onClose, disabled, onToggleModule }: Props) {
  const [config, setConfig] = useState<Config | null>(null);
  const [recording, setRecording] = useState(false);
  const tools = getTools();

  useEffect(() => {
    invoke("get_config")
      .then(setConfig)
      .catch((err) => toast(errorMessage(err), { kind: "error" }));
  }, []);

  // Capture the next chord while recording.
  useEffect(() => {
    if (!recording) return;
    function onKey(e: globalThis.KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();
      const chord = chordFromEvent(e);
      if (!chord) return; // wait for a non-modifier key
      setRecording(false);
      applyHotkey(chord);
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

  async function toggleStartup(enabled: boolean) {
    try {
      await invoke("set_autostart", { enabled });
      setConfig((c) => (c ? { ...c, launchOnStartup: enabled } : c));
    } catch (err) {
      toast(errorMessage(err), { kind: "error" });
    }
  }

  return (
    <section className="bk-settings">
      <header className="bk-settings__bar">
        <button type="button" className="bk-back" onClick={onClose} aria-label="Close settings">
          ← BACK
        </button>
        <span className="bk-host__title">{"// Settings"}</span>
      </header>

      <div className="bk-settings__body">
        <div className="bk-field">
          <span className="bk-label">GLOBAL HOTKEY</span>
          <div className="bk-field__row">
            <code className="bk-chord">{config?.hotkey ?? "…"}</code>
            <button
              type="button"
              className={`bk-btn ${recording ? "bk-btn--accent" : ""}`}
              onClick={() => setRecording((r) => !r)}
            >
              {recording ? "Press keys…" : "Rebind"}
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
          <span className="bk-label">MODULES · {tools.length}</span>
          <ul className="bk-toollist">
            {tools.map((t) => {
              const enabled = !disabled.includes(t.id);
              return (
                <li
                  key={t.id}
                  className={`bk-toollist__item ${enabled ? "" : "bk-toollist__item--off"}`}
                >
                  <span className="bk-toollist__icon">
                    <t.icon size={18} />
                  </span>
                  <span className="bk-toollist__text">
                    <strong>{t.name}</strong>
                    <em>{t.description}</em>
                  </span>
                  <span className="bk-toollist__kind">{t.kind.toUpperCase()}</span>
                  <label className="bk-toggle" title={enabled ? "Disable module" : "Enable module"}>
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
          <em className="bk-settings__note">
            Off = hidden from the grid and any background work (clipboard watch, pinger) stops —
            toggle modules off to cut resource usage.
          </em>
        </div>
      </div>
    </section>
  );
}
