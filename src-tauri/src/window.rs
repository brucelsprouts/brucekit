//! Launcher + overlay window management (spec §3, §9).

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};
use xcap::Monitor;

use crate::commands::config::Config;

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

/// Resize-grab band around the window edges (logical px). WebView2 reports a
/// focus blip when the native sizing loop starts, exactly like the move loop.
const EDGE_BAND: f64 = 16.0;
/// Height of the draggable sysbar region (logical px, incl. launcher padding).
///
/// This MUST cover the full `.bk-sysbar` element, because every pointer-down
/// inside it starts a window drag and therefore blurs the window. Measured at
/// 48px (14px launcher padding + 2px bar padding + the 22px nav-button row +
/// 8px padding + 1px border); the margin is headroom for font-metric drift.
/// Undershooting this is not cosmetic — the strip between the constant and the
/// bar's real bottom edge silently closes the launcher on click.
const HEADER_BAND: f64 = 56.0;

/// Decide whether a launcher blur is a resize/move grab (keep open) or a real
/// click-away / app switch (dismiss). Pure — unit-tested. All physical px.
pub fn blur_keeps_open(
    cursor: (f64, f64),
    pos: (i32, i32),
    size: (u32, u32),
    scale: f64,
) -> bool {
    let edge = EDGE_BAND * scale;
    let header = HEADER_BAND * scale;
    let (x, y) = cursor;
    let (left, top) = (pos.0 as f64, pos.1 as f64);
    let (right, bottom) = (left + size.0 as f64, top + size.1 as f64);

    // Beyond the window (plus the grab margin): a genuine click-away.
    if x < left - edge || x > right + edge || y < top - edge || y > bottom + edge {
        return false;
    }
    // On the resize band or the drag header: the native size/move loop is
    // stealing focus for a beat — keep the window alive.
    let near_edge =
        x < left + edge || x > right - edge || y < top + edge || y > bottom - edge;
    let in_header = y >= top && y < top + header;
    near_edge || in_header
}

/// Whether the launcher is currently pinned open against click-away.
///
/// Some panels are meant to be *watched* — dcheck's ping graph is only useful
/// if it can sit on screen while you work in another window. A module opts in
/// via `keepOpen` and the launcher flips this as the active panel changes.
/// Deliberately not persisted: it describes the open view, not a preference,
/// and a restart always lands back on the grid.
#[derive(Default)]
pub struct KeepOpen(pub AtomicBool);

/// Pin/unpin the launcher against click-away dismissal. Esc, the close button,
/// the tray toggle, and the hotkey all still close it — this only suppresses
/// the blur-triggered hide.
#[tauri::command]
pub fn set_keep_open<R: Runtime>(app: AppHandle<R>, enabled: bool) {
    app.state::<KeepOpen>().0.store(enabled, Ordering::Relaxed);
}

/// Launcher lost focus: dismiss unless it's pinned open, or the cursor says
/// it's a resize or drag.
pub fn on_launcher_blur<R: Runtime>(window: &tauri::Window<R>) {
    let app = window.app_handle();
    if app.state::<KeepOpen>().0.load(Ordering::Relaxed) {
        return;
    }
    let keep = match (window.outer_position(), window.outer_size()) {
        (Ok(pos), Ok(size)) => app
            .cursor_position()
            .map(|c| {
                blur_keeps_open(
                    (c.x, c.y),
                    (pos.x, pos.y),
                    (size.width, size.height),
                    window.scale_factor().unwrap_or(1.0),
                )
            })
            .unwrap_or(false),
        _ => false,
    };
    if !keep {
        let _ = window.hide();
    }
}

/// Restore the launcher to the size the user last dragged it to (startup).
pub fn restore_launcher_size<R: Runtime>(app: &AppHandle<R>, cfg: &Config) {
    let Some(size) = cfg.launcher_size else { return };
    let Some(win) = app.get_webview_window("launcher") else { return };
    let _ = win.set_size(LogicalSize::new(size.width, size.height));
}

/// Show the launcher opened straight into one module (per-module hotkey).
pub fn open_tool<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let Some(win) = app.get_webview_window("launcher") else {
        return;
    };
    let _ = position_launcher(app, &win);
    let _ = win.show();
    let _ = win.set_focus();
    let _ = win.emit(crate::EV_OPEN_TOOL, id.to_string());
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

#[cfg(test)]
mod tests {
    use super::*;

    // A 720x480 window at (100, 100), 1.0 scale.
    const POS: (i32, i32) = (100, 100);
    const SIZE: (u32, u32) = (720, 480);

    #[test]
    fn click_far_away_dismisses() {
        assert!(!blur_keeps_open((2000.0, 900.0), POS, SIZE, 1.0));
        assert!(!blur_keeps_open((10.0, 10.0), POS, SIZE, 1.0));
    }

    #[test]
    fn resize_border_grab_keeps_open() {
        // Right edge, just inside and just outside the frame.
        assert!(blur_keeps_open((818.0, 300.0), POS, SIZE, 1.0));
        assert!(blur_keeps_open((824.0, 300.0), POS, SIZE, 1.0));
        // Bottom edge.
        assert!(blur_keeps_open((400.0, 578.0), POS, SIZE, 1.0));
    }

    #[test]
    fn header_drag_keeps_open() {
        assert!(blur_keeps_open((400.0, 125.0), POS, SIZE, 1.0));
    }

    #[test]
    fn whole_sysbar_is_forgiven_down_to_its_bottom_edge() {
        // Regression: the sysbar grew to 48 logical px when the nav controls
        // were added, but HEADER_BAND was still 36 — so a drag started in the
        // 36..48 strip blurred the window and silently closed the launcher.
        // Every row of the bar arms a window drag, so every row must be
        // forgiven. Measured bottom edge is 48; the constant carries margin.
        const SYSBAR_BOTTOM: f64 = 48.0;
        for y in [36.0, 40.0, 44.0, SYSBAR_BOTTOM] {
            assert!(
                blur_keeps_open((400.0, POS.1 as f64 + y), POS, SIZE, 1.0),
                "a drag {y}px below the window top must not dismiss it",
            );
        }
        assert!(HEADER_BAND >= SYSBAR_BOTTOM, "header band must cover the sysbar");
    }

    #[test]
    fn mid_window_still_dismisses_after_the_wider_header_band() {
        // The wider band must not swallow the alt-tab case it sits next to.
        assert!(!blur_keeps_open((460.0, POS.1 as f64 + 200.0), POS, SIZE, 1.0));
    }

    #[test]
    fn app_switch_with_cursor_mid_window_dismisses() {
        // Deep inside the window: our own clicks can't blur, so this is
        // alt-tab — the always-on-top launcher must not linger.
        assert!(!blur_keeps_open((460.0, 340.0), POS, SIZE, 1.0));
    }

    #[test]
    fn bands_scale_with_dpi() {
        // At 2x, 130px from the top is still inside the 36-logical header.
        assert!(blur_keeps_open((400.0, 170.0), POS, SIZE, 2.0));
        assert!(!blur_keeps_open((400.0, 340.0), POS, SIZE, 2.0));
    }
}
