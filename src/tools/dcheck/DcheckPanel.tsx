import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { ToolContext } from "../types";
import { errorMessage, type PingEntry } from "../../core/ipc";
import { EV_PING } from "../../core/events";
import { computeStats, formatLast } from "./stats";
import {
  buildSegments,
  computeYMax,
  filterToView,
  formatGap,
  fullSpan,
  GAP_SEPARATOR_W,
  GAP_THRESHOLD_MS,
  mapX,
  mapXInverse,
  PAD,
  panBy,
  resolveView,
  zoomAt,
  type Segment,
} from "./graph";

const RANGES = [
  { label: "1H", sec: 3600 },
  { label: "6H", sec: 21600 },
  { label: "12H", sec: 43200 },
  { label: "ALL", sec: 0 },
] as const;
const DEFAULT_RANGE_SEC = 3600;

const DEFAULTS = { target: "8.8.8.8", intervalSec: 5, thresholdMs: 100 };

// Canvas colors (canvas can't read CSS vars; ported from dcheck's dashboard
// onto the brucekit palette — color is an event: orange for high ping, red
// for disconnects, white for the trace itself).
const COL_LINE = "#f4f6f8";
const COL_LINE_GLOW = "rgba(244, 246, 248, 0.15)";
const COL_HIGH = "#ff8c00";
const COL_HIGH_GLOW = "rgba(255, 140, 0, 0.2)";
const COL_DROP = "#ff2020";
const COL_DROP_GLOW = "rgba(255, 32, 32, 0.18)";
const COL_THRESHOLD = "rgba(255, 140, 0, 0.25)";
const COL_GRID = "#21252b";
const COL_AXIS = "#565d66";
const COL_AXIS_LINE = "#313842";
const COL_GAP_FILL = "rgba(30, 32, 36, 0.8)";
const COL_GAP_LINE = "#262b32";
const COL_CROSSHAIR = "rgba(244, 246, 248, 0.12)";
const COL_TIP_BG = "rgba(14, 16, 19, 0.95)";
const COL_TIP_LINE = "rgba(244, 246, 248, 0.15)";
const FONT_XS = '9px "JetBrains Mono", ui-monospace, monospace';
const FONT_SM = '10px "JetBrains Mono", ui-monospace, monospace';

/**
 * dcheck panel: live ping graph + uptime stats, with the target / interval /
 * latency-threshold settings and a log wipe. The Rust pinger re-reads settings
 * every cycle, so Apply takes effect on the next ping without a restart.
 */
