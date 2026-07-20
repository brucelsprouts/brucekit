import { describe, expect, it } from "vitest";
import { computeStats, formatLast } from "./stats";
import type { PingEntry } from "../../core/ipc";

function entry(status: PingEntry["status"], ms: number, ts = 0): PingEntry {
  return { ts, ms, status };
}

describe("computeStats", () => {
  it("is empty-safe", () => {
    const s = computeStats([]);
    expect(s).toEqual({ total: 0, drops: 0, high: 0, uptimePct: "--", last: null });
  });

  it("counts drops and high-latency pings and computes uptime", () => {
    const s = computeStats([
      entry("ok", 20),
      entry("high", 150),
      entry("drop", -1),
      entry("ok", 25, 99),
    ]);
    expect(s.total).toBe(4);
    expect(s.drops).toBe(1);
    expect(s.high).toBe(1);
    expect(s.uptimePct).toBe("75.0"); // 3 of 4 answered
    expect(s.last?.ts).toBe(99);
  });

  it("reports full uptime with no drops", () => {
    expect(computeStats([entry("ok", 10), entry("high", 200)]).uptimePct).toBe("100.0");
  });
});

describe("formatLast", () => {
  it("shows latency for a reply, OFFLINE for a drop, -- for nothing", () => {
    expect(formatLast(entry("ok", 23))).toBe("23ms");
    expect(formatLast(entry("high", 180))).toBe("180ms");
    expect(formatLast(entry("drop", -1))).toBe("OFFLINE");
    expect(formatLast(null)).toBe("--");
  });
});
