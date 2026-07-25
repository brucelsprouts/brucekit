//! xpwaste module — pomodoro focus timer, ported from
//! github.com/brucelsprouts/xpwaste.
//!
//! The clock lives here rather than in the webview, and that is the whole
//! reason this module has a background service: a focus session is something
//! you start and then walk away from, so it has to keep counting with the
//! launcher hidden and it has to be able to announce itself when it ends.
//! A webview timer can do neither — a hidden WebView2 window is free to
//! throttle, and there is nobody to hear a toast in a window nobody is looking
//! at.
//!
//! While the module is enabled a background thread ticks the countdown,
//! accumulates the focus stopwatch (paused time excluded, exactly like the
//! original), logs completed focus segments to `focus_log.json`, and emits a
//! snapshot to the panel. Settings live in the shared config store under
//! `tools.xpwaste`. Toggling the module off — or flipping eco mode — stops the
//! thread, which stops the clock: an off module costs nothing, and a paused
//! pomodoro is a truthful state rather than one that silently drifts.

use std::{
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
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_dialog::DialogExt;

pub const MODULE_ID: &str = "xpwaste";
/// Rust → launcher: the timer state changed; payload is a `Snapshot`.
pub const EV_XPWASTE: &str = "brucekit://xpwaste";

const LOG_FILE: &str = "focus_log.json";
/// Tick cadence. Finer than the 1 s the display needs so start/pause/skip feel
/// immediate and the accumulated stopwatch stays honest across a pause.
const TICK_MS: u64 = 200;

// ─── Session phases ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Focus,
    ShortBreak,
    LongBreak,
}

impl Phase {
    /// Label for the completion alert.
    fn title(self) -> &'static str {
        match self {
            Phase::Focus => "Focus",
            Phase::ShortBreak => "Short break",
            Phase::LongBreak => "Long break",
        }
    }
}

// ─── Per-tool settings (tools.xpwaste in config.json) ────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SoundMode {
    /// Windows' own notification beep — no bundled audio, nothing to license.
    Beep,
    /// A file the user picked; falls back to the beep if it has gone missing.
    Custom,
    None,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TimerConfig {
    pub focus_min: u32,
    pub short_break_min: u32,
    pub long_break_min: u32,
    pub cycle_length: u32,
    /// Focus segments shorter than this are not written to history (xpwaste's
    /// "minimum log seconds" — it keeps a stray 4-second start out of the log).
    pub min_log_sec: u32,
    /// Whether skipping a focus session still counts toward the cycle.
    pub skip_increments_cycle: bool,
    pub sound: SoundMode,
    pub sound_file: Option<String>,
}

impl Default for TimerConfig {
    fn default() -> Self {
        Self {
            focus_min: 25,
            short_break_min: 5,
            long_break_min: 15,
            cycle_length: 4,
            min_log_sec: 60,
            skip_increments_cycle: false,
            sound: SoundMode::Beep,
            sound_file: None,
        }
    }
}

/// Pull xpwaste settings out of the shared config's tools bag, tolerating any
/// missing or malformed values (pure; unit-tested).
pub fn timer_config_from_tools(tools: &serde_json::Map<String, Value>) -> TimerConfig {
    let mut cfg = TimerConfig::default();
    let Some(Value::Object(ns)) = tools.get(MODULE_ID) else { return cfg };

    let minutes = |key: &str, fallback: u32| -> u32 {
        ns.get(key)
            .and_then(Value::as_u64)
            .map(|v| v.clamp(1, 240) as u32)
            .unwrap_or(fallback)
    };
    cfg.focus_min = minutes("focusMin", cfg.focus_min);
    cfg.short_break_min = minutes("shortBreakMin", cfg.short_break_min);
    cfg.long_break_min = minutes("longBreakMin", cfg.long_break_min);

    if let Some(v) = ns.get("cycleLength").and_then(Value::as_u64) {
        cfg.cycle_length = v.clamp(1, 12) as u32;
    }
    if let Some(v) = ns.get("minLogSec").and_then(Value::as_u64) {
        cfg.min_log_sec = v.clamp(0, 3600) as u32;
    }
    if let Some(Value::Bool(v)) = ns.get("skipIncrementsCycle") {
        cfg.skip_increments_cycle = *v;
    }
    if let Some(Value::String(mode)) = ns.get("sound") {
        cfg.sound = match mode.as_str() {
            "custom" => SoundMode::Custom,
            "none" => SoundMode::None,
            _ => SoundMode::Beep,
        };
    }
    if let Some(Value::String(path)) = ns.get("soundFile") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            cfg.sound_file = Some(trimmed.to_string());
        }
    }
    cfg
}

