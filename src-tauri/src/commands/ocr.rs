//! OCR behind a trait so a cross-platform engine can drop in later (spec §10).
//! v1 ships `WindowsOcr` (Windows.Media.Ocr); other targets get a stub.

use image::RgbaImage;
use serde::Deserialize;
use tauri::{Runtime, State};
use thiserror::Error;

use super::capture::AppState;

#[derive(Debug, Error)]
pub enum OcrError {
    #[error("no OCR language is available; install a Windows language pack")]
    NoLanguage,
    #[error("OCR failed: {0}")]
    Engine(String),
}

/// The abstraction the rest of the app depends on.
pub trait OcrEngine {
    fn recognize(&self, img: &RgbaImage) -> Result<String, OcrError>;
}

/// Windows.Media.Ocr implementation.
pub struct WindowsOcr;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Clamp a selection rectangle to the frame; `None` if it lands fully off-frame.
pub fn clamp_rect(rect: &Rect, img_w: u32, img_h: u32) -> Option<(u32, u32, u32, u32)> {
    let x = rect.x.max(0) as u32;
    let y = rect.y.max(0) as u32;
    if x >= img_w || y >= img_h {
        return None;
    }
    let w = rect.width.min(img_w - x);
    let h = rect.height.min(img_h - y);
    if w == 0 || h == 0 {
        None
    } else {
        Some((x, y, w, h))
    }
}

/// Crop the frozen frame to `rect`, OCR it, and return recognized text.
#[tauri::command]
pub async fn ocr_region<R: Runtime>(
    _app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    rect: Rect,
) -> Result<String, String> {
    // Clone the cropped region out and release the lock before the (blocking) OCR.
    let cropped: RgbaImage = {
        let guard = state.frame.lock().map_err(|_| "capture state poisoned")?;
        let frame = guard.as_ref().ok_or("no active capture")?;
        let (x, y, w, h) =
            clamp_rect(&rect, frame.width, frame.height).ok_or("selection is empty")?;
        let full = image::RgbaImage::from_raw(frame.width, frame.height, frame.rgba.clone())
            .ok_or("corrupt capture buffer")?;
        image::imageops::crop_imm(&full, x, y, w, h).to_image()
    };

    WindowsOcr.recognize(&cropped).map_err(|e| e.to_string())
}

#[cfg(windows)]
impl OcrEngine for WindowsOcr {
    fn recognize(&self, img: &RgbaImage) -> Result<String, OcrError> {
        use windows::core::HSTRING;
        use windows::Globalization::Language;
        use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
        use windows::Media::Ocr::OcrEngine as WinOcrEngine;
        use windows::Storage::Streams::DataWriter;

        let werr = |e: windows::core::Error| OcrError::Engine(e.to_string());
        let (w, h) = (img.width() as i32, img.height() as i32);

        // Windows OCR wants BGRA8; our buffer is RGBA8 — swap R and B.
        let mut bgra = img.as_raw().clone();
        for px in bgra.chunks_exact_mut(4) {
            px.swap(0, 2);
        }

        let writer = DataWriter::new().map_err(werr)?;
        writer.WriteBytes(&bgra).map_err(werr)?;
        let buffer = writer.DetachBuffer().map_err(werr)?;

        let bitmap =
            SoftwareBitmap::CreateCopyFromBuffer(&buffer, BitmapPixelFormat::Bgra8, w, h)
                .map_err(werr)?;

        // Prefer the user's profile languages; fall back to English.
        let engine = WinOcrEngine::TryCreateFromUserProfileLanguages()
            .or_else(|_| {
                let en = Language::CreateLanguage(&HSTRING::from("en")).map_err(werr)?;
                WinOcrEngine::TryCreateFromLanguage(&en).map_err(werr)
            })
            .map_err(|_| OcrError::NoLanguage)?;

        let result = engine
            .RecognizeAsync(&bitmap)
            .map_err(werr)?
            .get()
            .map_err(werr)?;
        Ok(result.Text().map_err(werr)?.to_string_lossy())
    }
}

#[cfg(not(windows))]
impl OcrEngine for WindowsOcr {
    fn recognize(&self, _img: &RgbaImage) -> Result<String, OcrError> {
        Err(OcrError::Engine(
            "OCR is only available on Windows in v1".to_string(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: i32, y: i32, width: u32, height: u32) -> Rect {
        Rect { x, y, width, height }
    }

    #[test]
    fn clamps_a_rect_that_overhangs_the_edge() {
        assert_eq!(clamp_rect(&rect(90, 40, 50, 50), 100, 60), Some((90, 40, 10, 20)));
    }

    #[test]
    fn passes_a_fully_contained_rect_through() {
        assert_eq!(clamp_rect(&rect(10, 10, 30, 20), 100, 60), Some((10, 10, 30, 20)));
    }

    #[test]
    fn negative_origin_is_pulled_to_zero() {
        assert_eq!(clamp_rect(&rect(-20, -10, 40, 40), 100, 60), Some((0, 0, 40, 40)));
    }

    #[test]
    fn rejects_a_rect_entirely_off_frame() {
        assert_eq!(clamp_rect(&rect(200, 200, 10, 10), 100, 60), None);
        assert_eq!(clamp_rect(&rect(10, 10, 0, 0), 100, 60), None);
    }
}
