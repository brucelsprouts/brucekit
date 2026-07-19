mod commands;
mod hotkey;
mod tray;
mod window;

use commands::capture::AppState;

/// Hotkey/tray → launcher: freshly opened, reset to the tool grid.
pub const EV_RESET: &str = "brucekit://reset";
/// Tray → launcher: open the Settings view.
pub const EV_OPEN_SETTINGS: &str = "brucekit://open-settings";
/// Rust → overlay: a fresh capture is stored; refetch the frame + mode.
pub const EV_CAPTURE_READY: &str = "brucekit://capture-ready";

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
        .manage(AppState::default())
        .setup(|app| {
            let handle = app.handle().clone();

            let cfg = commands::config::load(&handle);
            if let Err(e) = hotkey::register(&handle, &cfg.hotkey) {
                eprintln!("[brucekit] hotkey registration failed: {e}");
            }

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
        ])
        .run(tauri::generate_context!())
        .expect("error while running brucekit");
}