export function DcheckPanel({ ctx }: { ctx: ToolContext }) {
  /** Everything the pinger has logged; the view window slices it locally. */
  const [entries, setEntries] = useState<PingEntry[]>([]);
  const [range, setRange] = useState<number>(DEFAULT_RANGE_SEC);
  /** Visible span. Diverges from `range` as soon as the user zooms. */
  const [spanMs, setSpanMs] = useState<number>(DEFAULT_RANGE_SEC * 1000);
  /**
   * While live the window tracks the newest ping; zooming or panning pins it
   * to an explicit end so the view stops sliding out from under you.
   */
  const [live, setLive] = useState(true);
  const [anchorEnd, setAnchorEnd] = useState<number | null>(null);
  const [target, setTarget] = useState(DEFAULTS.target);
  const [intervalDraft, setIntervalDraft] = useState(String(DEFAULTS.intervalSec));
  const [thresholdDraft, setThresholdDraft] = useState(String(DEFAULTS.thresholdMs));
  const [confirmClear, setConfirmClear] = useState(false);
  /** Cursor x within the canvas, in CSS px — null when not hovering. */
  const [hoverX, setHoverX] = useState<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /** Drag state for panning; refs so the window listeners stay off stale closures. */
  const panning = useRef(false);
  const lastPanX = useRef(0);

  const threshold = clampInt(thresholdDraft, 1, 60_000, DEFAULTS.thresholdMs);

  const view = useMemo(
    () => resolveView(entries, spanMs, live, anchorEnd),
    [entries, spanMs, live, anchorEnd],
  );
  // Slicing is memoized so hover repaints don't re-filter the whole log.
  const visible = useMemo(() => filterToView(entries, view), [entries, view]);

  // Restore persisted settings once.
  useEffect(() => {
    let alive = true;
    Promise.all([
      ctx.settings.get<string>("target", DEFAULTS.target),
      ctx.settings.get<number>("intervalSec", DEFAULTS.intervalSec),
      ctx.settings.get<number>("thresholdMs", DEFAULTS.thresholdMs),
    ])
      .then(([t, i, th]) => {
        if (!alive) return;
        setTarget(t);
        setIntervalDraft(String(i));
        setThresholdDraft(String(th));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [ctx]);

  // The whole log loads once: zoom and pan roam over all of it locally, so
  // re-fetching per range would just re-download what we already hold.
  const loadHistory = useCallback(async () => {
    try {
      setEntries(await ctx.invoke("dcheck_history", { rangeSec: null }));
    } catch (err) {
      ctx.toast(errorMessage(err), { kind: "error" });
    }
  }, [ctx]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  /** Jump to a preset range and resume following the live edge. */
  const selectRange = useCallback(
    (sec: number) => {
      setRange(sec);
      setSpanMs(sec === 0 ? fullSpan(entries) : sec * 1000);
      setLive(true);
      setAnchorEnd(null);
    },
    [entries],
  );

  // Live-append pings while the panel is open.
  useEffect(() => {
    let dispose = () => {};
    listen<PingEntry>(EV_PING, (event) => {
      setEntries((prev) => [...prev, event.payload]);
    })
      .then((un) => {
        dispose = un;
      })
      .catch(() => {});
    return () => dispose();
  }, []);

  // Redraw whenever the visible slice, threshold, or hover position changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) drawGraph(canvas, visible, threshold, hoverX);
  }, [visible, threshold, hoverX]);

  // The canvas is sized by CSS; repaint on resize so the plot stays sharp and
  // the collapsed-gap layout re-flows to the new width.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      drawGraph(canvas, visible, threshold, hoverX);
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [visible, threshold, hoverX]);

  /** Scroll to zoom, anchored on the instant under the cursor. */
  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement>) => {
      if (visible.length === 0) return;
      e.preventDefault();
      const rect = e.currentTarget.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const segments = buildSegments(visible, PAD.left, rect.width - PAD.left - PAD.right);
      const anchorTs = mapXInverse(segments, px);
      if (anchorTs === null) return;
      const next = zoomAt(view, spanMs, anchorTs, e.deltaY);
      setSpanMs(next.spanMs);
      setAnchorEnd(next.endMs);
      setLive(false);
    },
    [visible, view, spanMs],
  );

  // Drag to pan. The move/up listeners live on the window so a drag that
  // leaves the canvas keeps tracking instead of sticking mid-pan.
  useEffect(() => {
    function onMove(e: globalThis.MouseEvent) {
      if (!panning.current) return;
      const dx = e.clientX - lastPanX.current;
      if (dx === 0) return;
      lastPanX.current = e.clientX;
      const width = canvasRef.current?.clientWidth ?? 1;
      setAnchorEnd((prev) => panBy({ ...view, endMs: prev ?? view.endMs }, spanMs, dx / width));
      setLive(false);
    }
    function onUp() {
      panning.current = false;
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [view, spanMs]);

  async function applySettings() {
    const intervalSec = clampInt(intervalDraft, 1, 3600, DEFAULTS.intervalSec);
    const thresholdMs = clampInt(thresholdDraft, 1, 60_000, DEFAULTS.thresholdMs);
    const cleanTarget = target.trim() || DEFAULTS.target;
    setTarget(cleanTarget);
    setIntervalDraft(String(intervalSec));
    setThresholdDraft(String(thresholdMs));
    try {
      await ctx.settings.set("target", cleanTarget);
      await ctx.settings.set("intervalSec", intervalSec);
      await ctx.settings.set("thresholdMs", thresholdMs);
      ctx.toast("Settings apply on the next ping", { kind: "success" });
    } catch (err) {
      ctx.toast(errorMessage(err), { kind: "error" });
    }
  }

  async function clearLog() {
    setConfirmClear(false);
    try {
      await ctx.invoke("dcheck_clear");
      setEntries([]);
      ctx.toast("Log cleared", { kind: "success" });
    } catch (err) {
      ctx.toast(errorMessage(err), { kind: "error" });
    }
  }

  // Stats describe what you're looking at, so they follow the view window.
  const stats = computeStats(visible);

  return (
    <div className="bk-dcheck">
      <div className="bk-dcheck__stats">
        <Stat label="LAST" value={formatLast(stats.last)} danger={stats.last?.status === "drop"} />
        <Stat label="UPTIME" value={stats.uptimePct === "--" ? "--" : `${stats.uptimePct}%`} />
        <Stat label="DROPS" value={String(stats.drops)} danger={stats.drops > 0} />
        <Stat label="HIGH LAT" value={String(stats.high)} />
      </div>

      <div className="bk-dcheck__rangebar">
        <div className="bk-seg" role="group" aria-label="History range">
          {RANGES.map((r) => (
            <button
              key={r.label}
              type="button"
              className={`bk-seg__btn ${live && r.sec === range ? "is-active" : ""}`}
              aria-pressed={live && r.sec === range}
              onClick={() => selectRange(r.sec)}
            >
              {r.label}
            </button>
          ))}
        </div>
        <span className="bk-label bk-dcheck__viewhint">
          {live ? "LIVE · SCROLL TO ZOOM, DRAG TO PAN" : formatSpan(spanMs)}
        </span>
        {!live && (
          <button
            type="button"
            className="bk-btn bk-btn--sm"
            onClick={() => selectRange(range)}
            title="Snap back to the newest pings"
          >
            Live
          </button>
        )}
      </div>

      <canvas
        ref={canvasRef}
        className={`bk-dcheck__canvas ${live ? "" : "is-panned"}`}
        aria-label="Ping history graph"
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setHoverX(e.clientX - rect.left);
        }}
        onMouseLeave={() => setHoverX(null)}
        onMouseDown={(e) => {
          panning.current = true;
          lastPanX.current = e.clientX;
        }}
        onWheel={onWheel}
      />
      {entries.length === 0 && (
        <span className="bk-label">MONITOR RUNS WHILE THE MODULE IS ON — ECO MODE PAUSES IT</span>
      )}

      <div className="bk-dcheck__form">
        <label className="bk-dcheck__field">
          <span className="bk-label">TARGET</span>
          <input
            className="bk-input"
            type="text"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            aria-label="Ping target"
          />
        </label>
        <label className="bk-dcheck__field bk-dcheck__field--num">
          <span className="bk-label">EVERY (S)</span>
          <input
            className="bk-input"
            type="number"
            min={1}
            max={3600}
            value={intervalDraft}
            onChange={(e) => setIntervalDraft(e.target.value)}
            aria-label="Ping interval in seconds"
          />
        </label>
        <label className="bk-dcheck__field bk-dcheck__field--num">
          <span className="bk-label">HIGH (MS)</span>
          <input
            className="bk-input"
            type="number"
            min={1}
            max={60000}
            value={thresholdDraft}
            onChange={(e) => setThresholdDraft(e.target.value)}
            aria-label="High latency threshold in milliseconds"
          />
        </label>
        <button type="button" className="bk-btn" onClick={() => void applySettings()}>
          Apply
        </button>
      </div>

      <div className="bk-dcheck__footer">
        {confirmClear ? (
          <>
            <span className="bk-label bk-label--danger">WIPE THE LOG?</span>
            <button type="button" className="bk-btn" onClick={() => void clearLog()}>
              Clear
            </button>
            <button type="button" className="bk-btn" onClick={() => setConfirmClear(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            className="bk-btn"
            onClick={() => setConfirmClear(true)}
            disabled={entries.length === 0}
          >
            Clear log
          </button>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="bk-dstat">
      <span className="bk-label">{label}</span>
      <strong className={danger ? "bk-dstat__val bk-dstat__val--danger" : "bk-dstat__val"}>
        {value}
      </strong>
    </div>
  );
}

/** Visible span as a readable label while zoomed: "45m", "2h 10m", "3d". */
function formatSpan(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min}m WINDOW`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m WINDOW`;
  return `${Math.floor(hr / 24)}d ${hr % 24}h WINDOW`;
}

function clampInt(draft: string, lo: number, hi: number, fallback: number): number {
  const n = Number.parseInt(draft, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Line graph ported from github.com/brucelsprouts/dcheck (dashboard.js):
 * a white latency trace over a dashed grid, broken at drops and at offline
 * gaps, with red disconnect bars, amber high-latency dots, a threshold
 * hairline, and a hover crosshair + tooltip. Time collapses across gaps —
 * see graph.ts for that layout.
 */
export function drawGraph(
  canvas: HTMLCanvasElement,
  entries: PingEntry[],
  thresholdMs: number,
  hoverX: number | null,
) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 300;
  const cssH = canvas.clientHeight || 160;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);

  const g = canvas.getContext("2d");
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cssW, cssH);

  const pX = PAD.left;
  const pY = PAD.top;
  const pW = cssW - PAD.left - PAD.right;
  const pH = cssH - PAD.top - PAD.bottom;
  if (pW <= 0 || pH <= 0) return;

  if (entries.length === 0) {
    g.fillStyle = COL_AXIS;
    g.font = FONT_SM;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText("Waiting for ping data…", cssW / 2, cssH / 2);
    return;
  }

  const yMax = computeYMax(entries);
  const mapY = (ms: number) => pY + pH - (Math.min(ms, yMax) / yMax) * pH;
  const segments = buildSegments(entries, pX, pW);
  const x0 = (ts: number) => mapX(segments, ts);

  // ── Grid: horizontal rules + y labels ──
  g.font = FONT_XS;
  g.textAlign = "right";
  g.textBaseline = "middle";
  const ySteps = 4;
  for (let i = 0; i <= ySteps; i++) {
    const val = Math.round((i * yMax) / ySteps);
    const y = pY + pH - (val / yMax) * pH;
    if (i > 0) {
      g.strokeStyle = COL_GRID;
      g.lineWidth = 0.5;
      g.setLineDash([2, 3]);
      g.beginPath();
      g.moveTo(pX, y);
      g.lineTo(pX + pW, y);
      g.stroke();
    }
    g.setLineDash([]);
    g.fillStyle = COL_AXIS;
    g.fillText(String(val), pX - 4, y);
  }

  // ── Time labels + vertical rules, per segment ──
  g.textAlign = "center";
  g.textBaseline = "top";
  for (const seg of segments) {
    const labelCount = Math.max(1, Math.min(5, Math.floor(seg.xWidth / 50)));
    for (let i = 0; i <= labelCount; i++) {
      const frac = i / labelCount;
      const x = seg.xStart + frac * seg.xWidth;
      const t = seg.startMs + frac * (seg.endMs - seg.startMs);
      if (i > 0 && i < labelCount) {
        g.strokeStyle = COL_GRID;
        g.lineWidth = 0.5;
        g.setLineDash([2, 3]);
        g.beginPath();
        g.moveTo(x, pY);
        g.lineTo(x, pY + pH);
        g.stroke();
        g.setLineDash([]);
      }
      g.fillStyle = COL_AXIS;
      g.fillText(formatClock(t), x, pY + pH + 6);
    }
  }

  // ── Threshold hairline ──
  if (thresholdMs < yMax) {
    g.strokeStyle = COL_THRESHOLD;
    g.lineWidth = 1;
    g.setLineDash([3, 3]);
    g.beginPath();
    g.moveTo(pX, mapY(thresholdMs));
    g.lineTo(pX + pW, mapY(thresholdMs));
    g.stroke();
    g.setLineDash([]);
  }

  // ── Collapsed-gap separators ──
  for (let s = 0; s < segments.length - 1; s++) {
    const gapX = segments[s].xStart + segments[s].xWidth;
    g.fillStyle = COL_GAP_FILL;
    g.fillRect(gapX, pY, GAP_SEPARATOR_W, pH);
    g.strokeStyle = COL_GAP_LINE;
    g.lineWidth = 1;
    g.setLineDash([2, 2]);
    for (const gx of [gapX, gapX + GAP_SEPARATOR_W]) {
      g.beginPath();
      g.moveTo(gx, pY);
      g.lineTo(gx, pY + pH);
      g.stroke();
    }
    g.setLineDash([]);
  }

  // ── Disconnect bars (red, with a glow) ──
  for (const e of entries) {
    if (e.status !== "drop") continue;
    const x = x0(e.ts);
    for (const [color, width] of [
      [COL_DROP_GLOW, 6],
      [COL_DROP, 2],
    ] as const) {
      g.strokeStyle = color;
      g.lineWidth = width;
      g.beginPath();
      g.moveTo(x, pY);
      g.lineTo(x, pY + pH);
      g.stroke();
    }
  }

  // ── Ping line — breaks at drops and at offline gaps ──
  g.strokeStyle = COL_LINE;
  g.lineWidth = 1.5;
  g.lineJoin = "round";
  g.beginPath();
  let started = false;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.status === "drop") {
      if (started) g.stroke();
      g.beginPath();
      started = false;
      continue;
    }
    if (i > 0 && e.ts - entries[i - 1].ts > GAP_THRESHOLD_MS) {
      if (started) g.stroke();
      g.beginPath();
      started = false;
    }
    const x = x0(e.ts);
    const y = mapY(e.ms);
    if (started) {
      g.lineTo(x, y);
    } else {
      g.moveTo(x, y);
      started = true;
    }
  }
  if (started) g.stroke();

  // ── High-latency dots (amber) ──
  g.fillStyle = COL_HIGH;
  for (const e of entries) {
    if (e.status !== "high") continue;
    g.beginPath();
    g.arc(x0(e.ts), mapY(e.ms), 2.5, 0, Math.PI * 2);
    g.fill();
  }

  // ── Axes ──
  g.strokeStyle = COL_AXIS_LINE;
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(pX, pY);
  g.lineTo(pX, pY + pH);
  g.lineTo(pX + pW, pY + pH);
  g.stroke();

  if (hoverX !== null && hoverX >= pX && hoverX <= pX + pW) {
    drawHover(g, entries, segments, { pX, pY, pW, pH }, hoverX, x0, mapY);
  }
}

