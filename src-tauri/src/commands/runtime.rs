//! runtime module — how long things have been running (docs/module-ideas.md).
//!
//! Formerly `pulse`, which led with machine vitals. The question the module
//! actually answers is "what have I had running, and for how long?", so app
//! time is the whole subject now and the vitals sampling is gone: CPU, memory,
//! disk, battery and network readings that nothing renders are pure waste, and
//! re-enumerating disks every couple of seconds is not free. Machine uptime
//! survives as a single on-demand read.
//!
//! While the module is enabled a background thread notes the foreground app on
//! an interval (default 2 s), accumulating per-app time; the current session
//! persists to `app_usage.json`, and the previous session is kept so
//! yesterday's totals survive a restart. Toggling the module off (or flipping
//! eco mode) stops the thread entirely.

use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sysinfo::System;
use tauri::{AppHandle, Manager, Runtime, State};

pub const MODULE_ID: &str = "runtime";

const USAGE_FILE: &str = "app_usage.json";
/// Persist the usage ledger roughly this often (in tracker ticks).
const SAVE_EVERY_TICKS: u32 = 15;

/// One tracked stretch of app usage: an app run of brucekit.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageSession {
    /// Unix millis.
    pub start_ts: i64,
    /// Unix millis of the last accumulation (advances while tracking).
    pub end_ts: i64,
    /// Foreground millis per app (exe name, extension stripped).
    pub apps: BTreeMap<String, u64>,
}

impl UsageSession {
    fn new(now: i64) -> Self {
        Self { start_ts: now, end_ts: now, apps: BTreeMap::new() }
    }
}

/// The persisted usage ledger: the live session plus the previous one.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppUsage {
    pub current: Option<UsageSession>,
    pub last: Option<UsageSession>,
}

/// Start a fresh tracking session, demoting any existing current session to
/// `last` (pure; unit-tested). Called once per app run.
pub fn rotate_sessions(mut usage: AppUsage, now: i64) -> AppUsage {
    if let Some(prev) = usage.current.take() {
        usage.last = Some(prev);
    }
    usage.current = Some(UsageSession::new(now));
    usage
}

/// "C:\Program Files\...\Code.exe" → "Code" (pure; unit-tested).
pub fn friendly_app_name(path: &str) -> String {
    let file = path
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(path)
        .trim();
    let lower = file.to_ascii_lowercase();
    let stem = lower
        .strip_suffix(".exe")
        .map(|_| &file[..file.len() - 4])
        .unwrap_or(file);
    stem.to_string()
}

#[derive(Default)]
pub struct RuntimeState {
    running: Mutex<Option<Arc<AtomicBool>>>,
    usage: Mutex<AppUsage>,
    /// Session rotation happens once per app run, on the first service start.
    usage_loaded: Mutex<bool>,
}

/// Sample cadence from the shared config's tools bag (`tools.runtime`),
/// tolerating missing or malformed values (pure; unit-tested).
pub fn sample_interval_from_tools(tools: &serde_json::Map<String, Value>) -> u64 {
    const DEFAULT: u64 = 2;
    let Some(Value::Object(ns)) = tools.get(MODULE_ID) else { return DEFAULT };
    ns.get("intervalSec")
        .and_then(Value::as_u64)
        .map(|v| v.clamp(1, 60))
        .unwrap_or(DEFAULT)
}

/// Name of the app owning the foreground window; None when nothing readable
/// has focus (secure desktop, lock screen) — those slices go untracked.
#[cfg(windows)]
pub fn foreground_app() -> Option<String> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return None;
        }
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let queried =
            QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len);
        let _ = CloseHandle(handle);
        queried.ok()?;
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        let name = friendly_app_name(&path);
        (!name.is_empty()).then_some(name)
    }
}

#[cfg(not(windows))]
pub fn foreground_app() -> Option<String> {
    None
}

// ─── Usage persistence ───────────────────────────────────────────────────────

fn usage_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(USAGE_FILE))
}

fn save_usage<R: Runtime>(app: &AppHandle<R>, usage: &AppUsage) {
    let Some(path) = usage_path(app) else { return };
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    match serde_json::to_string(usage) {
        Ok(json) => {
            if let Err(e) = fs::write(&path, json) {
                eprintln!("[brucekit] runtime: usage save failed: {e}");
            }
        }
        Err(e) => eprintln!("[brucekit] runtime: usage serialize failed: {e}"),
    }
}

/// First service start of this app run: load the ledger from disk and demote
/// the previous run's session to `last`. Re-enables within the same run keep
/// accumulating into the same session.
fn ensure_usage_session<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<RuntimeState>();
    let mut loaded = state.usage_loaded.lock().unwrap();
    if *loaded {
        return;
    }
    *loaded = true;

    let from_disk = usage_path(app)
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str::<AppUsage>(&raw).ok())
        .unwrap_or_default();
    let rotated = rotate_sessions(from_disk, now_ms());
    save_usage(app, &rotated);
    *state.usage.lock().unwrap() = rotated;
}

/// Attribute one elapsed tick to the app that has the foreground now.
fn track_foreground<R: Runtime>(app: &AppHandle<R>, elapsed_ms: u64) {
    let Some(name) = foreground_app() else { return };
    let state = app.state::<RuntimeState>();
    let mut usage = state.usage.lock().unwrap();
    let Some(session) = usage.current.as_mut() else { return };
    *session.apps.entry(name).or_insert(0) += elapsed_ms;
    session.end_ts = now_ms();
}

