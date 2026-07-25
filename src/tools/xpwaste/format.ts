import type { FocusEntry, Phase } from "../../core/ipc";

/** Pure formatting and roll-ups for the xpwaste panel (unit-tested). */

/** Countdown face: 1500 → "25:00", 61 → "01:01". Hours stay in the minutes
 * column, because a 90-minute focus session is still one session. */
export function formatCountdown(sec: number): string {
  const total = Number.isFinite(sec) ? Math.max(0, Math.floor(sec)) : 0;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Studied time: 42 → "42s", 754 → "12m 34s", 8040 → "2h 14m". */
export function formatStudied(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "--";
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Local calendar day of a timestamp, as `YYYY-MM-DD` — the key today's
 * totals group on. Local, not UTC: a session at 11pm belongs to the day you
 * were awake for, not to tomorrow. */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export type FocusTotals = {
  /** Active focus seconds logged today. */
  todaySec: number;
  /** Entries logged today. */
  todaySessions: number;
  /** Active focus seconds ever logged. */
  allTimeSec: number;
};

/** Roll the focus log up into the three numbers the Today card shows. */
export function totals(entries: FocusEntry[], now: number = Date.now()): FocusTotals {
  const today = dayKey(now);
  let todaySec = 0;
  let todaySessions = 0;
  let allTimeSec = 0;
  for (const entry of entries) {
    const seconds = Math.max(0, entry.seconds);
    allTimeSec += seconds;
    if (dayKey(entry.startTs) === today) {
      todaySec += seconds;
      todaySessions += 1;
    }
  }
  return { todaySec, todaySessions, allTimeSec };
}

/** "14:05 – 14:30" for a logged segment. */
export function formatSpan(entry: FocusEntry): string {
  const clock = (ts: number) =>
    new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `${clock(entry.startTs)} – ${clock(entry.endTs)}`;
}

/** Human label for a phase. */
export function phaseLabel(phase: Phase): string {
  switch (phase) {
    case "focus":
      return "Focus";
    case "shortBreak":
      return "Short break";
    case "longBreak":
      return "Long break";
  }
}

/**
 * How much of the current session is spent, 0..1 — what the ring draws.
 * Guards the empty clock: a zero-length total would otherwise divide to NaN
 * and the arc would vanish rather than sit empty.
 */
export function elapsedFraction(remainingSec: number, totalSec: number): number {
  if (!Number.isFinite(totalSec) || totalSec <= 0) return 0;
  const remaining = Math.min(Math.max(remainingSec, 0), totalSec);
  return 1 - remaining / totalSec;
}
