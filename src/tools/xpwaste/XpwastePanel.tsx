import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { ToolContext } from "../types";
import { errorMessage, type FocusEntry, type Phase, type TimerSnapshot } from "../../core/ipc";
import { EV_XPWASTE } from "../../core/events";
import {
  elapsedFraction,
  formatCountdown,
  formatSpan,
  formatStudied,
  phaseLabel,
  totals,
} from "./format";

/** Session buttons, in cycle order. */
const PHASES: { id: Phase; label: string }[] = [
  { id: "focus", label: "FOCUS" },
  { id: "shortBreak", label: "SHORT" },
  { id: "longBreak", label: "LONG" },
];

const SOUNDS = [
  { id: "beep", label: "Beep" },
  { id: "custom", label: "File" },
  { id: "none", label: "Silent" },
] as const;
type SoundMode = (typeof SOUNDS)[number]["id"];

const DEFAULTS = {
  focusMin: 25,
  shortBreakMin: 5,
  longBreakMin: 15,
  cycleLength: 4,
  minLogSec: 60,
  skipIncrementsCycle: false,
  sound: "beep" as SoundMode,
  soundFile: "",
};

/**
 * xpwaste panel: the pomodoro timer from github.com/brucelsprouts/xpwaste,
 * rebuilt on brucekit's HUD vocabulary — the ring, the ranked-row list, the
 * segmented control and the hairline stat cards this app already speaks in,
 * instead of the original's themed Qt chrome.
 *
 * The panel deliberately owns no clock. Every control round-trips to Rust and
 * renders the snapshot it gets back, and the tick thread pushes one per second
 * while running, so what's on screen is the timer rather than a copy of it that
 * can drift while the launcher is hidden.
 */
