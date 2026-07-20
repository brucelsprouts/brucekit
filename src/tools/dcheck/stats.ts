import type { PingEntry } from "../../core/ipc";

/** Aggregates shown in the stats row (pure; unit-tested). */
export type PingStats = {
  total: number;
  drops: number;
  high: number;
  /** "99.2" style percentage, or "--" with no data. */
  uptimePct: string;
  last: PingEntry | null;
};

export function computeStats(history: PingEntry[]): PingStats {
  const total = history.length;
  let drops = 0;
  let high = 0;
  for (const e of history) {
    if (e.status === "drop") drops += 1;
    else if (e.status === "high") high += 1;
  }
  return {
    total,
    drops,
    high,
    uptimePct: total > 0 ? (((total - drops) / total) * 100).toFixed(1) : "--",
    last: history[history.length - 1] ?? null,
  };
}

/** Readout for the LAST cell: latency, OFFLINE on a drop, -- with no data. */
export function formatLast(last: PingEntry | null): string {
  if (!last) return "--";
  if (last.status === "drop") return "OFFLINE";
  return `${last.ms}ms`;
}
