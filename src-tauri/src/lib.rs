mod commands;
mod hotkey;
mod tray;
mod window;

use commands::capture::AppState;
use commands::clips::ClipsState;
use commands::dcheck::DcheckState;
use commands::runtime::RuntimeState;
use commands::xpwaste::XpwasteState;

/// Hotkey/tray → launcher: freshly opened, reset to the tool grid.
pub const EV_RESET: &str = "brucekit://reset";
/// Tray → launcher: open the Settings view.
pub const EV_OPEN_SETTINGS: &str = "brucekit://open-settings";
/// Rust → overlay: a fresh capture is stored; refetch the frame + mode.
pub const EV_CAPTURE_READY: &str = "brucekit://capture-ready";
/// Per-module hotkey → launcher: open straight into one tool (payload: id).
pub const EV_OPEN_TOOL: &str = "brucekit://open-tool";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .manage(ClipsState::default())
        .manage(DcheckState::default())
        .manage(RuntimeState::default())
        .manage(XpwasteState::default())
        .manage(window::KeepOpen::default())
        // Click-away dismiss lives here (not JS) so a blur can be forgiven
        // when the cursor shows it's really a resize or header-drag grab —
        // the native size/move loop blips focus exactly like a click-away.
        .on_window_event(|window, event| {
            if window.label() != "launcher" {
                return;
            }
            if matches!(event, tauri::WindowEvent::Focused(false)) {
                window::on_launcher_blur(window);
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();

            let cfg = commands::config::load(&handle);
            if let Err(e) = hotkey::register_all(&handle, &cfg) {
                eprintln!("[brucekit] hotkey registration failed: {e}");
            }

            // The autostart entry records an absolute exe path, so it rots
            // whenever the binary behind it moves — most brutally when the
            // toggle was last flipped from a `tauri dev` run. Heal it here,
            // while we know which executable is really running.
            commands::config::reconcile_autostart(&handle);

            // Nothing to restore size-wise: the launcher opens on the module
            // grid, which measures itself once the webview has laid it out.

            // Background services (clipboard monitor, pinger) run only for
            // modules the user hasn't toggled off — and not at all in eco mode.
            commands::start_enabled_services(&handle, &cfg);

            // Warm the overlay webview now so the first capture shows instantly.
            if let Err(e) = window::ensure_overlay(&handle) {
                eprintln!("[brucekit] overlay pre-create failed: {e}");
            }

            tray::build(&handle)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::capture::capture_monitor,
            commands::capture::get_capture,
            commands::capture::get_capture_pixels,
            commands::capture::cancel_capture,
            commands::ocr::ocr_region,
            commands::color::pick_color,
            commands::config::get_config,
            commands::config::set_config,
            commands::config::set_hotkey,
            commands::config::set_autostart,
            commands::config::set_module_enabled,
            commands::config::set_module_hotkey,
            commands::config::set_module_pinned,
            commands::config::set_eco_mode,
            commands::config::set_launcher_size,
            window::resize_launcher,
            window::set_keep_open,
            commands::clips::clips_list,
            commands::clips::clips_copy,
            commands::clips::clips_image,
            commands::clips::clips_toggle_pin,
            commands::clips::clips_delete,
            commands::clips::clips_clear,
            commands::clips::clips_restore,
            commands::clips::clips_apply_limit,
            commands::clips::clips_open_folder,
            commands::dcheck::dcheck_history,
            commands::dcheck::dcheck_clear,
            commands::runtime::runtime_uptime,
            commands::runtime::runtime_apps,
            commands::xpwaste::xpwaste_state,
            commands::xpwaste::xpwaste_start,
            commands::xpwaste::xpwaste_pause,
            commands::xpwaste::xpwaste_skip,
            commands::xpwaste::xpwaste_reset,
            commands::xpwaste::xpwaste_set_phase,
            commands::xpwaste::xpwaste_bump_cycle,
            commands::xpwaste::xpwaste_apply_settings,
            commands::xpwaste::xpwaste_history,
            commands::xpwaste::xpwaste_delete_entry,
            commands::xpwaste::xpwaste_clear_history,
            commands::xpwaste::xpwaste_pick_sound,
            commands::xpwaste::xpwaste_test_sound,
        ])
        .run(tauri::generate_context!())
        .expect("error while running brucekit");
}
