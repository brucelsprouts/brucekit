import type { PingEntry } from "../../core/ipc";

/**
 * Pure graph geometry for the dcheck line chart, ported from
 * github.com/brucelsprouts/dcheck (dashboard.js `drawGraph`).
 *
 * The one non-obvious idea is **collapsed offline gaps**: brucekit only pings
 * while it's running, so a log spans many sessions. Plotting against wall time
 * would squash days of data into a sliver beside the idle stretches, so
 * consecutive samples more than `GAP_THRESHOLD_MS` apart start a new segment,
 * each segment gets width proportional to its own active duration, and the
 * dead time between them collapses to a fixed-width separator.
 */

/** A jump larger than this between samples means the app was off. */
export const GAP_THRESHOLD_MS = 30_000;
/** Fixed pixel width the collapsed dead time occupies. */
export const GAP_SEPARATOR_W = 14;

/** Plot padding — room for the y labels (left) and time labels (bottom). */
export const PAD = { top: 16, right: 12, bottom: 28, left: 44 } as const;

export type Segment = {
  startIdx: number;
  endIdx: number;
  startMs: number;
  endMs: number;
  /** Pixel x of the segment's left edge. */
  xStart: number;
  /** Pixel width allotted to the segment. */
  xWidth: number;
};

/**
 * Split entries into continuous segments and lay them out across `plotW`,
 * proportional to each segment's active duration.
 */
export function buildSegments(
  entries: PingEntry[],
  plotX: number,
  plotW: number,
): Segment[] {
  if (entries.length === 0) return [];

  const bounds: Array<{ startIdx: number; endIdx: number }> = [];
  let segStart = 0;
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].ts - entries[i - 1].ts > GAP_THRESHOLD_MS) {
      bounds.push({ startIdx: segStart, endIdx: i - 1 });
      segStart = i;
    }
  }
  bounds.push({ startIdx: segStart, endIdx: entries.length - 1 });

  const segments: Segment[] = bounds.map((b) => ({
    ...b,
    startMs: entries[b.startIdx].ts,
    endMs: entries[b.endIdx].ts,
    xStart: 0,
    xWidth: 0,
  }));

  const activeWidth = plotW - (segments.length - 1) * GAP_SEPARATOR_W;
  const totalActive = segments.reduce(
    (sum, s) => sum + Math.max(s.endMs - s.startMs, 1),
    0,
  );

  let cumX = 0;
  for (const seg of segments) {
    seg.xStart = plotX + cumX;
    // A single-sample segment has zero duration; give it a hairline so the
    // layout stays stable and its point is still drawable.
    seg.xWidth = (Math.max(seg.endMs - seg.startMs, 1) / totalActive) * activeWidth;
    cumX += seg.xWidth + GAP_SEPARATOR_W;
  }
  return segments;
}

/** Map a timestamp to its pixel x within the collapsed segment layout. */
export function mapX(segments: Segment[], ts: number): number {
  if (segments.length === 0) return 0;
  for (const seg of segments) {
    if (ts >= seg.startMs - 1 && ts <= seg.endMs + 1) {
      const frac = (ts - seg.startMs) / Math.max(seg.endMs - seg.startMs, 1);
      return seg.xStart + frac * seg.xWidth;
    }
  }
  // Between/outside segments: clamp into the nearest one.
  let best = segments[0];
  let bestDist = Infinity;
  for (const seg of segments) {
    const d = Math.min(Math.abs(ts - seg.startMs), Math.abs(ts - seg.endMs));
    if (d < bestDist) {
      bestDist = d;
      best = seg;
    }
  }
  const frac = Math.max(
    0,
    Math.min(1, (ts - best.startMs) / Math.max(best.endMs - best.startMs, 1)),
  );
  return best.xStart + frac * best.xWidth;
}

/**
 * Y-axis ceiling: headroom over the worst ping, floored at 100 ms so a calm
 * connection doesn't get a wildly zoomed axis (dcheck's rule).
 */
export function computeYMax(entries: PingEntry[]): number {
  let maxPing = 0;
  for (const e of entries) {
    if (e.ms > maxPing) maxPing = e.ms;
  }
  return Math.max((maxPing || 200) * 1.2, 100);
}