fn read_config<R: Runtime>(app: &AppHandle<R>) -> TimerConfig {
    timer_config_from_tools(&super::config::load(app).tools)
}

/// Length of a phase in milliseconds (pure; unit-tested).
pub fn phase_total_ms(cfg: &TimerConfig, phase: Phase) -> i64 {
    let min = match phase {
        Phase::Focus => cfg.focus_min,
        Phase::ShortBreak => cfg.short_break_min,
        Phase::LongBreak => cfg.long_break_min,
    };
    min as i64 * 60_000
}

/// What follows the phase that just ended, and the cycle count that goes with
/// it (pure; unit-tested).
///
/// `completed_focus` says whether the finished focus session counts toward the
/// cycle — natural completion always does, a skip only does when the user has
/// asked for it. A long break both ends the cycle and resets the count, so the
/// pips start over rather than counting past the goal.
pub fn advance_phase(
    phase: Phase,
    cycles: u32,
    cycle_length: u32,
    completed_focus: bool,
) -> (Phase, u32) {
    match phase {
        Phase::Focus => {
            let cycles = if completed_focus { cycles + 1 } else { cycles };
            if cycles > 0 && cycles % cycle_length.max(1) == 0 {
                (Phase::LongBreak, 0)
            } else {
                (Phase::ShortBreak, cycles)
            }
        }
        Phase::ShortBreak | Phase::LongBreak => (Phase::Focus, cycles),
    }
}

// ─── Timer state ─────────────────────────────────────────────────────────────

/// One logged stretch of focus. Only *active* time is recorded — a session you
/// paused for lunch logs the minutes you were actually working.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FocusEntry {
    pub id: i64,
    /// Unix millis.
    pub start_ts: i64,
    pub end_ts: i64,
    pub seconds: i64,
}

/// The timer as the panel sees it. Everything the UI renders is here, so the
/// webview holds no clock of its own to drift out of step.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub phase: Phase,
    pub remaining_sec: i64,
    pub total_sec: i64,
    pub running: bool,
    /// Focus sessions banked toward the current cycle.
    pub cycles_completed: u32,
    pub cycle_length: u32,
    /// Active seconds accumulated in the focus session on screen.
    pub active_sec: i64,
    /// Whether the service thread is ticking. False means the module is off or
    /// eco mode is on, and the panel says so rather than showing a dead clock.
    pub ticking: bool,
}

#[derive(Debug)]
struct Timer {
    phase: Phase,
    remaining_ms: i64,
    total_ms: i64,
    running: bool,
    cycles: u32,
    cycle_length: u32,
    /// Focus stopwatch: active milliseconds in the current focus session.
    active_ms: i64,
    /// How much of `active_ms` has already been written to history.
    logged_ms: i64,
}

impl Default for Timer {
    fn default() -> Self {
        let cfg = TimerConfig::default();
        Self {
            phase: Phase::Focus,
            remaining_ms: phase_total_ms(&cfg, Phase::Focus),
            total_ms: phase_total_ms(&cfg, Phase::Focus),
            running: false,
            cycles: 0,
            cycle_length: cfg.cycle_length,
            active_ms: 0,
            logged_ms: 0,
        }
    }
}

impl Timer {
    fn snapshot(&self, ticking: bool) -> Snapshot {
        Snapshot {
            phase: self.phase,
            // Round up, so a timer with 400 ms left still reads "1" instead of
            // sitting on 00:00 for half a second before the phase turns over.
            remaining_sec: (self.remaining_ms + 999).div_euclid(1000).max(0),
            total_sec: self.total_ms / 1000,
            running: self.running,
            cycles_completed: self.cycles,
            cycle_length: self.cycle_length,
            active_sec: self.active_ms / 1000,
            ticking,
        }
    }

