pub mod capture;
pub mod clips;
pub mod color;
pub mod config;
pub mod dcheck;
pub mod ocr;
pub mod runtime;

use tauri::{AppHandle, Runtime};

/// Module ids that own a background service (the rest are UI-only, so
/// toggling them merely hides the tile).
const SERVICE_MODULES: [&str; 3] = [clips::MODULE_ID, dcheck::MODULE_ID, runtime::MODULE_ID];

/// Start/stop the background service behind a module id (no-op for UI-only tools).
pub fn apply_module_service<R: Runtime>(app: &AppHandle<R>, id: &str, enabled: bool) {
    match id {
        clips::MODULE_ID => clips::set_running(app, enabled),
        dcheck::MODULE_ID => dcheck::set_running(app, enabled),
        runtime::MODULE_ID => runtime::set_running(app, enabled),
        _ => {}
    }
}

/// On startup (and when eco mode switches off), launch services only for
/// modules the user hasn't toggled off. Eco mode keeps everything paused.
pub fn start_enabled_services<R: Runtime>(app: &AppHandle<R>, cfg: &config::Config) {
    if cfg.eco_mode {
        return;
    }
    for id in SERVICE_MODULES {
        if !cfg.disabled_modules.iter().any(|m| m == id) {
            apply_module_service(app, id, true);
        }
    }
}

/// Eco mode on: stop every background service, module toggles untouched.
pub fn stop_all_services<R: Runtime>(app: &AppHandle<R>) {
    for id in SERVICE_MODULES {
        apply_module_service(app, id, false);
    }
}
