//! Global shortcut register / re-register (spec §9).
//!
//! One registration pass owns every binding: the launcher toggle plus each
//! per-module launch hotkey. Any change (rebind, module toggle) re-runs the
//! whole pass so the plugin's registry never drifts from config.

use std::str::FromStr;

use tauri::{AppHandle, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::commands::config::{self, Config};

/// Re-register every hotkey from `cfg`: the launcher toggle plus one launch
/// chord per enabled module. Fails atomically-ish: on any invalid or
/// conflicting chord the whole pass errors (callers roll back to the stored
/// config), so a bad binding never silently drops its siblings.
pub fn register_all<R: Runtime>(app: &AppHandle<R>, cfg: &Config) -> Result<(), String> {
    let shortcuts = app.global_shortcut();
    let _ = shortcuts.unregister_all();

    let launcher = parse(&cfg.hotkey)?;
    shortcuts
        .on_shortcut(launcher, |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                crate::window::toggle_launcher(app);
            }
        })
        .map_err(|e| format!("hotkey \"{}\": {e}", cfg.hotkey))?;

    for (id, chord) in config::module_hotkeys(cfg) {
        // A toggled-off module keeps its saved chord but frees the binding.
        if cfg.disabled_modules.iter().any(|m| m == &id) {
            continue;
        }
        let shortcut = parse(&chord)?;
        let module_id = id.clone();
        shortcuts
            .on_shortcut(shortcut, move |app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    crate::window::open_tool(app, &module_id);
                }
            })
            .map_err(|e| format!("hotkey \"{chord}\" ({id}): {e}"))?;
    }
    Ok(())
}

fn parse(accelerator: &str) -> Result<Shortcut, String> {
    Shortcut::from_str(accelerator).map_err(|e| format!("invalid hotkey \"{accelerator}\": {e}"))
}
