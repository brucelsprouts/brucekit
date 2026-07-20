//! dcheck module — network dropout monitor, ported from
//! github.com/brucelsprouts/dcheck.
//!
//! While the module is enabled a background thread shells the system `ping`
//! on an interval, classifies each reply (ok / high latency / drop), keeps
//! history in memory, and appends it to `ping_log.jsonl` in the app data dir.
//! Settings live in the shared config store under `tools.dcheck` and are
//! re-read every cycle, so changes apply on the next ping without a restart.
//! Toggling the module off stops the thread entirely.

use std::{
    fs,
    io::Write,
    path::PathBuf,
    process::Command,
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

pub const MODULE_ID: &str = "dcheck";
/// Rust → launcher: a ping completed; payload is the new `PingEntry`.
pub const EV_PING: &str = "brucekit://ping";

const LOG_FILE: &str = "ping_log.jsonl";
/// Keep 7 days of history (matches the original app).
const RETAIN_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// Hard cap so a 1-second interval can't grow memory without bound.
const MAX_ENTRIES: usize = 200_000;
const PING_TIMEOUT_MS: u32 = 2000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum PingStatus {
    Ok,
    High,
    Drop,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PingEntry {
    /// Unix millis.
    pub ts: i64,
    /// Round-trip time; -1 on drop.
    pub ms: i32,
    pub status: PingStatus,
}

#[derive(Default)]
pub struct DcheckState {
    /// Oldest first (append order).
    history: Mutex<Vec<PingEntry>>,
    loaded: Mutex<bool>,
    running: Mutex<Option<Arc<AtomicBool>>>,
}

// ─── Per-tool settings (tools.dcheck in config.json) ─────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct PingConfig {
    pub target: String,
    pub interval_sec: u64,
    pub threshold_ms: i32,
}

impl Default for PingConfig {
    fn default() -> Self {
        Self { target: "8.8.8.8".into(), interval_sec: 5, threshold_ms: 100 }
    }
}

/// Pull dcheck settings out of the shared config's tools bag, tolerating any
/// missing or malformed values (pure; unit-tested).
pub fn ping_config_from_tools(tools: &serde_json::Map<String, Value>) -> PingConfig {
    let mut cfg = PingConfig::default();
    let Some(Value::Object(ns)) = tools.get(MODULE_ID) else { return cfg };

    if let Some(Value::String(target)) = ns.get("target") {
        // The target lands in a process argv (never a shell), so this cap is
        // about sanity, not injection.
        let t = target.trim();
        if !t.is_empty() && t.len() <= 253 {
            cfg.target = t.to_string();
        }
    }
    if let Some(v) = ns.get("intervalSec").and_then(Value::as_u64) {
        cfg.interval_sec = v.clamp(1, 3600);
    }
    if let Some(v) = ns.get("thresholdMs").and_then(Value::as_i64) {
        cfg.threshold_ms = v.clamp(1, 60_000) as i32;
    }
    cfg
}

fn read_ping_config<R: Runtime>(app: &AppHandle<R>) -> PingConfig {
    ping_config_from_tools(&super::config::load(app).tools)
}

// ─── Persistence ─────────────────────────────────────────────────────────────

fn log_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(LOG_FILE))
}

/// Load the jsonl log once per app run, pruning entries past the retention
/// window (rewriting the file if anything was pruned, like the original).
fn ensure_loaded<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<DcheckState>();
    let mut loaded = state.loaded.lock().unwrap();
    if *loaded {
        return;
    }
    *loaded = true;

    let Some(path) = log_path(app) else { return };
    let Ok(raw) = fs::read_to_string(&path) else { return };

    let cutoff = now_ms() - RETAIN_MS;
    let mut entries: Vec<PingEntry> = raw
        .lines()
        .filter_map(|l| serde_json::from_str::<PingEntry>(l).ok())
        .collect();
    let before = entries.len();
    entries.retain(|e| e.ts >= cutoff);
    if entries.len() > MAX_ENTRIES {
        let excess = entries.len() - MAX_ENTRIES;
        entries.drain(..excess);
    }

    if entries.len() < before {
        let pruned: String = entries
            .iter()
            .filter_map(|e| serde_json::to_string(e).ok())
            .map(|l| l + "\n")
            .collect();
        let _ = fs::write(&path, pruned);
    }
    *state.history.lock().unwrap() = entries;
}

fn append_log<R: Runtime>(app: &AppHandle<R>, entry: &PingEntry) {
    let Some(path) = log_path(app) else { return };
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let Ok(line) = serde_json::to_string(entry) else { return };
    let result = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut f| writeln!(f, "{line}"));
    if let Err(e) = result {
        eprintln!("[brucekit] dcheck: log append failed: {e}");
    }
}

// ─── Pinger ──────────────────────────────────────────────────────────────────

/// Start or stop the ping loop thread (module toggle + startup).
pub fn set_running<R: Runtime>(app: &AppHandle<R>, enabled: bool) {
    let state = app.state::<DcheckState>();
    let mut running = state.running.lock().unwrap();
    if enabled {
        if running.is_some() {
            return; // already pinging
        }
        drop(running);
        ensure_loaded(app);
        let state = app.state::<DcheckState>();
        let flag = Arc::new(AtomicBool::new(true));
        *state.running.lock().unwrap() = Some(flag.clone());
        let handle = app.clone();
        thread::spawn(move || ping_loop(handle, flag));
    } else if let Some(flag) = running.take() {
        flag.store(false, Ordering::Relaxed);
    }
}

