//! ClipStack module — clipboard history, ported from
//! github.com/brucelsprouts/clipstack.
//!
//! While the module is enabled a background thread polls the OS clipboard;
//! new content is deduped, kept newest-first in memory, and persisted to
//! `clips.json` in the app data dir. Toggling the module off stops the
//! thread entirely, so a disabled module costs nothing.
//!
//! Three clipboard flavors are captured, matching what Windows' own clipboard
//! history keeps:
//!
//! * **plain text** — the record's `text`,
//! * **formatted text** — the CF_HTML fragment riding along with it, kept in
//!   `html` so a re-copy pastes with its styling intact. It is *never*
//!   rendered: the panel shows the plain text, and the markup only ever goes
//!   back out to the clipboard,
//! * **images** — PNG-encoded next to `clips.json`, with a small thumbnail
//!   beside each one so the panel can show a preview without decoding a
//!   full-resolution screenshot.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use image::RgbaImage;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{image::Image, AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_clipboard_manager::ClipboardExt;

pub const MODULE_ID: &str = "clipstack";
/// Rust → launcher: a new clip was captured; refetch the list.
pub const EV_CLIP_ADDED: &str = "brucekit://clip-added";

const CLIPS_FILE: &str = "clips.json";
/// Image clips live beside `clips.json`, one PNG plus one thumbnail each.
const IMAGE_DIR: &str = "clip-images";
/// Suffix for files a live clip no longer references. They are renamed rather
/// than deleted so a ctrl+z inside the undo window brings the picture back with
/// the record; the leftovers are purged on the next launch.
const TRASH_SUFFIX: &str = ".trash";
const POLL_MS: u64 = 800;
const MAX_TEXT_BYTES: usize = 1_048_576; // 1 MB
/// Formatting past this is a whole document, not a styled snippet — the plain
/// text is still kept, only the markup is dropped, so `clips.json` stays small.
const MAX_HTML_BYTES: usize = 262_144; // 256 KB
/// Refuse absurd images outright: the RGBA buffer alone is 4 bytes a pixel and
/// has to be hashed and re-encoded on the monitor thread.
const MAX_IMAGE_PIXELS: u64 = 40_000_000;
/// Longest thumbnail side, in px. The panel draws them at roughly a third of
/// this, so they stay sharp on a HiDPI display without storing a second copy
/// of the full image.
const THUMB_MAX: u32 = 320;

/// Default history cap; `0` in the config means unlimited.
pub const DEFAULT_MAX_HISTORY: usize = 200;
/// Hard ceiling so a typo in the panel can't grow `clips.json` without bound.
pub const MAX_HISTORY_LIMIT: usize = 10_000;

/// Apps excluded from capture out of the box. Password managers copy secrets
/// meant to live only until the paste — recording them into a plaintext
/// history on disk is exactly the leak the user is trying to avoid.
pub const DEFAULT_EXCLUDED_APPS: [&str; 8] = [
    "1password",
    "bitwarden",
    "keepass",
    "lastpass",
    "dashlane",
    "nordpass",
    "protonpass",
    "enpass",
];

/// Where an image clip's pixels live. The bytes stay on disk: holding a few
/// hundred screenshots in memory would dwarf everything else the launcher does.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClipImage {
    pub width: u32,
    pub height: u32,
    /// Full-resolution PNG, file name only (the directory is derived).
    pub file: String,
    /// Downscaled PNG the panel previews.
    pub thumb: String,
    /// Fingerprint of the source pixels, so a re-copy of the same picture can
    /// be recognized without decoding what's on disk.
    pub hash: String,
}

/// One history entry. `image` is what distinguishes an image clip from a text
/// one; `html` is optional styling carried alongside plain text.
///
/// Both are `#[serde(default)]` so a `clips.json` written before either
/// existed still loads.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    pub id: u64,
    /// Plain text, and for an image clip its searchable label ("Image 800×600").
    pub text: String,
    /// CF_HTML fragment; restored on copy, never rendered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub html: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<ClipImage>,
    pub pinned: bool,
    /// Unix millis.
    pub created_at: i64,
}

#[derive(Default)]
pub struct ClipsState {
    /// Newest first. Pinned clips are surfaced at list time, not stored apart.
    clips: Mutex<Vec<Clip>>,
    loaded: Mutex<bool>,
    next_id: Mutex<u64>,
    /// Fingerprint of what this app just wrote via `clips_copy`, so the monitor
    /// skips it (see `fingerprint_text` / `fingerprint_image`).
    last_written: Mutex<Option<String>>,
    running: Mutex<Option<Arc<AtomicBool>>>,
}

// ─── Per-tool settings (tools.clipstack in config.json) ──────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct ClipsConfig {
    /// Cap on retained clips; `0` means unlimited. Pinned clips never count
    /// against it and never expire.
    pub max_history: usize,
    /// Lowercased app-name fragments whose clipboard writes are ignored.
    pub excluded_apps: Vec<String>,
    /// Honor the Windows clipboard markers apps use to opt out of history.
    pub honor_sensitive: bool,
    /// Record copied images. Off keeps the history text-only — no PNGs on disk.
    pub capture_images: bool,
}

impl Default for ClipsConfig {
    fn default() -> Self {
        Self {
            max_history: DEFAULT_MAX_HISTORY,
            excluded_apps: DEFAULT_EXCLUDED_APPS.iter().map(|s| s.to_string()).collect(),
            honor_sensitive: true,
            capture_images: true,
        }
    }
}

/// Pull clipstack settings out of the shared config's tools bag, tolerating
/// any missing or malformed values (pure; unit-tested).
pub fn clips_config_from_tools(tools: &serde_json::Map<String, Value>) -> ClipsConfig {
    let mut cfg = ClipsConfig::default();
    let Some(Value::Object(ns)) = tools.get(MODULE_ID) else { return cfg };

    if let Some(v) = ns.get("maxHistory").and_then(Value::as_u64) {
        cfg.max_history = (v as usize).min(MAX_HISTORY_LIMIT);
    }
    // An explicitly empty list is a real choice ("record everything"), so it is
    // honored rather than falling back to the defaults.
    if let Some(Value::Array(apps)) = ns.get("excludedApps") {
        cfg.excluded_apps = apps
            .iter()
            .filter_map(Value::as_str)
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty())
            .collect();
    }
    if let Some(Value::Bool(honor)) = ns.get("honorSensitive") {
        cfg.honor_sensitive = *honor;
    }
    if let Some(Value::Bool(images)) = ns.get("captureImages") {
        cfg.capture_images = *images;
    }
    cfg
}