    /// Point the timer at a phase and refill its clock.
    fn load_phase(&mut self, cfg: &TimerConfig, phase: Phase) {
        self.phase = phase;
        self.total_ms = phase_total_ms(cfg, phase);
        self.remaining_ms = self.total_ms;
        self.cycle_length = cfg.cycle_length;
        self.active_ms = 0;
        self.logged_ms = 0;
        self.running = false;
    }

    /// Focus milliseconds accumulated but not yet written to history.
    fn unlogged_ms(&self) -> i64 {
        (self.active_ms - self.logged_ms).max(0)
    }
}

/// Advance the clock by a measured slice, reporting whether the session just
/// ran out (pure; unit-tested).
///
/// Measured rather than assumed: the loop hands over the time that actually
/// elapsed since the previous tick, so a thread that got scheduled late loses
/// nothing. The focus stopwatch only moves while a focus session is running,
/// which is what makes paused time free and break time uncounted.
fn tick_clock(timer: &mut Timer, elapsed_ms: i64) -> bool {
    if !timer.running || elapsed_ms <= 0 {
        return false;
    }
    timer.remaining_ms -= elapsed_ms;
    if timer.phase == Phase::Focus {
        timer.active_ms += elapsed_ms;
    }
    timer.remaining_ms <= 0
}

#[derive(Default)]
pub struct XpwasteState {
    running: Mutex<Option<Arc<AtomicBool>>>,
    timer: Mutex<Timer>,
    history: Mutex<Vec<FocusEntry>>,
    loaded: Mutex<bool>,
}

// ─── History persistence ─────────────────────────────────────────────────────

fn log_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(LOG_FILE))
}

/// Load the focus log once per app run.
fn ensure_loaded<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<XpwasteState>();
    let mut loaded = state.loaded.lock().unwrap();
    if *loaded {
        return;
    }
    *loaded = true;

    let entries = log_path(app)
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str::<Vec<FocusEntry>>(&raw).ok())
        .unwrap_or_default();
    *state.history.lock().unwrap() = entries;
}

fn save_history<R: Runtime>(app: &AppHandle<R>, entries: &[FocusEntry]) {
    let Some(path) = log_path(app) else { return };
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    match serde_json::to_string(entries) {
        Ok(json) => {
            if let Err(e) = fs::write(&path, json) {
                eprintln!("[brucekit] xpwaste: history save failed: {e}");
            }
        }
        Err(e) => eprintln!("[brucekit] xpwaste: history serialize failed: {e}"),
    }
}

/// Write the focus time accumulated since the last write, if it clears
/// `min_sec`. Called on pause, on skip, and on natural completion — the
/// original logs each *segment* so a long session that you paused twice shows
/// up as the work you actually did, not one optimistic block.
fn log_focus_segment<R: Runtime>(app: &AppHandle<R>, timer: &mut Timer, min_sec: u32) {
    if timer.phase != Phase::Focus {
        return;
    }
    let unlogged = timer.unlogged_ms();
    let seconds = unlogged / 1000;
    if seconds < min_sec.max(1) as i64 {
        return;
    }

    ensure_loaded(app);
    let end_ts = now_ms();
    let state = app.state::<XpwasteState>();
    let mut history = state.history.lock().unwrap();
    let id = history.iter().map(|e| e.id).max().unwrap_or(0) + 1;
    history.push(FocusEntry { id, start_ts: end_ts - seconds * 1000, end_ts, seconds });
    save_history(app, &history);

    timer.logged_ms += seconds * 1000;
}

// ─── Completion alert ────────────────────────────────────────────────────────

