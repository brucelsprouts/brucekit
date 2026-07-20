//! ClipStack module — clipboard history, ported from
//! github.com/brucelsprouts/clipstack and trimmed to text clips.
//!
//! While the module is enabled a background thread polls the OS clipboard;
//! new text is deduped, kept newest-first in memory, and persisted to
//! `clips.json` in the app data dir. Toggling the module off stops the
//! thread entirely, so a disabled module costs nothing.

use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_clipboard_manager::ClipboardExt;

pub const MODULE_ID: &str = "clipstack";
/// Rust → launcher: a new clip was captured; refetch the list.
pub const EV_CLIP_ADDED: &str = "brucekit://clip-added";

const CLIPS_FILE: &str = "clips.json";
const POLL_MS: u64 = 800;
const MAX_TEXT_BYTES: usize = 1_048_576; // 1 MB

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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    pub id: u64,
    pub text: String,
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
    /// Content this app just wrote via `clips_copy`, so the monitor skips it.
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
}

impl Default for ClipsConfig {
    fn default() -> Self {
        Self {
            max_history: DEFAULT_MAX_HISTORY,
            excluded_apps: DEFAULT_EXCLUDED_APPS.iter().map(|s| s.to_string()).collect(),
            honor_sensitive: true,
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

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn clips_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(CLIPS_FILE))
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
    *state.next_id.lock().unwrap() = clips.iter().map(|c| c.id).max().unwrap_or(0) + 1;
    *state.clips.lock().unwrap() = clips;
}

/// Persist the current list. Failures are logged, never fatal — losing a clip
/// beats crashing the launcher.
fn save<R: Runtime>(app: &AppHandle<R>, clips: &[Clip]) {
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

    while running.load(Ordering::Relaxed) {
        thread::sleep(Duration::from_millis(POLL_MS));
        if !running.load(Ordering::Relaxed) {
            break;
        }

        // Re-read settings every cycle so panel changes apply on the next
        // capture without restarting the monitor.
        let cfg = read_clips_config(&app);

        // Non-text clipboard content (images, files) errors out here — skip.
        let Ok(text) = app.clipboard().read_text() else { continue };
        let text = text.trim().to_string();
        if text.is_empty() || text.len() > MAX_TEXT_BYTES {
            continue;
        }
        if last_seen.as_deref() == Some(text.as_str()) {
            continue;
        }
        // Mark it seen before the exclusion checks: a skipped secret must not
        // be re-examined every poll, and it must not be captured later if the
        // user switches away from the password manager without copying again.
        last_seen = Some(text.clone());

        if cfg.honor_sensitive && clipboard_is_sensitive() {
            continue;
        }
        if is_excluded(super::runtime::foreground_app().as_deref(), &cfg.excluded_apps) {
            continue;
        }

        let state = app.state::<ClipsState>();

        // Skip content the app itself just wrote via clips_copy (consume flag).
        {
            let mut written = state.last_written.lock().unwrap();
            if written.as_deref() == Some(text.as_str()) {
                *written = None;
                continue;
            }
        }

        let snapshot = {
            let mut clips = state.clips.lock().unwrap();
            // Dedupe against the newest stored clip (e.g. after app restart).
            if clips.first().map(|c| c.text.as_str()) == Some(text.as_str()) {
                continue;
            }
            let id = {
                let mut next = state.next_id.lock().unwrap();
                let id = (*next).max(1);
                *next = id + 1;
                id
            };
            clips.insert(
                0,
                Clip { id, text, pinned: false, created_at: now_ms() },
            );
            prune(&mut clips, cfg.max_history);
            clips.clone()
        };

        save(&app, &snapshot);
        let _ = app.emit(EV_CLIP_ADDED, ());
    }
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

/// Write a clip's text back to the OS clipboard.
#[tauri::command]
pub fn clips_copy<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, ClipsState>,
    id: u64,
) -> Result<(), String> {
    ensure_loaded(&app);
    let text = {
        let clips = state.clips.lock().unwrap();
        clips
            .iter()
            .find(|c| c.id == id)
            .map(|c| c.text.clone())
            .ok_or_else(|| format!("clip {id} not found"))?
    };
    // Flag it so the monitor doesn't re-log our own write as a new clip.
    *state.last_written.lock().unwrap() = Some(text.clone());
    app.clipboard().write_text(text).map_err(|e| e.to_string())
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
        Clip { id, text: format!("clip {id}"), pinned, created_at }
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
}
