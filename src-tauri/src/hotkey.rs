//! Global shortcut register / re-register (spec §9).

use std::str::FromStr;

use tauri::{AppHandle, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// Register (replacing any previous binding) the launcher toggle hotkey.
pub fn register<R: Runtime>(app: &AppHandle<R>, accelerator: &str) -> Result<(), String> {
    let shortcut = Shortcut::from_str(accelerator)
        .map_err(|e| format!("invalid hotkey \"{accelerator}\": {e}"))?;

    let shortcuts = app.global_shortcut();
    let _ = shortcuts.unregister_all();
    shortcuts
        .on_shortcut(shortcut, |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                crate::window::toggle_launcher(app);
            }
        })
        .map_err(|e| e.to_string())
}
