//! Pixel read + color formatting (spec §11). The formatting mirrors the TS side
//! and is unit-tested here as well.

use serde::{Deserialize, Serialize};
use tauri::State;

use super::capture::AppState;

#[derive(Deserialize)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

#[derive(Serialize)]
pub struct Rgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

/// Clamp a point into `[0, w) × [0, h)` so an edge click still reads a valid pixel.
pub fn clamp_point(x: i32, y: i32, w: u32, h: u32) -> (u32, u32) {
    let cx = x.clamp(0, w as i32 - 1) as u32;
    let cy = y.clamp(0, h as i32 - 1) as u32;
    (cx, cy)
}

/// Read one pixel from the frozen frame.
#[tauri::command]
pub fn pick_color(state: State<'_, AppState>, point: Point) -> Result<Rgb, String> {
    let guard = state.frame.lock().map_err(|_| "capture state poisoned")?;
    let frame = guard.as_ref().ok_or("no active capture")?;
    let (x, y) = clamp_point(point.x, point.y, frame.width, frame.height);
    let idx = ((y * frame.width + x) * 4) as usize;
    Ok(Rgb {
        r: frame.rgba[idx],
        g: frame.rgba[idx + 1],
        b: frame.rgba[idx + 2],
    })
}

// --- Pure formatting (parallel to src/tools/color-picker/color.ts) ----------
// Kept as the Rust-side reference implementation and exercised by the tests
// below (spec §15); not called at runtime, where the JS side does formatting.

#[allow(dead_code)]
pub fn to_hex(r: u8, g: u8, b: u8) -> String {
    format!("#{r:02X}{g:02X}{b:02X}")
}

#[allow(dead_code)]
pub fn to_hsl(r: u8, g: u8, b: u8) -> (u16, u8, u8) {
    let rn = r as f64 / 255.0;
    let gn = g as f64 / 255.0;
    let bn = b as f64 / 255.0;

    let max = rn.max(gn).max(bn);
    let min = rn.min(gn).min(bn);
    let delta = max - min;
    let l = (max + min) / 2.0;

    let (mut h, s) = if delta == 0.0 {
        (0.0, 0.0)
    } else {
        let s = delta / (1.0 - (2.0 * l - 1.0).abs());
        let h = if max == rn {
            ((gn - bn) / delta).rem_euclid(6.0)
        } else if max == gn {
            (bn - rn) / delta + 2.0
        } else {
            (rn - gn) / delta + 4.0
        };
        (h * 60.0, s)
    };
    if h < 0.0 {
        h += 360.0;
    }

    (
        h.round() as u16 % 360,
        (s * 100.0).round() as u8,
        (l * 100.0).round() as u8,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_matches_the_ts_side() {
        assert_eq!(to_hex(255, 255, 255), "#FFFFFF");
        assert_eq!(to_hex(0, 0, 0), "#000000");
        assert_eq!(to_hex(18, 52, 86), "#123456");
        assert_eq!(to_hex(77, 224, 176), "#4DE0B0");
    }

    #[test]
    fn hsl_matches_the_ts_side() {
        assert_eq!(to_hsl(255, 0, 0), (0, 100, 50));
        assert_eq!(to_hsl(0, 128, 0), (120, 100, 25));
        assert_eq!(to_hsl(255, 255, 255), (0, 0, 100));
        assert_eq!(to_hsl(77, 224, 176), (160, 70, 59));
    }

    #[test]
    fn clamp_point_keeps_pixels_in_bounds() {
        assert_eq!(clamp_point(-5, -5, 100, 50), (0, 0));
        assert_eq!(clamp_point(999, 999, 100, 50), (99, 49));
        assert_eq!(clamp_point(10, 20, 100, 50), (10, 20));
    }
}