fn read_clips_config<R: Runtime>(app: &AppHandle<R>) -> ClipsConfig {
    clips_config_from_tools(&super::config::load(app).tools)
}

/// Whether the foreground app is on the exclusion list. Matching is
/// case-insensitive and by substring, so one entry covers the naming variants
/// a vendor ships ("1Password", "1PasswordDesktop") without the user guessing
/// the exact executable name (pure; unit-tested).
pub fn is_excluded(app: Option<&str>, excluded: &[String]) -> bool {
    let Some(app) = app else { return false };
    let app = app.to_lowercase();
    excluded.iter().any(|e| !e.is_empty() && app.contains(e.as_str()))
}

// ─── Sensitive-clipboard detection ───────────────────────────────────────────

/// Windows lets an app mark a clipboard write as "don't record this" using two
/// well-known formats. Password managers set them, which makes this a far
/// better filter than any app list: it covers apps the user never thought to
/// exclude, and it works per-copy rather than per-app.
///
/// `ExcludeClipboardContentFromMonitorProcessing` is a bare marker — its mere
/// presence means exclude. `CanIncludeInClipboardHistory` carries a DWORD, and
/// only a value of 0 means exclude; reading it needs the clipboard open, so if
/// the read fails we fail closed and treat the clip as sensitive.
#[cfg(windows)]
pub fn clipboard_is_sensitive() -> bool {
    use windows::core::w;
    use windows::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
        RegisterClipboardFormatW,
    };
    use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};

    unsafe {
        let exclude = RegisterClipboardFormatW(w!("ExcludeClipboardContentFromMonitorProcessing"));
        if exclude != 0 && IsClipboardFormatAvailable(exclude).is_ok() {
            return true;
        }

        let history = RegisterClipboardFormatW(w!("CanIncludeInClipboardHistory"));
        if history == 0 || IsClipboardFormatAvailable(history).is_err() {
            return false; // app expressed no preference
        }
        // Present — read the flag. Any failure here is treated as "exclude".
        if OpenClipboard(None).is_err() {
            return true;
        }
        let allowed = match GetClipboardData(history) {
            Ok(handle) if !handle.is_invalid() => {
                let ptr = GlobalLock(windows::Win32::Foundation::HGLOBAL(handle.0)) as *const u32;
                let value = (!ptr.is_null()).then(|| ptr.read_unaligned());
                let _ = GlobalUnlock(windows::Win32::Foundation::HGLOBAL(handle.0));
                value.map(|v| v != 0).unwrap_or(false)
            }
            _ => false,
        };
        let _ = CloseClipboard();
        !allowed
    }
}

#[cfg(not(windows))]
pub fn clipboard_is_sensitive() -> bool {
    false
}

// ─── Formatted text (CF_HTML) ────────────────────────────────────────────────

/// Pull the copied fragment out of a CF_HTML payload.
///
/// CF_HTML is a plain-text header (`Version:`, `StartHTML:`, `StartFragment:`…)
/// followed by a document in which the copied selection is bracketed by
/// `<!--StartFragment-->` / `<!--EndFragment-->`. The markers are preferred
/// because they survive an app that miscounts its own byte offsets — a common
/// enough bug that Windows itself tolerates it — and the offsets are the
/// fallback for the apps that omit the comments (pure; unit-tested).
///
/// The result is only ever written back to the clipboard, never rendered, so
/// there is nothing to sanitize here.
pub fn html_fragment(cf_html: &str) -> Option<String> {
    const START: &str = "<!--StartFragment-->";
    const END: &str = "<!--EndFragment-->";

    let fragment = match (cf_html.find(START), cf_html.find(END)) {
        (Some(s), Some(e)) if e >= s + START.len() => &cf_html[s + START.len()..e],
        _ => cf_html.get(header_offset(cf_html, "StartFragment:")?..header_offset(cf_html, "EndFragment:")?)?,
    };
    let fragment = fragment.trim();
    (!fragment.is_empty()).then(|| fragment.to_string())
}

/// Read one `Key:0000000123` byte offset out of the CF_HTML header.
fn header_offset(cf_html: &str, key: &str) -> Option<usize> {
    let rest = cf_html.get(cf_html.find(key)? + key.len()..)?;
    rest.chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>()
        .parse()
        .ok()
}

/// The styled version of whatever text is on the clipboard, if any.
#[cfg(windows)]
pub fn read_clipboard_html() -> Option<String> {
    use windows::core::w;
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
        RegisterClipboardFormatW,
    };
    use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

    unsafe {
        let fmt = RegisterClipboardFormatW(w!("HTML Format"));
        if fmt == 0 || IsClipboardFormatAvailable(fmt).is_err() {
            return None;
        }
        if OpenClipboard(None).is_err() {
            return None;
        }
        let raw = match GetClipboardData(fmt) {
            Ok(handle) if !handle.is_invalid() => {
                let hglobal = HGLOBAL(handle.0);
                let ptr = GlobalLock(hglobal) as *const u8;
                let text = (!ptr.is_null()).then(|| {
                    // CF_HTML is a NUL-terminated UTF-8 blob; GlobalSize is the
                    // allocation, which may be padded past the terminator.
                    let bytes = std::slice::from_raw_parts(ptr, GlobalSize(hglobal));
                    let end = bytes.iter().position(|b| *b == 0).unwrap_or(bytes.len());
                    String::from_utf8_lossy(&bytes[..end]).into_owned()
                });
                let _ = GlobalUnlock(hglobal);
                text
            }
            _ => None,
        };
        let _ = CloseClipboard();
        raw.as_deref()
            .and_then(html_fragment)
            .filter(|h| h.len() <= MAX_HTML_BYTES)
    }
}

