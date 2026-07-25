import { describe, expect, it } from "vitest";
import type { FocusEntry } from "../../core/ipc";
import {
  dayKey,
  elapsedFraction,
  formatCountdown,
  formatSpan,
  formatStudied,
  phaseLabel,
  totals,
} from "./format";

/** A logged segment starting `hoursAgo` before `now`, lasting `seconds`. */
function entry(id: number, startTs: number, seconds: number): FocusEntry {
  return { id, startTs, endTs: startTs + seconds * 1000, seconds };
}

describe("formatCountdown", () => {
  it("is always mm:ss, zero-padded", () => {
    expect(formatCountdown(1500)).toBe("25:00");
    expect(formatCountdown(61)).toBe("01:01");
    expect(formatCountdown(0)).toBe("00:00");
  });

  it("keeps long sessions in the minutes column", () => {
    // A 90-minute session is one session, not "1:30:00".
    expect(formatCountdown(5400)).toBe("90:00");
  });

  it("never renders a negative or nonsense clock", () => {
    expect(formatCountdown(-5)).toBe("00:00");
    expect(formatCountdown(Number.NaN)).toBe("00:00");
  });
});

describe("formatStudied", () => {
  it("picks the two most significant units", () => {
    expect(formatStudied(42)).toBe("42s");
    expect(formatStudied(754)).toBe("12m 34s");
    expect(formatStudied(8040)).toBe("2h 14m");
  });

  it("rejects garbage", () => {
    expect(formatStudied(-1)).toBe("--");
    expect(formatStudied(Number.NaN)).toBe("--");
  });
});

describe("dayKey", () => {
  it("groups by local calendar day, not UTC", () => {
    const late = new Date(2026, 6, 24, 23, 30).getTime();
    const earlier = new Date(2026, 6, 24, 8, 5).getTime();
    expect(dayKey(late)).toBe("2026-07-24");
    // An 11pm session belongs to the day you were awake for. Under UTC in a
    // negative-offset zone this pair would split across two days.
    expect(dayKey(late)).toBe(dayKey(earlier));
  });

  it("pads single-digit months and days", () => {
    expect(dayKey(new Date(2026, 0, 5, 12, 0).getTime())).toBe("2026-01-05");
  });
});

describe("totals", () => {
  const now = new Date(2026, 6, 24, 17, 0).getTime();
  const todayMorning = new Date(2026, 6, 24, 9, 0).getTime();
  const todayNoon = new Date(2026, 6, 24, 12, 0).getTime();
  const yesterday = new Date(2026, 6, 23, 15, 0).getTime();

  it("counts only today toward the day's numbers", () => {
    const log = [entry(1, yesterday, 1800), entry(2, todayMorning, 600), entry(3, todayNoon, 900)];
    expect(totals(log, now)).toEqual({
      todaySec: 1500,
      todaySessions: 2,
      allTimeSec: 3300,
    });
  });

  it("is empty for an empty log", () => {
    expect(totals([], now)).toEqual({ todaySec: 0, todaySessions: 0, allTimeSec: 0 });
  });

  it("ignores a negative duration rather than subtracting it", () => {
    const log = [entry(1, todayNoon, 600), { ...entry(2, todayNoon, 0), seconds: -60 }];
    expect(totals(log, now).todaySec).toBe(600);
    expect(totals(log, now).allTimeSec).toBe(600);
  });
});

describe("formatSpan", () => {
  it("reads as the stretch it covers", () => {
    const start = new Date(2026, 6, 24, 14, 5).getTime();
    expect(formatSpan(entry(1, start, 1500))).toMatch(/14.05.+14.30|2:05.+2:30/);
  });
});

describe("phaseLabel", () => {
  it("names each phase", () => {
    expect(phaseLabel("focus")).toBe("Focus");
    expect(phaseLabel("shortBreak")).toBe("Short break");
    expect(phaseLabel("longBreak")).toBe("Long break");
  });
});

describe("elapsedFraction", () => {
  it("grows from 0 to 1 as the session is spent", () => {
    expect(elapsedFraction(1500, 1500)).toBe(0);
    expect(elapsedFraction(750, 1500)).toBe(0.5);
    expect(elapsedFraction(0, 1500)).toBe(1);
  });

  it("clamps rather than overshooting the ring", () => {
    expect(elapsedFraction(-30, 1500)).toBe(1);
    expect(elapsedFraction(2000, 1500)).toBe(0);
  });

  it("treats an empty clock as untouched instead of NaN", () => {
    expect(elapsedFraction(0, 0)).toBe(0);
    expect(elapsedFraction(10, Number.NaN)).toBe(0);
  });
});