/** Inverse of `mapX`: pixel x back to a timestamp (zoom anchoring). */
export function mapXInverse(segments: Segment[], px: number): number | null {
  if (segments.length === 0) return null;
  for (const seg of segments) {
    if (px >= seg.xStart && px <= seg.xStart + seg.xWidth) {
      const frac = seg.xWidth > 0 ? (px - seg.xStart) / seg.xWidth : 0;
      return seg.startMs + frac * (seg.endMs - seg.startMs);
    }
  }
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (px < first.xStart) return first.startMs;
  if (px > last.xStart + last.xWidth) return last.endMs;
  // Inside a collapsed separator: clamp to the end of the segment before it.
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (px > seg.xStart + seg.xWidth && px < segments[i + 1].xStart) return seg.endMs;
  }
  return last.endMs;
}

// ── View window (zoom / pan), ported from dcheck's dashboard state ──────────

/** Tightest zoom: one minute across the plot. */
export const MIN_SPAN_MS = 60_000;
/** Loosest zoom. */
export const MAX_SPAN_MS = 365 * 24 * 3600 * 1000;
/** Trailing padding so the newest sample isn't flush against the right edge. */
const LIVE_PAD_MS = 60_000;

export type View = { startMs: number; endMs: number };

/**
 * The visible time window. While live, it tracks the newest sample; once the
 * user zooms or pans it is pinned to `anchorEnd`.
 */
export function resolveView(
  entries: PingEntry[],
  spanMs: number,
  live: boolean,
  anchorEnd: number | null,
): View {
  if (live || anchorEnd === null) {
    const latest = entries.length > 0 ? entries[entries.length - 1].ts : Date.now();
    const endMs = latest + LIVE_PAD_MS;
    return { startMs: endMs - spanMs, endMs };
  }
  return { startMs: anchorEnd - spanMs, endMs: anchorEnd };
}

/**
 * Entries inside the window, plus one sample either side so the trace enters
 * and leaves the plot instead of stopping short at the edges.
 */
export function filterToView(entries: PingEntry[], view: View): PingEntry[] {
  if (entries.length === 0) return [];
  let minIdx = -1;
  let maxIdx = -1;
  for (let i = 0; i < entries.length; i++) {
    const t = entries[i].ts;
    if (t >= view.startMs && minIdx === -1) minIdx = i;
    if (t <= view.endMs) maxIdx = i;
  }
  if (minIdx === -1) minIdx = entries.length - 1;
  if (maxIdx === -1) maxIdx = 0;
  minIdx = Math.max(0, minIdx - 1);
  maxIdx = Math.min(entries.length - 1, maxIdx + 1);
  if (minIdx > maxIdx) [minIdx, maxIdx] = [maxIdx, minIdx];
  return entries.slice(minIdx, maxIdx + 1);
}

/**
 * Zoom one wheel notch about `anchorTs`, keeping that instant under the
 * cursor. Returns the new span and the window end to pin to.
 */
export function zoomAt(
  view: View,
  spanMs: number,
  anchorTs: number,
  deltaY: number,
): { spanMs: number; endMs: number } {
  const factor = deltaY > 0 ? 1.2 : 1 / 1.2;
  const nextSpan = Math.max(MIN_SPAN_MS, Math.min(spanMs * factor, MAX_SPAN_MS));
  const frac = spanMs > 0 ? (anchorTs - view.startMs) / spanMs : 0.5;
  return { spanMs: nextSpan, endMs: anchorTs + (1 - frac) * nextSpan };
}

/** Drag the window by a fraction of the plot width (positive dx → back in time). */
export function panBy(view: View, spanMs: number, dxFraction: number): number {
  return view.endMs - dxFraction * spanMs;
}

/** Full extent of the data, for the ALL range. */
export function fullSpan(entries: PingEntry[]): number {
  if (entries.length < 2) return MIN_SPAN_MS;
  const span = entries[entries.length - 1].ts - entries[0].ts;
  return Math.max(MIN_SPAN_MS, Math.min(span + LIVE_PAD_MS * 2, MAX_SPAN_MS));
}

/** Gap length for the separator tooltip: "4m", "2h 10m", "3d 4h". */
export function formatGap(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m`;
  return `${Math.floor(hr / 24)}d ${hr % 24}h`;
}