export function XpwastePanel({ ctx }: { ctx: ToolContext }) {
  const [timer, setTimer] = useState<TimerSnapshot | null>(null);
  const [history, setHistory] = useState<FocusEntry[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  // Settings drafts — applied together, like the original's dialog.
  const [focusDraft, setFocusDraft] = useState(String(DEFAULTS.focusMin));
  const [shortDraft, setShortDraft] = useState(String(DEFAULTS.shortBreakMin));
  const [longDraft, setLongDraft] = useState(String(DEFAULTS.longBreakMin));
  const [cycleDraft, setCycleDraft] = useState(String(DEFAULTS.cycleLength));
  const [minLogDraft, setMinLogDraft] = useState(String(DEFAULTS.minLogSec));
  const [skipCounts, setSkipCounts] = useState(DEFAULTS.skipIncrementsCycle);
  const [sound, setSound] = useState<SoundMode>(DEFAULTS.sound);
  const [soundFile, setSoundFile] = useState(DEFAULTS.soundFile);

  const loadHistory = useCallback(async () => {
    try {
      setHistory(await ctx.invoke("xpwaste_history"));
    } catch {
      /* outside a Tauri webview (browser preview) — stays empty */
    }
  }, [ctx]);

  // Initial state + the log.
  useEffect(() => {
    let alive = true;
    ctx
      .invoke("xpwaste_state")
      .then((s) => {
        if (alive) setTimer(s);
      })
      .catch(() => {});
    void loadHistory();
    return () => {
      alive = false;
    };
  }, [ctx, loadHistory]);

  // Restore persisted settings once.
  useEffect(() => {
    let alive = true;
    Promise.all([
      ctx.settings.get<number>("focusMin", DEFAULTS.focusMin),
      ctx.settings.get<number>("shortBreakMin", DEFAULTS.shortBreakMin),
      ctx.settings.get<number>("longBreakMin", DEFAULTS.longBreakMin),
      ctx.settings.get<number>("cycleLength", DEFAULTS.cycleLength),
      ctx.settings.get<number>("minLogSec", DEFAULTS.minLogSec),
      ctx.settings.get<boolean>("skipIncrementsCycle", DEFAULTS.skipIncrementsCycle),
      ctx.settings.get<SoundMode>("sound", DEFAULTS.sound),
      ctx.settings.get<string>("soundFile", DEFAULTS.soundFile),
    ])
      .then(([focus, short, long, cycle, minLog, skip, snd, file]) => {
        if (!alive) return;
        setFocusDraft(String(focus));
        setShortDraft(String(short));
        setLongDraft(String(long));
        setCycleDraft(String(cycle));
        setMinLogDraft(String(minLog));
        setSkipCounts(skip);
        setSound(snd);
        setSoundFile(file);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [ctx]);

  // The tick thread pushes a snapshot whenever the display second changes; a
  // completed session also lands here, so the log refreshes without polling.
  useEffect(() => {
    let dispose = () => {};
    listen<TimerSnapshot>(EV_XPWASTE, (event) => {
      setTimer((prev) => {
        if (prev && prev.phase !== event.payload.phase) void loadHistory();
        return event.payload;
      });
    })
      .then((un) => {
        dispose = un;
      })
      .catch(() => {});
    return () => dispose();
  }, [loadHistory]);

  /** Run a timer command and adopt the snapshot it returns. */
  const control = useCallback(
    async (
      cmd:
        | "xpwaste_start"
        | "xpwaste_pause"
        | "xpwaste_skip"
        | "xpwaste_reset"
        | "xpwaste_apply_settings",
    ) => {
      try {
        setTimer(await ctx.invoke(cmd));
        await loadHistory();
      } catch (err) {
        ctx.toast(errorMessage(err), { kind: "error" });
      }
    },
    [ctx, loadHistory],
  );

  async function setPhase(phase: Phase) {
    try {
      setTimer(await ctx.invoke("xpwaste_set_phase", { phase }));
      await loadHistory();
    } catch (err) {
      ctx.toast(errorMessage(err), { kind: "error" });
    }
  }

  async function bumpCycle(delta: number) {
    try {
      setTimer(await ctx.invoke("xpwaste_bump_cycle", { delta }));
    } catch (err) {
      ctx.toast(errorMessage(err), { kind: "error" });
    }
  }

  async function applySettings() {
    const focusMin = clampInt(focusDraft, 1, 240, DEFAULTS.focusMin);
    const shortBreakMin = clampInt(shortDraft, 1, 240, DEFAULTS.shortBreakMin);
    const longBreakMin = clampInt(longDraft, 1, 240, DEFAULTS.longBreakMin);
    const cycleLength = clampInt(cycleDraft, 1, 12, DEFAULTS.cycleLength);
    const minLogSec = clampInt(minLogDraft, 0, 3600, DEFAULTS.minLogSec);
    setFocusDraft(String(focusMin));
    setShortDraft(String(shortBreakMin));
    setLongDraft(String(longBreakMin));
    setCycleDraft(String(cycleLength));
    setMinLogDraft(String(minLogSec));

    try {
      await ctx.settings.set("focusMin", focusMin);
      await ctx.settings.set("shortBreakMin", shortBreakMin);
      await ctx.settings.set("longBreakMin", longBreakMin);
      await ctx.settings.set("cycleLength", cycleLength);
      await ctx.settings.set("minLogSec", minLogSec);
      await ctx.settings.set("skipIncrementsCycle", skipCounts);
      await ctx.settings.set("sound", sound);
      await ctx.settings.set("soundFile", soundFile);
      // Resizing the session on screen is the point of pressing Apply.
      await control("xpwaste_apply_settings");
      ctx.toast("Timer settings applied", { kind: "success" });
    } catch (err) {
      ctx.toast(errorMessage(err), { kind: "error" });
    }
  }

  async function pickSound() {
    try {
      const path = await ctx.invoke("xpwaste_pick_sound");
      if (!path) return;
      setSoundFile(path);
      setSound("custom");
      await ctx.settings.set("soundFile", path);
      await ctx.settings.set("sound", "custom");
    } catch (err) {
      ctx.toast(errorMessage(err), { kind: "error" });
    }
  }

  async function deleteEntry(id: number) {
    try {
      await ctx.invoke("xpwaste_delete_entry", { id });
      await loadHistory();
    } catch (err) {
      ctx.toast(errorMessage(err), { kind: "error" });
    }
  }

  async function clearHistory() {
    setConfirmClear(false);
    try {
      await ctx.invoke("xpwaste_clear_history");
      await loadHistory();
      ctx.toast("Focus log cleared", { kind: "success" });
    } catch (err) {
      ctx.toast(errorMessage(err), { kind: "error" });
    }
  }

  const stats = totals(history);
  // The cycle reads as the session you are *on* during focus, and as the count
  // banked during a break — the same reading the original shows.
  const cycleNow = timer
    ? Math.max(
        0,
        Math.min(
          timer.phase === "focus" ? timer.cyclesCompleted + 1 : timer.cyclesCompleted,
          timer.cycleLength,
        ),
      )
    : 0;
  const newestFirst = [...history].reverse();

  return (
    <div className="bk-xpw">
      <div className="bk-xpw__hero">
        <div className="bk-seg bk-xpw__phases" role="group" aria-label="Session type">
          {PHASES.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`bk-seg__btn ${timer?.phase === p.id ? "is-active" : ""}`}
              aria-pressed={timer?.phase === p.id}
              onClick={() => void setPhase(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="bk-xpw__clock">
          <Ring
            fraction={elapsedFraction(timer?.remainingSec ?? 0, timer?.totalSec ?? 0)}
            phase={timer?.phase ?? "focus"}
            running={timer?.running ?? false}
          />
          <div className="bk-xpw__face">
            {/* Six figures (100 minutes and up) need the smaller step to stay
                clear of the arc. */}
            <strong
              className={`bk-xpw__time ${(timer?.remainingSec ?? 0) >= 6000 ? "is-long" : ""}`}
            >
              {formatCountdown(timer?.remainingSec ?? 0)}
            </strong>
            <span className="bk-label">{phaseLabel(timer?.phase ?? "focus").toUpperCase()}</span>
          </div>
        </div>

        <div className="bk-xpw__cycle">
          <button
            type="button"
            className="bk-btn bk-btn--sm"
            onClick={() => void bumpCycle(-1)}
            aria-label="One fewer completed session"
          >
            −
          </button>
          <span
            className="bk-xpw__pips"
            aria-label={`Cycle ${cycleNow} of ${timer?.cycleLength ?? 0}`}
          >
            {Array.from({ length: timer?.cycleLength ?? 0 }, (_, i) => (
              <span key={i} className={`bk-xpw__pip ${i < cycleNow ? "is-done" : ""}`} />
            ))}
          </span>
          <span className="bk-label">
            CYCLE {cycleNow} / {timer?.cycleLength ?? 0}
          </span>
          <button
            type="button"
            className="bk-btn bk-btn--sm"
            onClick={() => void bumpCycle(1)}
            aria-label="One more completed session"
          >
            +
          </button>
        </div>

        <div className="bk-xpw__controls">
          <button
            type="button"
            className="bk-action bk-action--inline"
            disabled={!timer?.ticking}
            onClick={() => void control(timer?.running ? "xpwaste_pause" : "xpwaste_start")}
          >
            {timer?.running ? "Pause" : "Start"}
          </button>
          <button type="button" className="bk-btn" onClick={() => void control("xpwaste_skip")}>
            Skip
          </button>
          <button type="button" className="bk-btn" onClick={() => void control("xpwaste_reset")}>
            Reset
          </button>
          <button
            type="button"
            className={`bk-btn ${showSettings ? "is-active" : ""}`}
            aria-pressed={showSettings}
            onClick={() => setShowSettings((v) => !v)}
          >
            Settings
          </button>
        </div>
      </div>

      {timer && !timer.ticking && (
        <span className="bk-label bk-label--danger">
          CLOCK STOPPED — THE TIMER RUNS WHILE THE MODULE IS ON AND ECO MODE IS OFF
        </span>
      )}

      <div className="bk-xpw__stats">
        <Stat label="TODAY" value={formatStudied(stats.todaySec)} />
        <Stat label="SESSIONS" value={String(stats.todaySessions)} />
        <Stat label="ALL TIME" value={formatStudied(stats.allTimeSec)} />
      </div>

      <div className={`bk-xpw__logwrap ${newestFirst.length === 0 ? "is-empty" : ""}`}>
        <div className="bk-xpw__loghead">
          <span className="bk-label">FOCUS LOG</span>
          {history.length > 0 && <span className="bk-label">{history.length}</span>}
          {confirmClear ? (
            <>
              <span className="bk-label bk-label--danger">WIPE THE LOG?</span>
              <button
                type="button"
                className="bk-btn bk-btn--sm"
                onClick={() => void clearHistory()}
              >
                Clear
              </button>
              <button
                type="button"
                className="bk-btn bk-btn--sm"
                onClick={() => setConfirmClear(false)}
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              className="bk-btn bk-btn--sm"
              onClick={() => setConfirmClear(true)}
              disabled={history.length === 0}
            >
              Clear
            </button>
          )}
        </div>

        {newestFirst.length === 0 ? (
          <div className="bk-xpw__empty">
            <span className="bk-label">NOTHING LOGGED YET</span>
            <em>Focus time lands here when a session completes or pauses.</em>
          </div>
        ) : (
          // The list scrolls inside the space it was given, so the log grows
          // with the window instead of needing a "show more" of its own.
          <div className="bk-xpw__logscroll">
            <ol className="bk-xpw__log">
              {newestFirst.map((entry) => (
                <li key={entry.id} className="bk-xpw__logrow">
                  <span className="bk-xpw__logday">
                    {new Date(entry.startTs).toLocaleDateString()}
                  </span>
                  <span className="bk-xpw__logspan">{formatSpan(entry)}</span>
                  <span className="bk-xpw__logtime">{formatStudied(entry.seconds)}</span>
                  <button
                    type="button"
                    className="bk-xpw__logdel"
                    title="Remove this entry"
                    aria-label="Remove this entry"
                    onClick={() => void deleteEntry(entry.id)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>

      {showSettings && (
        <div className="bk-xpw__settings">
          <div className="bk-xpw__form">
            <Field label="FOCUS (M)" value={focusDraft} onChange={setFocusDraft} max={240} />
            <Field label="SHORT (M)" value={shortDraft} onChange={setShortDraft} max={240} />
            <Field label="LONG (M)" value={longDraft} onChange={setLongDraft} max={240} />
            <Field label="CYCLE" value={cycleDraft} onChange={setCycleDraft} max={12} />
            <Field label="MIN LOG (S)" value={minLogDraft} onChange={setMinLogDraft} max={3600} min={0} />
            <button type="button" className="bk-btn" onClick={() => void applySettings()}>
              Apply
            </button>
          </div>

          <div className="bk-xpw__form">
            <span className="bk-label">ALERT</span>
            <div className="bk-seg" role="group" aria-label="Alert sound">
              {SOUNDS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={`bk-seg__btn ${sound === s.id ? "is-active" : ""}`}
                  aria-pressed={sound === s.id}
                  onClick={() => setSound(s.id)}
                >
                  {s.label.toUpperCase()}
                </button>
              ))}
            </div>
            <button type="button" className="bk-btn bk-btn--sm" onClick={() => void pickSound()}>
              Browse…
            </button>
            <button
              type="button"
              className="bk-btn bk-btn--sm"
              onClick={() => void ctx.invoke("xpwaste_test_sound").catch(() => {})}
            >
              Test
            </button>
          </div>

          <p className="bk-xpw__note">
            {sound === "custom"
              ? soundFile
                ? `Plays ${fileName(soundFile)} — falls back to the beep if it goes missing.`
                : "No file picked yet — the beep stands in until you choose one."
              : sound === "beep"
                ? "Windows' own notification chime. Nothing bundled, nothing to license."
                : "Sessions turn over silently."}
          </p>
          <label className="bk-toggle" title="Saved with Apply, like the durations above">
            <input
              type="checkbox"
              checked={skipCounts}
              onChange={(e) => setSkipCounts(e.target.checked)}
              aria-label="Skipping a focus session still counts toward the cycle"
            />
            <span>Skipping a focus session still counts toward the cycle</span>
          </label>
        </div>
      )}
    </div>
  );
}

/**
 * The countdown ring. SVG rather than canvas: it's one arc that changes one
 * number, so the DOM can hold it and it stays crisp at any DPI for free.
 *
 * Focus carries the accent; breaks step down to the dim foreground. That's the
 * whole colour story — a break isn't an alarm, it's the same clock doing
 * something you don't need to watch.
 */
function Ring({
  fraction,
  phase,
  running,
}: {
  fraction: number;
  phase: Phase;
  running: boolean;
}) {
  const R = 58;
  const circumference = 2 * Math.PI * R;
  // The arc drains as the session is spent, so what's left on the ring is what
  // is left on the clock.
  const remaining = circumference * (1 - fraction);
  return (
    <svg className="bk-xpw__ring" viewBox="0 0 140 140" aria-hidden="true">
      <circle className="bk-xpw__ringtrack" cx="70" cy="70" r={R} />
      <circle
        className={`bk-xpw__ringarc ${phase === "focus" ? "is-focus" : "is-break"} ${
          running ? "is-running" : ""
        }`}
        cx="70"
        cy="70"
        r={R}
        strokeDasharray={`${circumference} ${circumference}`}
        strokeDashoffset={circumference - remaining}
      />
    </svg>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bk-dstat">
      <span className="bk-label">{label}</span>
      <strong className="bk-dstat__val">{value}</strong>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  max,
  min = 1,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  max: number;
  min?: number;
}) {
  return (
    <label className="bk-xpw__field">
      <span className="bk-label">{label}</span>
      <input
        className="bk-input"
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
      />
    </label>
  );
}

/** "C:\sounds\jingle.mp3" → "jingle.mp3". */
function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function clampInt(draft: string, lo: number, hi: number, fallback: number): number {
  const n = Number.parseInt(draft, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}
