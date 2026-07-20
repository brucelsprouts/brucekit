/** Pure duration formatting for the runtime panel (unit-tested). */

/**
 * Uptime from seconds, in the two largest units that matter: 90 → "1m",
 * 8100 → "2h 15m", 356_400 → "4d 3h". Machines stay up for days, and
 * `formatDuration`'s hours-only top unit would render that as "99h".
 */
export function formatUptime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "--";
  const total = Math.floor(sec);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${total}s`;
}

/** App time: 42000 → "42s", 754000 → "12m 34s", 8_040_000 → "2h 14m". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "--";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
