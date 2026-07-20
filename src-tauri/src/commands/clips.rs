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
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_clipboard_manager::ClipboardExt;

pub const MODULE_ID: &str = "clipstack";
/// Rust → launcher: a new clip was captured; refetch the list.
pub const EV_CLIP_ADDED: &str = "brucekit://clip-added";

const CLIPS_FILE: &str = "clips.json";
const POLL_MS: u64 = 800;
const MAX_CLIPS: usize = 200;
const MAX_TEXT_BYTES: usize = 1_048_576; // 1 MB

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
    clips.truncate(MAX_CLIPS);
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

        // Non-text clipboard content (images, files) errors out here — skip.
        let Ok(text) = app.clipboard().read_text() else { continue };
        let text = text.trim().to_string();
        if text.is_empty() || text.len() > MAX_TEXT_BYTES {
            continue;
        }
        if last_seen.as_deref() == Some(text.as_str()) {
            continue;
        }
        last_seen = Some(text.clone());

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
            prune(&mut clips);
            clips.clone()
        };

        save(&app, &snapshot);
        let _ = app.emit(EV_CLIP_ADDED, ());
    }
}

/// Drop the oldest unpinned clips beyond MAX_CLIPS. Pinned clips never expire.
fn prune(clips: &mut Vec<Clip>) {
    let mut unpinned = clips.iter().filter(|c| !c.pinned).count();
    if clips.len() <= MAX_CLIPS {
        return;
    }
    let mut i = clips.len();
    while i > 0 && clips.len() > MAX_CLIPS && unpinned > 0 {
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
        let mut clips: Vec<Clip> = (0..MAX_CLIPS as u64 + 5)
            .map(|i| clip(i, i == 10, 10_000 - i as i64)) // newest first; #10 pinned
            .collect();
        prune(&mut clips);
        assert_eq!(clips.len(), MAX_CLIPS);
        assert!(clips.iter().any(|c| c.id == 10), "pinned clip must survive");
        assert!(clips.iter().any(|c| c.id == 0), "newest clip must survive");
    }

    #[test]
    fn clip_serializes_camel_case() {
        let text = serde_json::to_string(&clip(1, false, 42)).unwrap();
        assert!(text.contains("createdAt"));
    }
}
