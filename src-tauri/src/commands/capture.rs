//! Freeze-frame capture (spec §3.3). Rust snapshots the active monitor into
//! memory *first*, then the overlay renders that frozen frame; every subsequent
//! OCR/pixel read works against these exact static pixels.
//!
//! The frame is stored as raw row-major RGBA8 bytes so `xcap`'s image-crate
//! version never has to match ours — we only borrow its pixels.

use std::io::Cursor;
use std::sync::Mutex;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State};

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
}

/// App-wide capture slot. Only one capture is ever in flight.
#[derive(Default)]
pub struct AppState {
    pub frame: Mutex<Option<CapturedFrame>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureDims {
    pub width: u32,
    pub height: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureFrame {
    pub width: u32,
    pub height: u32,
    pub data_url: String,
    pub mode: CaptureMode,
}

/// Encode raw RGBA8 as a `data:image/png;base64,...` URL for the overlay backdrop.
fn to_png_data_url(rgba: &[u8], width: u32, height: u32) -> Result<String, String> {
    use image::ImageEncoder;
    let mut bytes: Vec<u8> = Vec::new();
    image::codecs::png::PngEncoder::new(&mut Cursor::new(&mut bytes))
        .write_image(rgba, width, height, image::ExtendedColorType::Rgba8)
        .map_err(|e| e.to_string())?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:image/png;base64,{b64}"))
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

    *state.frame.lock().map_err(|_| "capture state poisoned")? = Some(CapturedFrame {
        width,
        height,
        rgba,
        mode,
    });

    crate::window::show_overlay(&app, &monitor)?;
    Ok(CaptureDims { width, height })
}

/// The overlay pulls the frozen frame (as a data URL) and the active mode on mount.
#[tauri::command]
pub fn get_capture(state: State<'_, AppState>) -> Result<CaptureFrame, String> {
    let guard = state.frame.lock().map_err(|_| "capture state poisoned")?;
    let frame = guard.as_ref().ok_or("no active capture")?;
    Ok(CaptureFrame {
        width: frame.width,
        height: frame.height,
        data_url: to_png_data_url(&frame.rgba, frame.width, frame.height)?,
        mode: frame.mode,
    })
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
    }
    Ok(())
}
