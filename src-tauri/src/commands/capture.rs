//! Freeze-frame capture (spec §3.3). Rust snapshots the active monitor into
//! memory *first*, then the overlay renders that frozen frame; every subsequent
//! OCR/pixel read works against these exact static pixels.
//!
//! The frame is stored as raw row-major RGBA8 bytes so `xcap`'s image-crate
//! version never has to match ours — we only borrow its pixels.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptureMode {
    Ocr,
    Color,
}

/// The frozen frame plus the mode the overlay should present.
pub struct CapturedFrame {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
    pub mode: CaptureMode,
    /// Monotonic capture id. The overlay window is reused across captures, so
    /// the frontend keys per-session UI state on this to reset between runs.
    pub seq: u64,
}

/// App-wide capture slot. Only one capture is ever in flight.
#[derive(Default)]
pub struct AppState {
    pub frame: Mutex<Option<CapturedFrame>>,
    pub seq: AtomicU64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureDims {
    pub width: u32,
    pub height: u32,
}

/// Frame metadata; the pixels travel separately as raw bytes (`get_capture_pixels`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureFrame {
    pub width: u32,
    pub height: u32,
    pub mode: CaptureMode,
    pub seq: u64,
}

/// Freeze the monitor under the cursor, stash it, and show the overlay.
#[tauri::command]
pub async fn capture_monitor<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    mode: CaptureMode,
) -> Result<CaptureDims, String> {
    let monitor = crate::window::active_monitor(&app)?;
    let shot = monitor.capture_image().map_err(|e| e.to_string())?;
    let (width, height) = (shot.width(), shot.height());
    let rgba = shot.into_raw();
    let seq = state.seq.fetch_add(1, Ordering::Relaxed) + 1;

    *state.frame.lock().map_err(|_| "capture state poisoned")? = Some(CapturedFrame {
        width,
        height,
        rgba,
        mode,
        seq,
    });

    crate::window::show_overlay(&app, &monitor)?;
    Ok(CaptureDims { width, height })
}

/// The overlay pulls the frozen frame's metadata on each capture-ready signal.
#[tauri::command]
pub fn get_capture(state: State<'_, AppState>) -> Result<CaptureFrame, String> {
    let guard = state.frame.lock().map_err(|_| "capture state poisoned")?;
    let frame = guard.as_ref().ok_or("no active capture")?;
    Ok(CaptureFrame {
        width: frame.width,
        height: frame.height,
        mode: frame.mode,
        seq: frame.seq,
    })
}

/// The frozen frame's raw RGBA8 pixels as bytes over IPC. No PNG encode, no
/// base64, no image decode on the JS side — the overlay paints them straight
/// into a canvas. This is what makes the freeze appear instant.
#[tauri::command]
pub fn get_capture_pixels(state: State<'_, AppState>) -> Result<tauri::ipc::Response, String> {
    let guard = state.frame.lock().map_err(|_| "capture state poisoned")?;
    let frame = guard.as_ref().ok_or("no active capture")?;
    Ok(tauri::ipc::Response::new(frame.rgba.clone()))
}

/// Abort a capture: drop the frame and hide the overlay (Esc / click-away).
#[tauri::command]
pub fn cancel_capture<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    *state.frame.lock().map_err(|_| "capture state poisoned")? = None;
    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.hide();
        // Resync while hidden so the dropped frame doesn't linger in the
        // webview and flash at the start of the next capture.
        let _ = win.emit(crate::EV_CAPTURE_READY, ());
    }
    Ok(())
}