// ─── Service ─────────────────────────────────────────────────────────────────

/// Start or stop the tracking thread (module toggle / eco mode / startup).
pub fn set_running<R: Runtime>(app: &AppHandle<R>, enabled: bool) {
    let state = app.state::<RuntimeState>();
    let mut running = state.running.lock().unwrap();
    if enabled {
        if running.is_some() {
            return; // already sampling
        }
        drop(running);
        ensure_usage_session(app);
        let state = app.state::<RuntimeState>();
        let flag = Arc::new(AtomicBool::new(true));
        *state.running.lock().unwrap() = Some(flag.clone());
        let handle = app.clone();
        thread::spawn(move || track_loop(handle, flag));
    } else if let Some(flag) = running.take() {
        flag.store(false, Ordering::Relaxed);
    }
}

fn track_loop<R: Runtime>(app: AppHandle<R>, running: Arc<AtomicBool>) {
    let mut last_tick = Instant::now();
    let mut ticks: u32 = 0;
    while running.load(Ordering::Relaxed) {
        // App time: the stretch since the previous tick belongs to whoever
        // holds the foreground now. Persist the ledger every ~30 s.
        let elapsed_ms = last_tick.elapsed().as_millis() as u64;
        last_tick = Instant::now();
        track_foreground(&app, elapsed_ms);
        ticks += 1;
        if ticks % SAVE_EVERY_TICKS == 0 {
            let usage = app.state::<RuntimeState>().usage.lock().unwrap().clone();
            save_usage(&app, &usage);
        }

        // Re-read cadence every cycle; sleep in short slices so toggling the
        // module off takes effect fast (same pattern as dcheck's pinger).
        let interval_sec = sample_interval_from_tools(&super::config::load(&app).tools);
        let mut slept: u64 = 0;
        while slept < interval_sec * 1000 && running.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_millis(200));
            slept += 200;
        }
    }
    // Final flush so a toggle-off (or eco) doesn't lose the last half-minute.
    let usage = app.state::<RuntimeState>().usage.lock().unwrap().clone();
    save_usage(&app, &usage);
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ─── Commands ────────────────────────────────────────────────────────────────

/// Seconds since the machine booted. Read on demand — there is no reason to
/// sample a monotonically increasing counter in the background.
#[tauri::command]
pub fn runtime_uptime() -> u64 {
    System::uptime()
}

/// Per-app screen time: the live session plus the previous run's session.
/// If the ledger hasn't been started this run (module off since launch), the
/// last persisted state is returned so old totals are still readable.
#[tauri::command]
pub fn runtime_apps<R: Runtime>(app: AppHandle<R>, state: State<'_, RuntimeState>) -> AppUsage {
    let loaded = *state.usage_loaded.lock().unwrap();
    if !loaded {
        return usage_path(&app)
            .and_then(|p| fs::read_to_string(p).ok())
            .and_then(|raw| serde_json::from_str::<AppUsage>(&raw).ok())
            .unwrap_or_default();
    }
    state.usage.lock().unwrap().clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rotate_demotes_current_to_last_and_starts_fresh() {
        let mut first = UsageSession::new(1000);
        first.apps.insert("chrome".into(), 5000);
        let usage = AppUsage { current: Some(first.clone()), last: None };

        let rotated = rotate_sessions(usage, 9000);
        assert_eq!(rotated.last, Some(first));
        let current = rotated.current.unwrap();
        assert_eq!(current.start_ts, 9000);
        assert!(current.apps.is_empty());
    }

    #[test]
    fn rotate_from_empty_ledger_starts_a_session() {
        let rotated = rotate_sessions(AppUsage::default(), 42);
        assert!(rotated.last.is_none());
        assert_eq!(rotated.current.unwrap().start_ts, 42);
    }

    #[test]
    fn friendly_name_strips_path_and_exe() {
        assert_eq!(friendly_app_name(r"C:\Program Files\Google\chrome.exe"), "chrome");
        assert_eq!(friendly_app_name(r"C:\Apps\Code.EXE"), "Code");
        assert_eq!(friendly_app_name("/usr/bin/firefox"), "firefox");
        assert_eq!(friendly_app_name("bare"), "bare");
    }

    #[test]
    fn usage_serializes_camel_case() {
        let mut session = UsageSession::new(1);
        session.apps.insert("code".into(), 1234);
        let text = serde_json::to_string(&AppUsage { current: Some(session), last: None }).unwrap();
        assert!(text.contains("\"startTs\":1"));
        assert!(text.contains("\"endTs\":1"));
        assert!(text.contains("\"code\":1234"));
    }

    #[test]
    fn interval_defaults_and_clamps() {
        let mut tools = serde_json::Map::new();
        assert_eq!(sample_interval_from_tools(&tools), 2);
        tools.insert(MODULE_ID.into(), json!({ "intervalSec": 10 }));
        assert_eq!(sample_interval_from_tools(&tools), 10);
        tools.insert(MODULE_ID.into(), json!({ "intervalSec": 0 }));
        assert_eq!(sample_interval_from_tools(&tools), 1);
        tools.insert(MODULE_ID.into(), json!({ "intervalSec": "soon" }));
        assert_eq!(sample_interval_from_tools(&tools), 2);
    }
}
