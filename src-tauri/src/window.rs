//! Launcher + overlay window management (spec §3, §9).

use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};
use xcap::Monitor;

/// The monitor currently under the cursor (spec §3.3, "monitor under the cursor").
pub fn active_monitor<R: Runtime>(app: &AppHandle<R>) -> Result<Monitor, String> {
    let pos = app.cursor_position().map_err(|e| e.to_string())?;
    let (x, y) = (pos.x as i32, pos.y as i32);

    let monitors = Monitor::all().map_err(|e| e.to_string())?;
    let idx = monitors.iter().position(|m| within(m, x, y)).unwrap_or(0);
    monitors
        .into_iter()
        .nth(idx)
        .ok_or_else(|| "no monitor found".to_string())
}

fn within(m: &Monitor, x: i32, y: i32) -> bool {
    x >= m.x() && x < m.x() + m.width() as i32 && y >= m.y() && y < m.y() + m.height() as i32
}

/// Get the overlay window, creating it hidden if it does not exist yet.
///
/// Called at startup so the webview is already warm when the first capture
/// fires — building a WebView2 window mid-capture caused a visible hitch.
pub fn ensure_overlay<R: Runtime>(app: &AppHandle<R>) -> Result<WebviewWindow<R>, String> {
    match app.get_webview_window("overlay") {
        Some(win) => Ok(win),
        None => WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("index.html".into()))
            .title("brucekit overlay")
            .transparent(true)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .shadow(false)
            .visible(false)
            .build()
            .map_err(|e| e.to_string()),
    }
}

/// Show the overlay sized to exactly cover `monitor`, then signal the webview.
///
/// The window (and its React tree) is reused across captures, so after every
/// show we emit `EV_CAPTURE_READY` — the overlay refetches the frozen frame and
/// mode instead of presenting whatever the previous session left mounted.
pub fn show_overlay<R: Runtime>(app: &AppHandle<R>, monitor: &Monitor) -> Result<(), String> {
    let win = ensure_overlay(app)?;

    win.set_position(PhysicalPosition::new(monitor.x(), monitor.y()))
        .map_err(|e| e.to_string())?;
    win.set_size(PhysicalSize::new(monitor.width(), monitor.height()))
        .map_err(|e| e.to_string())?;
    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())?;
    win.emit(crate::EV_CAPTURE_READY, ())
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Center the launcher on the active monitor's upper third.
fn position_launcher<R: Runtime>(app: &AppHandle<R>, win: &WebviewWindow<R>) -> Result<(), String> {
    let monitor = active_monitor(app)?;
    let size = win.outer_size().map_err(|e| e.to_string())?;
    let x = monitor.x() + (monitor.width() as i32 - size.width as i32) / 2;
    let y = monitor.y() + (monitor.height() as i32 - size.height as i32) / 3;
    win.set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())
}

/// Toggle launcher visibility (hotkey / tray click). Fresh opens reset the view.
pub fn toggle_launcher<R: Runtime>(app: &AppHandle<R>) {
    let Some(win) = app.get_webview_window("launcher") else {
        return;
    };
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
    } else {
        let _ = position_launcher(app, &win);
        let _ = win.show();
        let _ = win.set_focus();
        let _ = win.emit(crate::EV_RESET, ());
    }
}

/// Show the launcher and ask it to open the Settings view (tray menu).
pub fn open_settings<R: Runtime>(app: &AppHandle<R>) {
    let Some(win) = app.get_webview_window("launcher") else {
        return;
    };
    let _ = position_launcher(app, &win);
    let _ = win.show();
    let _ = win.set_focus();
    let _ = win.emit(crate::EV_OPEN_SETTINGS, ());
}