type Plot = { pX: number; pY: number; pW: number; pH: number };

/** Crosshair + readout for the sample nearest the cursor (dcheck's tooltip). */
function drawHover(
  g: CanvasRenderingContext2D,
  entries: PingEntry[],
  segments: Segment[],
  { pX, pY, pW, pH }: Plot,
  hoverX: number,
  x0: (ts: number) => number,
  mapY: (ms: number) => number,
) {
  // Hovering a collapsed gap reads out how long the app was off instead.
  for (let s = 0; s < segments.length - 1; s++) {
    const gapX = segments[s].xStart + segments[s].xWidth;
    if (hoverX >= gapX && hoverX <= gapX + GAP_SEPARATOR_W) {
      const text = `OFF ${formatGap(segments[s + 1].startMs - segments[s].endMs)}`;
      g.font = FONT_SM;
      const boxW = g.measureText(text).width + 16;
      g.fillStyle = COL_TIP_BG;
      g.fillRect(hoverX - boxW / 2, pY + pH / 2 - 12, boxW, 24);
      g.strokeStyle = COL_TIP_LINE;
      g.lineWidth = 1;
      g.strokeRect(hoverX - boxW / 2, pY + pH / 2 - 12, boxW, 24);
      g.fillStyle = COL_LINE;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(text, hoverX, pY + pH / 2);
      return;
    }
  }

  let closest: PingEntry | null = null;
  let closestDist = Infinity;
  let cx = 0;
  for (const e of entries) {
    const d = Math.abs(x0(e.ts) - hoverX);
    if (d < closestDist) {
      closestDist = d;
      closest = e;
      cx = x0(e.ts);
    }
  }
  if (!closest || closestDist > 30) return;
  const cy = closest.status === "drop" ? pY + pH : mapY(closest.ms);

  g.strokeStyle = COL_CROSSHAIR;
  g.lineWidth = 1;
  g.setLineDash([3, 3]);
  g.beginPath();
  g.moveTo(cx, pY);
  g.lineTo(cx, pY + pH);
  g.stroke();
  g.setLineDash([]);

  const dot =
    closest.status === "drop" ? COL_DROP : closest.status === "high" ? COL_HIGH : COL_LINE;
  const glow =
    closest.status === "drop"
      ? COL_DROP_GLOW
      : closest.status === "high"
        ? COL_HIGH_GLOW
        : COL_LINE_GLOW;
  g.fillStyle = glow;
  g.beginPath();
  g.arc(cx, cy, 8, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = dot;
  g.beginPath();
  g.arc(cx, cy, 3.5, 0, Math.PI * 2);
  g.fill();

  const line1 = formatClock(closest.ts);
  const line2 =
    closest.status === "drop"
      ? "TIMEOUT"
      : `${closest.ms}ms${closest.status === "high" ? "  HIGH LAT" : ""}`;

  g.font = FONT_SM;
  const boxW = Math.max(g.measureText(line1).width, g.measureText(line2).width) + 16;
  const boxH = 36;
  const margin = 10;
  let tipX = cx + margin;
  let tipY = cy - boxH - margin;
  if (tipX + boxW > pX + pW) tipX = cx - boxW - margin;
  if (tipY < pY) tipY = cy + margin;

  g.fillStyle = COL_TIP_BG;
  g.fillRect(tipX, tipY, boxW, boxH);
  g.strokeStyle = closest.status === "ok" ? COL_TIP_LINE : dot;
  g.lineWidth = 1;
  g.strokeRect(tipX, tipY, boxW, boxH);

  g.textAlign = "left";
  g.textBaseline = "top";
  g.fillStyle = COL_AXIS;
  g.fillText(line1, tipX + 8, tipY + 6);
  g.fillStyle = dot;
  g.fillText(line2, tipX + 8, tipY + 20);
}

/** 24h clock label for axis ticks and tooltips. */
function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