#[cfg(not(windows))]
pub fn read_clipboard_html() -> Option<String> {
    None
}

/// Windows bumps a global counter on every clipboard write, which is far
/// cheaper to check than reading the contents — an image copy would otherwise
/// cost a full decode and hash on every poll just to conclude nothing changed.
///
/// `None` on platforms without the counter; callers fall back to comparing
/// content.
#[cfg(windows)]
fn clipboard_sequence() -> Option<u32> {
    use windows::Win32::System::DataExchange::GetClipboardSequenceNumber;
    Some(unsafe { GetClipboardSequenceNumber() })
}

#[cfg(not(windows))]
fn clipboard_sequence() -> Option<u32> {
    None
}

// ─── Fingerprints ────────────────────────────────────────────────────────────

/// FNV-1a over the pixels. Not cryptographic — this only has to tell "the same
/// screenshot again" from "a different one", and it runs on the monitor thread.
fn fingerprint_image(rgba: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in rgba {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// Namespaced so a text clip whose contents happen to look like an image hash
/// can't be mistaken for one.
fn fingerprint_text(text: &str) -> String {
    format!("t:{text}")
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn clips_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(CLIPS_FILE))
}

fn images_dir<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(IMAGE_DIR))
}

// ─── Image clips on disk ─────────────────────────────────────────────────────

/// Fit `width`×`height` inside a `THUMB_MAX` box, preserving aspect and never
/// upscaling — a 40×20 favicon stays 40×20 rather than being blown up into a
/// blurry banner (pure; unit-tested).
pub fn thumb_size(width: u32, height: u32) -> (u32, u32) {
    let longest = width.max(height);
    if longest == 0 || longest <= THUMB_MAX {
        return (width.max(1), height.max(1));
    }
    let scale = f64::from(THUMB_MAX) / f64::from(longest);
    let scaled = |n: u32| ((f64::from(n) * scale).round() as u32).max(1);
    (scaled(width), scaled(height))
}

/// Write a clipboard image out as `<id>.png` plus `<id>.thumb.png` and return
/// the record pointing at them. `None` if anything on the way failed — a clip
/// we can't show or re-copy is worse than no clip.
fn store_image(
    dir: &Path,
    id: u64,
    rgba: Vec<u8>,
    width: u32,
    height: u32,
    hash: String,
) -> Option<ClipImage> {
    if let Err(e) = fs::create_dir_all(dir) {
        eprintln!("[brucekit] clipstack: cannot create {}: {e}", dir.display());
        return None;
    }
    let full = RgbaImage::from_raw(width, height, rgba)?;
    let (tw, th) = thumb_size(width, height);
    let thumb = image::imageops::thumbnail(&full, tw, th);

    let file = format!("{id}.png");
    let thumb_file = format!("{id}.thumb.png");
    if let Err(e) = full.save(dir.join(&file)) {
        eprintln!("[brucekit] clipstack: failed to save {file}: {e}");
        return None;
    }
    if let Err(e) = thumb.save(dir.join(&thumb_file)) {
        eprintln!("[brucekit] clipstack: failed to save {thumb_file}: {e}");
        let _ = fs::remove_file(dir.join(&file));
        return None;
    }
    Some(ClipImage { width, height, file, thumb: thumb_file, hash })
}

/// Every image file the live history still points at.
fn referenced_files(clips: &[Clip]) -> Vec<&str> {
    clips
        .iter()
        .filter_map(|c| c.image.as_ref())
        .flat_map(|i| [i.file.as_str(), i.thumb.as_str()])
        .collect()
}

/// Deal with image files no clip references any more.
///
/// `hard` deletes them; otherwise they are renamed aside with `TRASH_SUFFIX`,
/// which is what keeps ctrl+z after a delete or a "clear history" able to bring
/// the pictures back and not just the rows. Trash is only ever hard-purged at
/// load time, since no undo survives a restart.
fn sweep_images(dir: &Path, clips: &[Clip], hard: bool) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let keep = referenced_files(clips);

    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let trashed = name.ends_with(TRASH_SUFFIX);
        if !trashed && keep.contains(&name) {
            continue;
        }
        if hard || trashed {
            let _ = fs::remove_file(entry.path());
        } else {
            let _ = fs::rename(entry.path(), dir.join(format!("{name}{TRASH_SUFFIX}")));
        }
    }
}

/// Bring back the files behind clips being undone (see `sweep_images`).
fn untrash_images(dir: &Path, clips: &[Clip]) {
    for name in referenced_files(clips) {
        let live = dir.join(name);
        if live.exists() {
            continue;
        }
        let _ = fs::rename(dir.join(format!("{name}{TRASH_SUFFIX}")), live);
    }
}

/// Load an image clip's pixels back off disk for a re-copy.
fn load_image(path: &Path) -> Result<(Vec<u8>, u32, u32), String> {
    let img = image::open(path)
        .map_err(|e| format!("could not read the saved image: {e}"))?
        .to_rgba8();
    let (w, h) = (img.width(), img.height());
    Ok((img.into_raw(), w, h))
}

/// Load `clips.json` once per app run; later calls are no-ops.
fn ensure_loaded<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<ClipsState>();
    let mut loaded = state.loaded.lock().unwrap();
    if *loaded {
        return;
    }
    *loaded = true;

    let Some(path) = clips_path(app) else { return };
    let Ok(raw) = fs::read_to_string(path) else { return };
    let Ok(mut clips) = serde_json::from_str::<Vec<Clip>>(&raw) else { return };

    clips.sort_by_key(|c| std::cmp::Reverse(c.created_at));
    // Lowering the cap in the panel takes effect on the next load, not just on
    // the next capture.
    prune(&mut clips, read_clips_config(app).max_history);
    // Drop for real what the last run only renamed aside, plus anything the
    // pruning above just orphaned. Nothing can be undone across a restart, so
    // there is no reason to keep the pixels around.
    if let Some(dir) = images_dir(app) {
        sweep_images(&dir, &clips, true);
    }
    *state.next_id.lock().unwrap() = clips.iter().map(|c| c.id).max().unwrap_or(0) + 1;
    *state.clips.lock().unwrap() = clips;
}