/// Announce the end of a session the way xpwaste does: the Windows notification
/// beep, or a sound file of your own, or nothing. Runs off the tick thread so a
/// long custom sound never delays the next tick.
fn play_alert(cfg: &TimerConfig) {
    match cfg.sound {
        SoundMode::None => {}
        SoundMode::Beep => beep(),
        SoundMode::Custom => match cfg.sound_file.clone() {
            // A sound file can be moved or deleted long after it was picked,
            // and a silent timer is a broken timer — fall back rather than
            // swallow the alert.
            Some(path) if PathBuf::from(&path).is_file() => {
                thread::spawn(move || {
                    if !play_file(&path) {
                        beep();
                    }
                });
            }
            _ => beep(),
        },
    }
}

#[cfg(windows)]
fn beep() {
    use windows::Win32::System::Diagnostics::Debug::MessageBeep;
    use windows::Win32::UI::WindowsAndMessaging::MB_OK;
    unsafe {
        let _ = MessageBeep(MB_OK);
    }
}

#[cfg(not(windows))]
fn beep() {}

/// Play a file through MCI — the same Windows codecs Media Player uses, so wav
/// and mp3 work out of the box with no audio crate, no bundled decoder, and no
/// second sound stack in the binary. Returns false if Windows would not open
/// or play it, which is the caller's cue to beep instead.
#[cfg(windows)]
fn play_file(path: &str) -> bool {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Media::Multimedia::mciSendStringW;

    /// MCI answers 0 for success and an error code for everything else. No
    /// reply buffer and no callback window: this plays and returns.
    fn send(command: &str) -> bool {
        let wide: Vec<u16> = command.encode_utf16().chain(std::iter::once(0)).collect();
        unsafe { mciSendStringW(PCWSTR(wide.as_ptr()), None, HWND::default()) == 0 }
    }

    // Alias-scoped so repeated alerts can't leak a device; a stale alias from a
    // previous play is closed first and the failure ignored.
    const ALIAS: &str = "brucekitXpwasteAlert";
    let _ = send(&format!("close {ALIAS}"));
    if !send(&format!("open \"{path}\" alias {ALIAS}")) {
        return false;
    }
    let played = send(&format!("play {ALIAS} wait"));
    let _ = send(&format!("close {ALIAS}"));
    played
}

#[cfg(not(windows))]
fn play_file(_path: &str) -> bool {
    false
}

// ─── Service ─────────────────────────────────────────────────────────────────

/// Start or stop the tick thread (module toggle / eco mode / startup).
pub fn set_running<R: Runtime>(app: &AppHandle<R>, enabled: bool) {
    let state = app.state::<XpwasteState>();
    let mut running = state.running.lock().unwrap();
    if enabled {
        if running.is_some() {
            return; // already ticking
        }
        let flag = Arc::new(AtomicBool::new(true));
        *running = Some(flag.clone());
        drop(running);
        ensure_loaded(app);
        // A freshly started service adopts the configured durations, so
        // changing focus length with the module off isn't silently ignored.
        sync_idle_durations(app);
        let handle = app.clone();
        thread::spawn(move || tick_loop(handle, flag));
    } else if let Some(flag) = running.take() {
        flag.store(false, Ordering::Relaxed);
        drop(running);
        // Stopping the clock banks the focus time already earned rather than
        // discarding it, and leaves the timer paused rather than "running" with
        // nothing to run it.
        let cfg = read_config(app);
        let state = app.state::<XpwasteState>();
        let mut timer = state.timer.lock().unwrap();
        if timer.running {
            timer.running = false;
            log_focus_segment(app, &mut timer, cfg.min_log_sec);
        }
        let snapshot = timer.snapshot(false);
        drop(timer);
        emit(app, snapshot);
    }
}

fn is_ticking<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.state::<XpwasteState>().running.lock().unwrap().is_some()
}

/// Re-point an idle, untouched timer at the configured duration. Only applies
/// to a full, stopped clock: a session you are part-way through is yours, and
/// resizing it underneath you would lose your place.
fn sync_idle_durations<R: Runtime>(app: &AppHandle<R>) {
    let cfg = read_config(app);
    let state = app.state::<XpwasteState>();
    let mut timer = state.timer.lock().unwrap();
    timer.cycle_length = cfg.cycle_length;
    if !timer.running && timer.remaining_ms == timer.total_ms {
        let total = phase_total_ms(&cfg, timer.phase);
        timer.total_ms = total;
        timer.remaining_ms = total;
    }
}

