import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { ToolContext } from "../types";
import { errorMessage, type PingEntry } from "../../core/ipc";
import { EV_PING } from "../../core/events";
import { computeStats, formatLast } from "./stats";

const RANGES = [
  { label: "10M", sec: 600 },
  { label: "1H", sec: 3600 },
  { label: "24H", sec: 86400 },
  { label: "ALL", sec: 0 },
] as const;

const DEFAULTS = { target: "8.8.8.8", intervalSec: 5, thresholdMs: 100 };

// Canvas colors (canvas can't read CSS vars; matches the token palette —
// color is an event: amber for high latency, red for drops).
const COL_OK = "#9aa1a9";
const COL_HIGH = "#f0b429";
const COL_DROP = "#ff6b6b";
const COL_THRESHOLD = "rgba(244, 246, 248, 0.25)";

/**
 * dcheck panel: live ping graph + uptime stats, with the target / interval /
 * latency-threshold settings and a log wipe. The Rust pinger re-reads settings
 * every cycle, so Apply takes effect on the next ping without a restart.
 */
export function DcheckPanel({ ctx }: { ctx: ToolContext }) {
  const [entries, setEntries] = useState<PingEntry[]>([]);
  const [range, setRange] = useState<number>(600);
  const [target, setTarget] = useState(DEFAULTS.target);
  const [intervalDraft, setIntervalDraft] = useState(String(DEFAULTS.intervalSec));
  const [thresholdDraft, setThresholdDraft] = useState(String(DEFAULTS.thresholdMs));
  const [confirmClear, setConfirmClear] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const threshold = clampInt(thresholdDraft, 1, 60_000, DEFAULTS.thresholdMs);

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

  const loadHistory = useCallback(async () => {
    try {
      setEntries(await ctx.invoke("dcheck_history", { rangeSec: range || null }));
    } catch (err) {
      ctx.toast(errorMessage(err), { kind: "error" });
    }
  }, [ctx, range]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

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

  // Redraw the graph whenever the data or threshold changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) drawGraph(canvas, entries, threshold);
  }, [entries, threshold]);

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

  const stats = computeStats(entries);

  return (
    <div className="bk-dcheck">
      <div className="bk-dcheck__stats">
        <Stat label="LAST" value={formatLast(stats.last)} danger={stats.last?.status === "drop"} />
        <Stat label="UPTIME" value={stats.uptimePct === "--" ? "--" : `${stats.uptimePct}%`} />
        <Stat label="DROPS" value={String(stats.drops)} danger={stats.drops > 0} />
        <Stat label="HIGH LAT" value={String(stats.high)} />
      </div>

      <div className="bk-seg" role="group" aria-label="History range">
        {RANGES.map((r) => (
          <button
            key={r.label}
            type="button"
            className={`bk-seg__btn ${r.sec === range ? "is-active" : ""}`}
            aria-pressed={r.sec === range}
            onClick={() => setRange(r.sec)}
          >
            {r.label}
          </button>
        ))}
      </div>

      <canvas ref={canvasRef} className="bk-dcheck__canvas" aria-label="Ping history graph" />
      {entries.length === 0 && (
        <span className="bk-label">NO PINGS IN THIS RANGE YET — MONITOR RUNS WHILE THE MODULE IS ON</span>
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

function clampInt(draft: string, lo: number, hi: number, fallback: number): number {
  const n = Number.parseInt(draft, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Bar-per-ping graph, newest at the right edge: gray bars scaled by latency,
 * amber above the threshold, full-height red on drops, with a faint dashed
 * threshold line (same idea as the original dcheck dashboard canvas).
 */
function drawGraph(canvas: HTMLCanvasElement, entries: PingEntry[], thresholdMs: number) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 300;
  const cssH = canvas.clientHeight || 120;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);

  const g = canvas.getContext("2d");
  if (!g) return;
  g.scale(dpr, dpr);
  g.clearRect(0, 0, cssW, cssH);

  const barW = 3;
  const gap = 1;
  const maxBars = Math.max(1, Math.floor(cssW / (barW + gap)));
  const visible = entries.slice(-maxBars);
  if (visible.length === 0) return;

  const maxSample = visible.reduce((m, e) => Math.max(m, e.ms), 0);
  const scaleMax = Math.max(thresholdMs * 1.5, maxSample, 50);

  // Threshold hairline.
  const ty = cssH - (thresholdMs / scaleMax) * cssH;
  g.strokeStyle = COL_THRESHOLD;
  g.lineWidth = 1;
  g.setLineDash([3, 3]);
  g.beginPath();
  g.moveTo(0, ty);
  g.lineTo(cssW, ty);
  g.stroke();
  g.setLineDash([]);

  // Bars, newest flush right.
  let x = cssW - visible.length * (barW + gap);
  for (const e of visible) {
    if (e.status === "drop") {
      g.fillStyle = COL_DROP;
      g.fillRect(x, 0, barW, cssH);
    } else {
      const h = Math.max(2, (e.ms / scaleMax) * cssH);
      g.fillStyle = e.status === "high" ? COL_HIGH : COL_OK;
      g.fillRect(x, cssH - h, barW, h);
    }
    x += barW + gap;
  }
}