/// Persist the current list and retire the image files it no longer points at.
/// Failures are logged, never fatal — losing a clip beats crashing the launcher.
fn save<R: Runtime>(app: &AppHandle<R>, clips: &[Clip]) {
    if let Some(dir) = images_dir(app) {
        sweep_images(&dir, clips, false);
    }
    let Some(path) = clips_path(app) else { return };
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    match serde_json::to_string(clips) {
        Ok(json) => {
            if let Err(e) = fs::write(&path, json) {
                eprintln!("[brucekit] clipstack: failed to write {}: {e}", path.display());
            }
        }
        Err(e) => eprintln!("[brucekit] clipstack: serialize failed: {e}"),
    }
}

/// Start or stop the clipboard monitor thread (module toggle + startup).
pub fn set_running<R: Runtime>(app: &AppHandle<R>, enabled: bool) {
    let state = app.state::<ClipsState>();
    let mut running = state.running.lock().unwrap();
    if enabled {
        if running.is_some() {
            return; // already monitoring
        }
        drop(running); // ensure_loaded needs the state without this guard held
        ensure_loaded(app);
        let state = app.state::<ClipsState>();
        let flag = Arc::new(AtomicBool::new(true));
        *state.running.lock().unwrap() = Some(flag.clone());
        let handle = app.clone();
        thread::spawn(move || monitor_loop(handle, flag));
    } else if let Some(flag) = running.take() {
        flag.store(false, Ordering::Relaxed);
    }
}

fn monitor_loop<R: Runtime>(app: AppHandle<R>, running: Arc<AtomicBool>) {
    // Seed with the current clipboard so enabling the module doesn't re-log
    // whatever was already copied before it started.
    let mut last_seen: Option<String> = app
        .clipboard()
        .read_text()
        .ok()
        .map(|t| t.trim().to_string());
    let mut last_seq = clipboard_sequence();
    let mut last_image: Option<String> = None;

    while running.load(Ordering::Relaxed) {
        thread::sleep(Duration::from_millis(POLL_MS));
        if !running.load(Ordering::Relaxed) {
            break;
        }

        // Re-read settings every cycle so panel changes apply on the next
        // capture without restarting the monitor.
        let cfg = read_clips_config(&app);

        // Nothing has written to the clipboard since the last look. This gate
        // is what makes image support affordable: without it every poll would
        // decode and hash whatever screenshot is sitting there.
        let seq = clipboard_sequence();
        if seq.is_some() && seq == last_seq {
            continue;
        }

        // Text beats a bitmap on the same clipboard. A copied web selection
        // carries both, and what the user means to get back is the text —
        // which is also how Windows' own history presents it.
        let text = app
            .clipboard()
            .read_text()
            .ok()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty());

        let mut read_ok = text.is_some();
        let mut captured = false;

        if let Some(text) = text {
            captured = capture_text(&app, &cfg, text, &mut last_seen);
        } else if cfg.capture_images {
            if let Ok(img) = app.clipboard().read_image() {
                read_ok = true;
                captured = capture_image(&app, &cfg, &img, &mut last_image);
            }
        }

        // Only commit the counter once something was legible: the app doing the
        // copy often holds the clipboard open for a beat, and treating that as
        // "seen" would skip the content for good.
        if read_ok {
            last_seq = seq;
        }
        if captured {
            let _ = app.emit(EV_CLIP_ADDED, ());
        }
    }
}

/// The two "don't record this" gates, cheapest first.
fn capture_allowed(cfg: &ClipsConfig) -> bool {
    if cfg.honor_sensitive && clipboard_is_sensitive() {
        return false;
    }
    !is_excluded(super::runtime::foreground_app().as_deref(), &cfg.excluded_apps)
}

/// Reserve the next clip id. Ids issued to a capture that is then rejected are
/// simply skipped — they only have to be unique, not contiguous.
fn take_id<R: Runtime>(app: &AppHandle<R>) -> u64 {
    let state = app.state::<ClipsState>();
    let mut next = state.next_id.lock().unwrap();
    let id = (*next).max(1);
    *next = id + 1;
    id
}

/// Whether this content should be ignored because the app itself just wrote it
/// (the flag is consumed) or because it duplicates the newest clip — which is
/// how a re-copy after a restart is caught, once `last_seen` is gone.
fn is_redundant<R: Runtime>(
    app: &AppHandle<R>,
    fingerprint: &str,
    duplicate: impl Fn(&Clip) -> bool,
) -> bool {
    let state = app.state::<ClipsState>();
    {
        let mut written = state.last_written.lock().unwrap();
        if written.as_deref() == Some(fingerprint) {
            *written = None;
            return true;
        }
    }
    let clips = state.clips.lock().unwrap();
    clips.first().is_some_and(duplicate)
}

/// Insert at the head, apply the history cap, persist.
fn push_clip<R: Runtime>(app: &AppHandle<R>, cfg: &ClipsConfig, clip: Clip) {
    let state = app.state::<ClipsState>();
    let snapshot = {
        let mut clips = state.clips.lock().unwrap();
        clips.insert(0, clip);
        prune(&mut clips, cfg.max_history);
        clips.clone()
    };
    save(app, &snapshot);
}

/// Record a copied string, with whatever formatting came with it. Returns
/// whether the history changed.
fn capture_text<R: Runtime>(
    app: &AppHandle<R>,
    cfg: &ClipsConfig,
    text: String,
    last_seen: &mut Option<String>,
) -> bool {
    if text.len() > MAX_TEXT_BYTES || last_seen.as_deref() == Some(text.as_str()) {
        return false;
    }
    // Mark it seen before the exclusion checks: a skipped secret must not be
    // re-examined every poll, and it must not be captured later if the user
    // switches away from the password manager without copying again.
    *last_seen = Some(text.clone());

    if !capture_allowed(cfg) {
        return false;
    }
    let fingerprint = fingerprint_text(&text);
    if is_redundant(app, &fingerprint, |newest| {
        newest.image.is_none() && newest.text == text
    }) {
        return false;
    }

    push_clip(
        app,
        cfg,
        Clip {
            id: take_id(app),
            // Styling is stored so a re-copy pastes as it was copied. The panel
            // never renders it.
            html: read_clipboard_html(),
            text,
            image: None,
            pinned: false,
            created_at: now_ms(),
        },
    );
    true
}