fn ping_loop<R: Runtime>(app: AppHandle<R>, running: Arc<AtomicBool>) {
    while running.load(Ordering::Relaxed) {
        // Re-read settings every cycle so panel changes apply on the next ping.
        let cfg = read_ping_config(&app);
        let entry = ping_once(&cfg);
        record(&app, &entry);

        // Sleep in short slices so toggling the module off takes effect fast.
        let mut slept: u64 = 0;
        while slept < cfg.interval_sec * 1000 && running.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_millis(200));
            slept += 200;
        }
    }
}

fn ping_once(cfg: &PingConfig) -> PingEntry {
    let ts = now_ms();
    match run_ping(&cfg.target).as_deref().and_then(parse_ping_ms) {
        Some(ms) => PingEntry {
            ts,
            ms,
            status: if ms >= cfg.threshold_ms { PingStatus::High } else { PingStatus::Ok },
        },
        None => PingEntry { ts, ms: -1, status: PingStatus::Drop },
    }
}

#[cfg(windows)]
fn run_ping(target: &str) -> Option<String> {
    use std::os::windows::process::CommandExt;
    // Without CREATE_NO_WINDOW a GUI app spawning ping flashes a console.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = Command::new("ping")
        .args(["-n", "1", "-w", &PING_TIMEOUT_MS.to_string(), target])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    // Timeouts still print to stdout; parse regardless of exit status.
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(not(windows))]
fn run_ping(target: &str) -> Option<String> {
    let secs = (PING_TIMEOUT_MS / 1000).max(1).to_string();
    let out = Command::new("ping")
        .args(["-c", "1", "-W", &secs, target])
        .output()
        .ok()?;
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Extract the round-trip millis from ping output: `time=23ms`, `time<1ms`
/// (Windows) or `time=23.4 ms` (unix). None means the reply never came.
/// Same limitation as the original: localized ping output isn't parsed.
pub fn parse_ping_ms(out: &str) -> Option<i32> {
    let idx = out.find("time=").or_else(|| out.find("time<"))?;
    let rest = &out[idx + "time=".len()..];
    let num: String = rest
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let val: f64 = num.parse().ok()?;
    Some(val.round() as i32)
}

fn record<R: Runtime>(app: &AppHandle<R>, entry: &PingEntry) {
    let state = app.state::<DcheckState>();
    {
        let mut history = state.history.lock().unwrap();
        history.push(entry.clone());
        if history.len() > MAX_ENTRIES {
            let excess = history.len() - MAX_ENTRIES;
            history.drain(..excess);
        }
    }
    append_log(app, entry);
    let _ = app.emit(EV_PING, entry.clone());
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ─── Commands ────────────────────────────────────────────────────────────────

/// History, oldest first. `range_sec` limits to the trailing window; None/0 = all.
#[tauri::command]
pub fn dcheck_history<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, DcheckState>,
    range_sec: Option<i64>,
) -> Vec<PingEntry> {
    ensure_loaded(&app);
    let history = state.history.lock().unwrap();
    match range_sec {
        Some(s) if s > 0 => {
            let cutoff = now_ms() - s * 1000;
            history.iter().filter(|e| e.ts >= cutoff).cloned().collect()
        }
        _ => history.clone(),
    }
}

/// Wipe the in-memory history and the on-disk log.
#[tauri::command]
pub fn dcheck_clear<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, DcheckState>,
) -> Result<(), String> {
    ensure_loaded(&app);
    state.history.lock().unwrap().clear();
    if let Some(path) = log_path(&app) {
        if path.exists() {
            fs::write(&path, "").map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_windows_ping_output() {
        let out = "Pinging 8.8.8.8 with 32 bytes of data:\r\nReply from 8.8.8.8: bytes=32 time=23ms TTL=118\r\n";
        assert_eq!(parse_ping_ms(out), Some(23));
    }

    #[test]
    fn parses_sub_millisecond_reply() {
        assert_eq!(parse_ping_ms("Reply from 192.168.1.1: bytes=32 time<1ms TTL=64"), Some(1));
    }

    #[test]
    fn parses_unix_ping_output() {
        let out = "64 bytes from 8.8.8.8: icmp_seq=1 ttl=118 time=23.4 ms";
        assert_eq!(parse_ping_ms(out), Some(23));
    }

    #[test]
    fn timeout_output_yields_none() {
        assert_eq!(parse_ping_ms("Request timed out.\r\n"), None);
        assert_eq!(parse_ping_ms(""), None);
    }

    #[test]
    fn ping_config_defaults_and_overrides() {
        let mut tools = serde_json::Map::new();
        assert_eq!(ping_config_from_tools(&tools), PingConfig::default());

        tools.insert(
            MODULE_ID.into(),
            json!({ "target": "1.1.1.1", "intervalSec": 10, "thresholdMs": 150 }),
        );
        let cfg = ping_config_from_tools(&tools);
        assert_eq!(cfg.target, "1.1.1.1");
        assert_eq!(cfg.interval_sec, 10);
        assert_eq!(cfg.threshold_ms, 150);
    }

    #[test]
    fn ping_config_rejects_garbage() {
        let mut tools = serde_json::Map::new();
        tools.insert(
            MODULE_ID.into(),
            json!({ "target": "   ", "intervalSec": 0, "thresholdMs": -5 }),
        );
        let cfg = ping_config_from_tools(&tools);
        assert_eq!(cfg.target, "8.8.8.8"); // blank rejected → default
        assert_eq!(cfg.interval_sec, 1); // clamped
        assert_eq!(cfg.threshold_ms, 1); // clamped
    }

    #[test]
    fn entry_serializes_camel_case_lowercase_status() {
        let text = serde_json::to_string(&PingEntry { ts: 1, ms: 5, status: PingStatus::High })
            .unwrap();
        assert!(text.contains("\"status\":\"high\""));
        assert!(text.contains("\"ts\":1"));
    }
}