fn tick_loop<R: Runtime>(app: AppHandle<R>, running: Arc<AtomicBool>) {
    let mut last = Instant::now();
    // Only emit when the second on the display actually changes — a snapshot
    // five times a second would be five times the IPC for the same frame.
    let mut last_emitted: Option<Snapshot> = None;

    while running.load(Ordering::Relaxed) {
        let elapsed_ms = last.elapsed().as_millis() as i64;
        last = Instant::now();

        let cfg = read_config(&app);
        let state = app.state::<XpwasteState>();
        let mut timer = state.timer.lock().unwrap();
        timer.cycle_length = cfg.cycle_length;

        let mut ended: Option<(Phase, Phase)> = None;
        if tick_clock(&mut timer, elapsed_ms) {
            let from = timer.phase;
            // Natural completion always logs, however short the segment —
            // finishing a focus session is exactly the thing worth recording,
            // and the minimum only exists to filter false starts.
            log_focus_segment(&app, &mut timer, 1);
            let (next, cycles) = advance_phase(timer.phase, timer.cycles, cfg.cycle_length, true);
            timer.cycles = cycles;
            timer.load_phase(&cfg, next);
            ended = Some((from, next));
        }

        let snapshot = timer.snapshot(true);
        drop(timer);

        if let Some((from, next)) = ended {
            play_alert(&cfg);
            // The next session waits for a deliberate start, like the original:
            // a break that begins while you are still typing is not a break.
            notify(&app, from, next);
        }
        if last_emitted.as_ref() != Some(&snapshot) {
            emit(&app, snapshot.clone());
            last_emitted = Some(snapshot);
        }

        thread::sleep(Duration::from_millis(TICK_MS));
    }
}

fn emit<R: Runtime>(app: &AppHandle<R>, snapshot: Snapshot) {
    let _ = app.emit(EV_XPWASTE, snapshot);
}