/// Record a copied bitmap as a PNG plus thumbnail. Returns whether the history
/// changed.
fn capture_image<R: Runtime>(
    app: &AppHandle<R>,
    cfg: &ClipsConfig,
    img: &Image<'_>,
    last_image: &mut Option<String>,
) -> bool {
    let (width, height) = (img.width(), img.height());
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_IMAGE_PIXELS {
        return false;
    }
    let hash = fingerprint_image(img.rgba());
    if last_image.as_deref() == Some(hash.as_str()) {
        return false;
    }
    *last_image = Some(hash.clone());

    if !capture_allowed(cfg) {
        return false;
    }
    if is_redundant(app, &hash, |newest| {
        newest.image.as_ref().is_some_and(|i| i.hash == hash)
    }) {
        return false;
    }

    // The id has to exist before the files, which are named after it.
    let id = take_id(app);
    let Some(dir) = images_dir(app) else { return false };
    let Some(image) = store_image(&dir, id, img.rgba().to_vec(), width, height, hash) else {
        return false;
    };

    push_clip(
        app,
        cfg,
        Clip {
            id,
            // Doubles as the row's label and as what the search box matches, so
            // typing "image" pulls up the pictures.
            text: format!("Image {width}×{height}"),
            html: None,
            image: Some(image),
            pinned: false,
            created_at: now_ms(),
        },
    );
    true
}

/// Drop the oldest unpinned clips beyond `max`. Pinned clips never expire, and
/// `max == 0` means unlimited.
fn prune(clips: &mut Vec<Clip>, max: usize) {
    if max == 0 || clips.len() <= max {
        return;
    }
    let mut unpinned = clips.iter().filter(|c| !c.pinned).count();
    let mut i = clips.len();
    while i > 0 && clips.len() > max && unpinned > 0 {
        i -= 1;
        if !clips[i].pinned {
            clips.remove(i);
            unpinned -= 1;
        }
    }
}

// ─── Commands ────────────────────────────────────────────────────────────────

/// List clips, pinned first then newest first, optionally filtered.
#[tauri::command]
pub fn clips_list<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, ClipsState>,
    search: Option<String>,
) -> Vec<Clip> {
    ensure_loaded(&app);
    let clips = state.clips.lock().unwrap();
    let q = search.unwrap_or_default().trim().to_lowercase();
    let mut out: Vec<Clip> = clips
        .iter()
        .filter(|c| q.is_empty() || c.text.to_lowercase().contains(&q))
        .cloned()
        .collect();
    out.sort_by_key(|c| (std::cmp::Reverse(c.pinned), std::cmp::Reverse(c.created_at)));
    out
}

/// Put a clip back on the OS clipboard in the flavor it was captured in: a
/// picture as a bitmap, formatted text with its styling, everything else as
/// plain text.
///
/// `plain` forces the last of those — the panel's "copy as plain text" escape
/// hatch for pasting a styled snippet into somewhere it would look wrong.
#[tauri::command]
pub fn clips_copy<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, ClipsState>,
    id: u64,
    plain: Option<bool>,
) -> Result<(), String> {
    ensure_loaded(&app);
    let clip = {
        let clips = state.clips.lock().unwrap();
        clips
            .iter()
            .find(|c| c.id == id)
            .cloned()
            .ok_or_else(|| format!("clip {id} not found"))?
    };

    if let Some(image) = &clip.image {
        let dir = images_dir(&app).ok_or("could not resolve the app data directory")?;
        let (rgba, width, height) = load_image(&dir.join(&image.file))?;
        // Flag it so the monitor doesn't re-log our own write as a new clip.
        *state.last_written.lock().unwrap() = Some(image.hash.clone());
        return app
            .clipboard()
            .write_image(&Image::new(&rgba, width, height))
            .map_err(|e| e.to_string());
    }

    *state.last_written.lock().unwrap() = Some(fingerprint_text(&clip.text));
    match clip.html.filter(|_| plain != Some(true)) {
        // The plain text goes along as the fallback, so a target that can't take
        // markup still gets the words.
        Some(html) => app
            .clipboard()
            .write_html(html, Some(clip.text))
            .map_err(|e| e.to_string()),
        None => app.clipboard().write_text(clip.text).map_err(|e| e.to_string()),
    }
}