/// Say what just ended and what is queued, in the tray tooltip — the launcher
/// may well be hidden, and this is the one surface that is always there. The
/// message stands until the next session starts, so a beep you missed leaves
/// something behind to explain itself.
fn notify<R: Runtime>(app: &AppHandle<R>, from: Phase, next: Phase) {
    crate::tray::set_tooltip(
        app,
        Some(&format!(
            "brucekit — {} done, {} next",
            from.title().to_lowercase(),
            next.title().to_lowercase()
        )),
    );
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ─── Commands ────────────────────────────────────────────────────────────────

/// Run `f` against the timer, then emit and return the resulting snapshot —
/// every control does this, so none of them can forget to tell the panel.
fn mutate<R: Runtime, F>(app: &AppHandle<R>, f: F) -> Snapshot
where
    F: FnOnce(&AppHandle<R>, &mut Timer, &TimerConfig),
{
    ensure_loaded(app);
    let cfg = read_config(app);
    let state = app.state::<XpwasteState>();
    let mut timer = state.timer.lock().unwrap();
    timer.cycle_length = cfg.cycle_length;
    f(app, &mut timer, &cfg);
    let snapshot = timer.snapshot(is_ticking(app));
    drop(timer);
    emit(app, snapshot.clone());
    snapshot
}

#[tauri::command]
pub fn xpwaste_state(state: State<'_, XpwasteState>) -> Snapshot {
    let ticking = state.running.lock().unwrap().is_some();
    state.timer.lock().unwrap().snapshot(ticking)
}

/// Start or resume. Deliberately a no-op while the service is stopped: with no
/// thread to tick it, a "running" timer would just be a lie on screen.
#[tauri::command]
pub fn xpwaste_start<R: Runtime>(app: AppHandle<R>) -> Snapshot {
    let ticking = is_ticking(&app);
    // Starting is the acknowledgement of the last alert, so the tooltip goes
    // back to plain "brucekit" rather than reporting a session two ago.
    crate::tray::set_tooltip(&app, None);
    mutate(&app, |_, timer, _| {
        if ticking {
            timer.running = true;
        }
    })
}

#[tauri::command]
pub fn xpwaste_pause<R: Runtime>(app: AppHandle<R>) -> Snapshot {
    mutate(&app, |app, timer, cfg| {
        if timer.running {
            timer.running = false;
            // Bank the segment now so the history updates as you pause, rather
            // than hoarding it until the session ends.
            log_focus_segment(app, timer, cfg.min_log_sec);
        }
    })
}

/// End this session early and move to the next one. Whether the skipped focus
/// counts toward the cycle is a setting, because both readings are defensible.
#[tauri::command]
pub fn xpwaste_skip<R: Runtime>(app: AppHandle<R>) -> Snapshot {
    mutate(&app, |app, timer, cfg| {
        let counts = cfg.skip_increments_cycle && timer.phase == Phase::Focus;
        log_focus_segment(app, timer, cfg.min_log_sec);
        let (next, cycles) = advance_phase(timer.phase, timer.cycles, cfg.cycle_length, counts);
        timer.cycles = cycles;
        timer.load_phase(cfg, next);
    })
}

/// Back to the start of this phase, cycle count cleared.
#[tauri::command]
pub fn xpwaste_reset<R: Runtime>(app: AppHandle<R>) -> Snapshot {
    mutate(&app, |app, timer, cfg| {
        log_focus_segment(app, timer, cfg.min_log_sec);
        timer.cycles = 0;
        let phase = timer.phase;
        timer.load_phase(cfg, phase);
    })
}

/// Jump straight to a phase (the three session buttons). Jumping to a long
/// break ends the cycle, matching the original.
#[tauri::command]
pub fn xpwaste_set_phase<R: Runtime>(app: AppHandle<R>, phase: Phase) -> Snapshot {
    mutate(&app, |app, timer, cfg| {
        log_focus_segment(app, timer, cfg.min_log_sec);
        if phase == Phase::LongBreak {
            timer.cycles = 0;
        }
        timer.load_phase(cfg, phase);
    })
}

/// Nudge the cycle counter by hand (the − / + controls), for when real life
/// happened and the count no longer matches what you did.
#[tauri::command]
pub fn xpwaste_bump_cycle<R: Runtime>(app: AppHandle<R>, delta: i32) -> Snapshot {
    mutate(&app, |_, timer, cfg| {
        let next = timer.cycles as i32 + delta;
        timer.cycles = next.clamp(0, cfg.cycle_length as i32) as u32;
    })
}

/// Adopt freshly saved durations. Applies to the current phase too — the panel
/// only calls this when you press Apply, which is a deliberate "make it this
/// long now".
#[tauri::command]
pub fn xpwaste_apply_settings<R: Runtime>(app: AppHandle<R>) -> Snapshot {
    mutate(&app, |app, timer, cfg| {
        log_focus_segment(app, timer, cfg.min_log_sec);
        let phase = timer.phase;
        timer.load_phase(cfg, phase);
    })
}

/// The focus log, oldest first.
#[tauri::command]
pub fn xpwaste_history<R: Runtime>(app: AppHandle<R>, state: State<'_, XpwasteState>) -> Vec<FocusEntry> {
    ensure_loaded(&app);
    state.history.lock().unwrap().clone()
}

#[tauri::command]
pub fn xpwaste_delete_entry<R: Runtime>(app: AppHandle<R>, id: i64) {
    ensure_loaded(&app);
    let state = app.state::<XpwasteState>();
    let mut history = state.history.lock().unwrap();
    history.retain(|e| e.id != id);
    save_history(&app, &history);
}

#[tauri::command]
pub fn xpwaste_clear_history<R: Runtime>(app: AppHandle<R>) {
    ensure_loaded(&app);
    let state = app.state::<XpwasteState>();
    let mut history = state.history.lock().unwrap();
    history.clear();
    save_history(&app, &history);
}

/// Pick a sound file for the completion alert. Returns null when the dialog is
/// dismissed; the caller persists the path itself.
#[tauri::command]
pub async fn xpwaste_pick_sound<R: Runtime>(app: AppHandle<R>) -> Option<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .set_title("Select an alert sound")
        .add_filter("Audio", &["wav", "mp3", "wma", "mid"])
        .pick_file(move |file| {
            let _ = tx.send(file.map(|f| f.to_string()));
        });
    rx.recv().ok().flatten()
}