/// An image clip's PNG bytes — the thumbnail for the panel's preview, or the
/// full-resolution original. Raw bytes over IPC, as with the capture pipeline:
/// base64 in a JSON string would be a third larger and cost a decode on both
/// sides.
#[tauri::command]
pub fn clips_image<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, ClipsState>,
    id: u64,
    thumb: Option<bool>,
) -> Result<tauri::ipc::Response, String> {
    ensure_loaded(&app);
    let file = {
        let clips = state.clips.lock().unwrap();
        let image = clips
            .iter()
            .find(|c| c.id == id)
            .and_then(|c| c.image.as_ref())
            .ok_or_else(|| format!("clip {id} has no image"))?;
        if thumb == Some(false) { image.file.clone() } else { image.thumb.clone() }
    };
    let dir = images_dir(&app).ok_or("could not resolve the app data directory")?;
    let bytes = fs::read(dir.join(&file)).map_err(|e| format!("could not read {file}: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn clips_toggle_pin<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, ClipsState>,
    id: u64,
) -> Result<(), String> {
    ensure_loaded(&app);
    let snapshot = {
        let mut clips = state.clips.lock().unwrap();
        let clip = clips
            .iter_mut()
            .find(|c| c.id == id)
            .ok_or_else(|| format!("clip {id} not found"))?;
        clip.pinned = !clip.pinned;
        clips.clone()
    };
    save(&app, &snapshot);
    Ok(())
}

#[tauri::command]
pub fn clips_delete<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, ClipsState>,
    id: u64,
) -> Result<(), String> {
    ensure_loaded(&app);
    let snapshot = {
        let mut clips = state.clips.lock().unwrap();
        clips.retain(|c| c.id != id);
        clips.clone()
    };
    save(&app, &snapshot);
    Ok(())
}

/// Fold restored clips back into the live list, newest first. Ids already
/// present win, so a clip re-captured since the delete isn't duplicated.
fn merge_restored(current: &mut Vec<Clip>, restored: Vec<Clip>) {
    for clip in restored {
        if current.iter().any(|c| c.id == clip.id) {
            continue;
        }
        current.push(clip);
    }
    current.sort_by_key(|c| std::cmp::Reverse(c.created_at));
}

/// Put deleted clips back (ctrl+z in the panel). Ids already present are
/// skipped, so a double undo is harmless.
///
/// Deliberately does not prune: the user is recovering something they just
/// lost, and re-applying the cap here could drop it again on the way in. The
/// next capture prunes as usual.
#[tauri::command]
pub fn clips_restore<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, ClipsState>,
    clips: Vec<Clip>,
) -> Result<(), String> {
    ensure_loaded(&app);
    // Put the pixels back before the records, so the `save` below sees the
    // files as referenced and doesn't sweep them straight out again.
    if let Some(dir) = images_dir(&app) {
        untrash_images(&dir, &clips);
    }
    let snapshot = {
        let mut current = state.clips.lock().unwrap();
        merge_restored(&mut current, clips);
        current.clone()
    };
    // Restored ids were issued before, but keep the counter clear of them in
    // case the store was reloaded while they were gone.
    {
        let mut next = state.next_id.lock().unwrap();
        *next = (*next).max(snapshot.iter().map(|c| c.id).max().unwrap_or(0) + 1);
    }
    save(&app, &snapshot);
    Ok(())
}

/// Re-apply the persisted history cap right away, so lowering it in the panel
/// visibly drops the overflow instead of waiting for the next copy.
#[tauri::command]
pub fn clips_apply_limit<R: Runtime>(app: AppHandle<R>, state: State<'_, ClipsState>) -> usize {
    ensure_loaded(&app);
    let max = read_clips_config(&app).max_history;
    let snapshot = {
        let mut clips = state.clips.lock().unwrap();
        prune(&mut clips, max);
        clips.clone()
    };
    save(&app, &snapshot);
    snapshot.len()
}

/// Reveal `clips.json` in the OS file manager so the user can inspect or
/// delete the history by hand.
#[tauri::command]
pub fn clips_open_folder<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let path = clips_path(&app).ok_or("could not resolve the app data directory")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    reveal(&path)
}

#[cfg(windows)]
fn reveal(path: &std::path::Path) -> Result<(), String> {
    // explorer.exe returns a nonzero exit code even when it succeeds, so the
    // spawn is what we check — not the status.
    std::process::Command::new("explorer.exe")
        .arg(format!("/select,{}", path.display()))
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(not(windows))]
fn reveal(path: &std::path::Path) -> Result<(), String> {
    let dir = path.parent().unwrap_or(path);
    let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    std::process::Command::new(opener)
        .arg(dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clips_clear<R: Runtime>(app: AppHandle<R>, state: State<'_, ClipsState>) {
    ensure_loaded(&app);
    let snapshot = {
        let mut clips = state.clips.lock().unwrap();
        clips.clear();
        clips.clone()
    };
    save(&app, &snapshot);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clip(id: u64, pinned: bool, created_at: i64) -> Clip {
        Clip { id, text: format!("clip {id}"), html: None, image: None, pinned, created_at }
    }

    fn image_clip(id: u64) -> Clip {
        Clip {
            image: Some(ClipImage {
                width: 4,
                height: 2,
                file: format!("{id}.png"),
                thumb: format!("{id}.thumb.png"),
                hash: format!("{id:016x}"),
            }),
            ..clip(id, false, id as i64)
        }
    }

    #[test]
    fn prune_drops_oldest_unpinned_and_keeps_pinned() {
        let mut clips: Vec<Clip> = (0..DEFAULT_MAX_HISTORY as u64 + 5)
            .map(|i| clip(i, i == 10, 10_000 - i as i64)) // newest first; #10 pinned
            .collect();
        prune(&mut clips, DEFAULT_MAX_HISTORY);
        assert_eq!(clips.len(), DEFAULT_MAX_HISTORY);
        assert!(clips.iter().any(|c| c.id == 10), "pinned clip must survive");
        assert!(clips.iter().any(|c| c.id == 0), "newest clip must survive");
    }

    #[test]
    fn merge_restored_puts_a_deleted_clip_back_in_time_order() {
        let mut clips = vec![clip(3, false, 300), clip(1, false, 100)];
        merge_restored(&mut clips, vec![clip(2, false, 200)]);
        assert_eq!(
            clips.iter().map(|c| c.id).collect::<Vec<_>>(),
            vec![3, 2, 1],
            "restored clip lands at its original position, not on top"
        );
    }

    #[test]
    fn merge_restored_ignores_ids_that_are_already_back() {
        // Undo pressed twice, or the same text re-copied since the delete.
        let mut clips = vec![clip(1, false, 100)];
        merge_restored(&mut clips, vec![clip(1, false, 100)]);
        assert_eq!(clips.len(), 1, "no duplicate for a live id");
    }

    #[test]
    fn merge_restored_rebuilds_a_wiped_history() {
        let mut clips = vec![];
        merge_restored(&mut clips, vec![clip(1, false, 100), clip(2, true, 200)]);
        assert_eq!(clips.iter().map(|c| c.id).collect::<Vec<_>>(), vec![2, 1]);
        assert!(clips.iter().find(|c| c.id == 2).unwrap().pinned, "pins survive the round-trip");
    }

    #[test]
    fn prune_with_zero_max_keeps_everything() {
        let mut clips: Vec<Clip> = (0..500).map(|i| clip(i, false, 10_000 - i as i64)).collect();
        prune(&mut clips, 0);
        assert_eq!(clips.len(), 500, "0 means unlimited");
    }

    #[test]
    fn prune_never_evicts_pinned_even_past_the_cap() {
        let mut clips: Vec<Clip> = (0..10).map(|i| clip(i, true, 10_000 - i as i64)).collect();
        prune(&mut clips, 3);
        assert_eq!(clips.len(), 10, "all pinned, so the cap cannot be met");
    }

    #[test]
    fn clips_config_defaults_when_namespace_missing() {
        let cfg = clips_config_from_tools(&serde_json::Map::new());
        assert_eq!(cfg.max_history, DEFAULT_MAX_HISTORY);
        assert!(cfg.honor_sensitive, "sensitive-clip filtering is on by default");
        assert!(cfg.excluded_apps.iter().any(|a| a == "1password"));
    }

    #[test]
    fn clips_config_reads_and_clamps_values() {
        let mut tools = serde_json::Map::new();
        tools.insert(
            MODULE_ID.to_string(),
            serde_json::json!({
                "maxHistory": 99_999,
                "excludedApps": ["  KeePassXC  ", "", "Vault"],
                "honorSensitive": false,
            }),
        );
        let cfg = clips_config_from_tools(&tools);
        assert_eq!(cfg.max_history, MAX_HISTORY_LIMIT, "clamped to the ceiling");
        assert_eq!(cfg.excluded_apps, vec!["keepassxc", "vault"], "trimmed, lowercased, compacted");
        assert!(!cfg.honor_sensitive);
    }

    #[test]
    fn clips_config_honors_an_explicitly_empty_exclusion_list() {
        let mut tools = serde_json::Map::new();
        tools.insert(MODULE_ID.to_string(), serde_json::json!({ "excludedApps": [] }));
        assert!(
            clips_config_from_tools(&tools).excluded_apps.is_empty(),
            "clearing the list must not silently restore the defaults"
        );
    }

    #[test]
    fn is_excluded_matches_case_insensitively_by_substring() {
        let list = vec!["1password".to_string(), "keepass".to_string()];
        assert!(is_excluded(Some("1Password"), &list));
        assert!(is_excluded(Some("KeePassXC"), &list), "vendor name variants match");
        assert!(!is_excluded(Some("notepad"), &list));
        assert!(!is_excluded(None, &list), "unknown foreground app is not excluded");
        assert!(!is_excluded(Some("notepad"), &[]), "empty list excludes nothing");
    }

    #[test]
    fn is_excluded_ignores_empty_entries() {
        // A blank row in the panel editor must not match every app.
        assert!(!is_excluded(Some("notepad"), &["".to_string()]));
    }

    #[test]
    fn clip_serializes_camel_case() {
        let text = serde_json::to_string(&clip(1, false, 42)).unwrap();
        assert!(text.contains("createdAt"));
    }

    #[test]
    fn clip_written_before_images_and_formatting_still_loads() {
        // The shape shipped by earlier versions — the new fields must default
        // rather than fail the whole `clips.json` parse.
        let raw = r#"[{"id":1,"text":"hi","pinned":true,"createdAt":42}]"#;
        let clips: Vec<Clip> = serde_json::from_str(raw).unwrap();
        assert_eq!(clips[0].text, "hi");
        assert!(clips[0].html.is_none() && clips[0].image.is_none());
        assert!(clips[0].pinned);
    }

    #[test]
    fn text_only_clips_serialize_without_the_new_fields() {
        // Every clip carrying `"html":null,"image":null` would bloat the store
        // for the common case.
        let text = serde_json::to_string(&clip(1, false, 42)).unwrap();
        assert!(!text.contains("html") && !text.contains("image"), "got {text}");
    }

    #[test]
    fn clips_config_reads_the_image_toggle() {
        let mut tools = serde_json::Map::new();
        tools.insert(MODULE_ID.to_string(), serde_json::json!({ "captureImages": false }));
        assert!(!clips_config_from_tools(&tools).capture_images);
        assert!(
            clips_config_from_tools(&serde_json::Map::new()).capture_images,
            "images are recorded unless the user says otherwise"
        );
    }

    #[test]
    fn thumb_size_fits_the_box_and_keeps_the_aspect() {
        assert_eq!(thumb_size(1920, 1080), (320, 180));
        assert_eq!(thumb_size(1080, 1920), (180, 320));
        assert_eq!(thumb_size(640, 640), (320, 320));
    }

    #[test]
    fn thumb_size_never_upscales_a_small_image() {
        assert_eq!(thumb_size(40, 20), (40, 20), "a favicon stays a favicon");
        assert_eq!(thumb_size(0, 0), (1, 1), "degenerate input still yields a valid size");
    }

    #[test]
    fn thumb_size_keeps_a_sliver_at_least_one_pixel() {
        // A 2000×3 rule would round its short side to zero, which no encoder
        // will accept.
        let (w, h) = thumb_size(2000, 3);
        assert_eq!((w, h), (320, 1));
    }

    #[test]
    fn html_fragment_prefers_the_markers() {
        let cf = "Version:0.9\r\nStartHTML:000000097\r\nEndHTML:000000200\r\n\
                  StartFragment:000000131\r\nEndFragment:000000160\r\n\
                  <html><body><!--StartFragment--><b>bold</b><!--EndFragment--></body></html>";
        assert_eq!(html_fragment(cf).unwrap(), "<b>bold</b>");
    }

    #[test]
    fn html_fragment_falls_back_to_the_header_offsets() {
        // No comment markers: the offsets are byte positions into the payload.
        let head = "Version:0.9\r\nStartFragment:0000000000\r\nEndFragment:0000000000\r\n";
        let body = "<i>x</i>";
        let start = head.len();
        let cf = format!(
            "Version:0.9\r\nStartFragment:{start:010}\r\nEndFragment:{:010}\r\n{body}",
            start + body.len()
        );
        assert_eq!(cf.len() - body.len(), head.len(), "header width must match the padding");
        assert_eq!(html_fragment(&cf).unwrap(), "<i>x</i>");
    }

    #[test]
    fn html_fragment_rejects_unusable_payloads() {
        assert!(html_fragment("").is_none());
        assert!(html_fragment("just some text").is_none(), "no markers and no offsets");
        assert!(
            html_fragment("<!--StartFragment-->   \r\n<!--EndFragment-->").is_none(),
            "a whitespace-only fragment is not formatting worth keeping"
        );
    }

    #[test]
    fn html_fragment_survives_offsets_that_run_past_the_payload() {
        // Apps do miscount; a bad offset must not panic the monitor thread.
        let cf = "StartFragment:0000000010\r\nEndFragment:0009999999\r\n<b>x</b>";
        assert!(html_fragment(cf).is_none());
    }

    #[test]
    fn fingerprints_of_text_and_images_cannot_collide() {
        let hash = fingerprint_image(&[1, 2, 3, 4]);
        assert_ne!(fingerprint_text(&hash), hash, "the text namespace is prefixed");
        assert_eq!(fingerprint_image(&[1, 2, 3, 4]), hash, "stable for equal pixels");
        assert_ne!(fingerprint_image(&[1, 2, 3, 5]), hash);
    }

    #[test]
    fn referenced_files_lists_both_sizes_and_skips_text_clips() {
        let clips = vec![image_clip(7), clip(8, false, 8)];
        assert_eq!(referenced_files(&clips), vec!["7.png", "7.thumb.png"]);
    }

    // ─── Image files on disk ─────────────────────────────────────────────────

    /// A scratch directory of its own, so these can run in parallel.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("brucekit-clips-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// An opaque `width`×`height` image whose pixels vary, so a round-trip that
    /// silently dropped a channel or transposed the rows would show up.
    fn pixels(width: u32, height: u32) -> Vec<u8> {
        (0..width * height)
            .flat_map(|i| [(i % 251) as u8, (i % 253) as u8, (i % 247) as u8, 255])
            .collect()
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut out: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        out.sort();
        out
    }

    #[test]
    fn an_image_survives_the_round_trip_through_disk() {
        let dir = scratch("roundtrip");
        let rgba = pixels(400, 200);

        let stored =
            store_image(&dir, 9, rgba.clone(), 400, 200, "hash".into()).expect("store failed");
        assert_eq!((stored.width, stored.height), (400, 200));

        // What goes back on the clipboard has to be the original, pixel for
        // pixel — the thumbnail is only ever for the panel.
        let (back, w, h) = load_image(&dir.join(&stored.file)).unwrap();
        assert_eq!((w, h), (400, 200));
        assert_eq!(back, rgba);
        assert_eq!(fingerprint_image(&back), fingerprint_image(&rgba));

        let (_, tw, th) = load_image(&dir.join(&stored.thumb)).unwrap();
        assert_eq!((tw, th), thumb_size(400, 200), "the preview is the scaled copy");
        assert!(
            fs::metadata(dir.join(&stored.thumb)).unwrap().len()
                < fs::metadata(dir.join(&stored.file)).unwrap().len(),
            "a preview that isn't smaller than the original is pointless"
        );
    }

    #[test]
    fn load_image_reports_a_missing_file_instead_of_panicking() {
        let dir = scratch("missing");
        assert!(load_image(&dir.join("nope.png")).is_err());
    }

    #[test]
    fn sweeping_sets_orphans_aside_so_an_undo_can_reclaim_them() {
        let dir = scratch("sweep-undo");
        let clip = image_clip(3);
        store_image(&dir, 3, pixels(8, 8), 8, 8, "hash".into()).unwrap();

        // The clip is deleted: its files go aside, not away.
        sweep_images(&dir, &[], false);
        assert_eq!(names(&dir), vec!["3.png.trash", "3.thumb.png.trash"]);

        // ...and ctrl+z brings them back under their real names.
        untrash_images(&dir, std::slice::from_ref(&clip));
        assert_eq!(names(&dir), vec!["3.png", "3.thumb.png"]);
        assert_eq!(load_image(&dir.join("3.png")).unwrap().1, 8, "still a readable PNG");
    }

    #[test]
    fn sweeping_leaves_the_files_of_live_clips_alone() {
        let dir = scratch("sweep-live");
        store_image(&dir, 1, pixels(4, 4), 4, 4, "a".into()).unwrap();
        store_image(&dir, 2, pixels(4, 4), 4, 4, "b".into()).unwrap();

        sweep_images(&dir, &[image_clip(2)], false);

        assert_eq!(names(&dir), vec!["1.png.trash", "1.thumb.png.trash", "2.png", "2.thumb.png"]);
    }

    #[test]
    fn a_hard_sweep_takes_the_leftovers_with_it() {
        // What load time does: no undo survives a restart, so trash from the
        // last run is dead weight.
        let dir = scratch("sweep-hard");
        store_image(&dir, 1, pixels(4, 4), 4, 4, "a".into()).unwrap();
        sweep_images(&dir, &[], false);
        store_image(&dir, 2, pixels(4, 4), 4, 4, "b".into()).unwrap();

        sweep_images(&dir, &[image_clip(2)], true);

        assert_eq!(names(&dir), vec!["2.png", "2.thumb.png"]);
    }

    #[test]
    fn untrashing_does_not_clobber_a_file_that_is_already_there() {
        // Undo pressed twice, or the same picture re-copied since the delete.
        let dir = scratch("untrash-twice");
        let stored = store_image(&dir, 5, pixels(4, 4), 4, 4, "hash".into()).unwrap();
        let before = fs::read(dir.join(&stored.file)).unwrap();

        untrash_images(&dir, &[image_clip(5)]);

        assert_eq!(fs::read(dir.join(&stored.file)).unwrap(), before);
        assert_eq!(names(&dir), vec!["5.png", "5.thumb.png"]);
    }

    #[test]
    fn sweeping_a_directory_that_was_never_created_is_harmless() {
        // Nothing has been copied yet, or images are switched off entirely.
        let dir = std::env::temp_dir().join("brucekit-clips-absent");
        let _ = fs::remove_dir_all(&dir);
        sweep_images(&dir, &[], true);
        untrash_images(&dir, &[image_clip(1)]);
    }
}