/// Play the configured alert once, so "is this the sound I meant?" is one
/// click rather than a 25-minute wait.
#[tauri::command]
pub fn xpwaste_test_sound<R: Runtime>(app: AppHandle<R>) {
    play_alert(&read_config(&app));
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn config_defaults_and_clamps() {
        let mut tools = serde_json::Map::new();
        assert_eq!(timer_config_from_tools(&tools), TimerConfig::default());

        tools.insert(
            MODULE_ID.into(),
            json!({
                "focusMin": 50,
                "shortBreakMin": 0,
                "longBreakMin": 999,
                "cycleLength": 99,
                "minLogSec": 10,
                "skipIncrementsCycle": true,
                "sound": "custom",
                "soundFile": "  C:\\a.mp3  ",
            }),
        );
        let cfg = timer_config_from_tools(&tools);
        assert_eq!(cfg.focus_min, 50);
        assert_eq!(cfg.short_break_min, 1, "0 minutes is not a session");
        assert_eq!(cfg.long_break_min, 240);
        assert_eq!(cfg.cycle_length, 12);
        assert_eq!(cfg.min_log_sec, 10);
        assert!(cfg.skip_increments_cycle);
        assert_eq!(cfg.sound, SoundMode::Custom);
        assert_eq!(cfg.sound_file.as_deref(), Some("C:\\a.mp3"));
    }

    #[test]
    fn malformed_values_fall_back_instead_of_breaking_the_timer() {
        let mut tools = serde_json::Map::new();
        tools.insert(
            MODULE_ID.into(),
            json!({ "focusMin": "soon", "cycleLength": null, "sound": "kazoo", "soundFile": "  " }),
        );
        let cfg = timer_config_from_tools(&tools);
        assert_eq!(cfg.focus_min, 25);
        assert_eq!(cfg.cycle_length, 4);
        assert_eq!(cfg.sound, SoundMode::Beep, "an unknown mode is still audible");
        assert_eq!(cfg.sound_file, None);
    }

    #[test]
    fn focus_runs_into_short_breaks_until_the_cycle_closes() {
        let mut phase = Phase::Focus;
        let mut cycles = 0;
        for expected in 1..4 {
            let (next, c) = advance_phase(phase, cycles, 4, true);
            assert_eq!(next, Phase::ShortBreak);
            assert_eq!(c, expected);
            cycles = c;
            let (back, c) = advance_phase(next, cycles, 4, true);
            assert_eq!(back, Phase::Focus);
            cycles = c;
            phase = back;
        }
        // Fourth focus of a 4-long cycle earns the long break and starts over.
        let (next, cycles) = advance_phase(phase, cycles, 4, true);
        assert_eq!(next, Phase::LongBreak);
        assert_eq!(cycles, 0);
    }

    #[test]
    fn a_skip_that_does_not_count_leaves_the_cycle_alone() {
        let (next, cycles) = advance_phase(Phase::Focus, 2, 4, false);
        assert_eq!(next, Phase::ShortBreak);
        assert_eq!(cycles, 2);
    }

    #[test]
    fn breaks_always_hand_back_to_focus() {
        assert_eq!(advance_phase(Phase::ShortBreak, 2, 4, true), (Phase::Focus, 2));
        assert_eq!(advance_phase(Phase::LongBreak, 0, 4, true), (Phase::Focus, 0));
    }

    #[test]
    fn a_cycle_length_of_one_long_breaks_every_session() {
        let (next, cycles) = advance_phase(Phase::Focus, 0, 1, true);
        assert_eq!(next, Phase::LongBreak);
        assert_eq!(cycles, 0);
    }

    #[test]
    fn phase_lengths_come_from_config() {
        let cfg = TimerConfig { focus_min: 30, short_break_min: 6, long_break_min: 20, ..Default::default() };
        assert_eq!(phase_total_ms(&cfg, Phase::Focus), 1_800_000);
        assert_eq!(phase_total_ms(&cfg, Phase::ShortBreak), 360_000);
        assert_eq!(phase_total_ms(&cfg, Phase::LongBreak), 1_200_000);
    }

    #[test]
    fn snapshot_rounds_the_last_partial_second_up() {
        let mut timer = Timer::default();
        timer.remaining_ms = 400;
        assert_eq!(timer.snapshot(true).remaining_sec, 1);
        timer.remaining_ms = 0;
        assert_eq!(timer.snapshot(true).remaining_sec, 0);
        timer.remaining_ms = -300;
        assert_eq!(timer.snapshot(true).remaining_sec, 0, "an overrun never reads negative");
    }

    #[test]
    fn loading_a_phase_clears_the_focus_stopwatch() {
        let cfg = TimerConfig::default();
        let mut timer = Timer::default();
        timer.active_ms = 90_000;
        timer.logged_ms = 60_000;
        timer.running = true;
        timer.load_phase(&cfg, Phase::ShortBreak);
        assert_eq!(timer.active_ms, 0);
        assert_eq!(timer.logged_ms, 0);
        assert!(!timer.running, "the next session waits for a deliberate start");
        assert_eq!(timer.remaining_ms, 300_000);
    }

    #[test]
    fn only_unlogged_focus_time_is_owed_to_history() {
        let mut timer = Timer::default();
        timer.active_ms = 125_000;
        timer.logged_ms = 60_000;
        assert_eq!(timer.unlogged_ms(), 65_000);
        timer.logged_ms = 200_000;
        assert_eq!(timer.unlogged_ms(), 0, "double-logging is impossible");
    }

    #[test]
    fn a_running_focus_session_spends_its_clock_and_banks_the_time() {
        let mut timer = Timer::default();
        timer.running = true;
        assert!(!tick_clock(&mut timer, 5_000));
        assert_eq!(timer.remaining_ms, 1_495_000);
        assert_eq!(timer.active_ms, 5_000, "focus time accrues as it is spent");
    }

    #[test]
    fn a_paused_timer_does_not_move() {
        let mut timer = Timer::default();
        timer.running = false;
        assert!(!tick_clock(&mut timer, 60_000));
        assert_eq!(timer.remaining_ms, 1_500_000);
        assert_eq!(timer.active_ms, 0, "paused time is not studied time");
    }

    #[test]
    fn break_time_never_reaches_the_focus_stopwatch() {
        let cfg = TimerConfig::default();
        let mut timer = Timer::default();
        timer.load_phase(&cfg, Phase::ShortBreak);
        timer.running = true;
        assert!(!tick_clock(&mut timer, 30_000));
        assert_eq!(timer.remaining_ms, 270_000);
        assert_eq!(timer.active_ms, 0);
    }

    #[test]
    fn running_out_reports_the_end_exactly_once_worth_of_time() {
        let mut timer = Timer::default();
        timer.running = true;
        timer.remaining_ms = 300;
        // A late tick overshoots; the session still ends, and every millisecond
        // that really elapsed is credited rather than truncated at zero.
        assert!(tick_clock(&mut timer, 1_000));
        assert_eq!(timer.active_ms, 1_000);
        assert!(timer.remaining_ms <= 0);
    }

    #[test]
    fn a_zero_length_tick_changes_nothing() {
        let mut timer = Timer::default();
        timer.running = true;
        assert!(!tick_clock(&mut timer, 0));
        assert_eq!(timer.remaining_ms, 1_500_000);
    }

    #[test]
    fn snapshot_serializes_camel_case() {
        let text = serde_json::to_string(&Timer::default().snapshot(false)).unwrap();
        assert!(text.contains("\"remainingSec\":1500"));
        assert!(text.contains("\"cycleLength\":4"));
        assert!(text.contains("\"phase\":\"focus\""));
    }

    #[test]
    fn focus_entry_serializes_camel_case() {
        let entry = FocusEntry { id: 1, start_ts: 10, end_ts: 20, seconds: 5 };
        let text = serde_json::to_string(&entry).unwrap();
        assert!(text.contains("\"startTs\":10"));
        assert!(text.contains("\"endTs\":20"));
    }
}
