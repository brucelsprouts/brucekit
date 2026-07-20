import { useEffect, useState } from "react";
import type { ToolContext } from "../types";
import type { AppUsage, UsageSession } from "../../core/ipc";
import { formatDuration, formatUptime } from "./format";

/** Refresh cadence for the ledger while the panel is open. */
const POLL_MS = 5000;
/** Rows shown before the list truncates. */
const APPS_SHOWN = 8;

/**
 * runtime panel: what's been running, and for how long.
 *
 * A ranked list of foreground time per app, for this run of brucekit or the
 * previous one. That's the whole panel — machine vitals used to ride along
 * underneath, but nothing about CPU or disk answers the question this module
 * is opened for, and sampling them in the background to render them here was
 * the only thing keeping that work alive.
 */
export function RuntimePanel({ ctx }: { ctx: ToolContext }) {
  const [usage, setUsage] = useState<AppUsage | null>(null);
  const [uptimeSec, setUptimeSec] = useState<number | null>(null);
  const [view, setView] = useState<"current" | "last">("current");

  useEffect(() => {
    let alive = true;
    const load = () => {
      ctx
        .invoke("runtime_apps")
        .then((u) => {
          if (alive) setUsage(u);
        })
        .catch(() => {
          /* outside a Tauri webview (browser preview) — stays empty */
        });
      ctx
        .invoke("runtime_uptime")
        .then((s) => {
          if (alive) setUptimeSec(s);
        })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [ctx]);

  const session = view === "current" ? usage?.current : usage?.last;
  const ranked = Object.entries(session?.apps ?? {}).sort((a, b) => b[1] - a[1]);
  const shown = ranked.slice(0, APPS_SHOWN);
  const maxMs = shown[0]?.[1] ?? 0;
  const trackedMs = ranked.reduce((sum, [, ms]) => sum + ms, 0);

  return (
    <div className="bk-runtime">
      <header className="bk-runtime__head">
        <div className="bk-runtime__totals">
          <span className="bk-label">TRACKED</span>
          <strong className="bk-runtime__big">{formatDuration(trackedMs)}</strong>
          <em className="bk-runtime__sub">
            {session ? sessionSpan(session, view) : "no session"}
            {uptimeSec !== null && ` · up ${formatUptime(uptimeSec)}`}
          </em>
        </div>
        <div className="bk-seg" role="group" aria-label="Session">
          <button
            type="button"
            className={`bk-seg__btn ${view === "current" ? "is-active" : ""}`}
            aria-pressed={view === "current"}
            onClick={() => setView("current")}
          >
            THIS RUN
          </button>
          <button
            type="button"
            className={`bk-seg__btn ${view === "last" ? "is-active" : ""}`}
            aria-pressed={view === "last"}
            onClick={() => setView("last")}
          >
            LAST RUN
          </button>
        </div>
      </header>

      {shown.length === 0 ? (
        <div className="bk-runtime__empty">
          <span className="bk-label">
            {view === "current" ? "NOTHING TRACKED YET THIS RUN" : "NO PREVIOUS RUN SAVED"}
          </span>
          <em>Tracking runs while the module is on and eco mode is off.</em>
        </div>
      ) : (
        <ol className="bk-applist">
          {shown.map(([name, ms], i) => (
            <li key={name} className="bk-applist__row">
              <span className="bk-applist__rank">{String(i + 1).padStart(2, "0")}</span>
              <span className="bk-applist__name" title={name}>
                {name}
              </span>
              <span className="bk-applist__track" aria-hidden="true">
                <span
                  className="bk-applist__fill"
                  style={{ width: `${maxMs > 0 ? (ms / maxMs) * 100 : 0}%` }}
                />
              </span>
              <span className="bk-applist__time">{formatDuration(ms)}</span>
              <span className="bk-applist__share">
                {trackedMs > 0 ? `${Math.round((ms / trackedMs) * 100)}%` : "--"}
              </span>
            </li>
          ))}
        </ol>
      )}
      {ranked.length > APPS_SHOWN && (
        <span className="bk-label">+{ranked.length - APPS_SHOWN} MORE</span>
      )}
    </div>
  );
}

/** "since 9:12 AM" for the live session; "9:12 AM – 5:45 PM" for the last. */
function sessionSpan(session: UsageSession, view: "current" | "last"): string {
  const fmt = (ts: number) =>
    new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return view === "current"
    ? `since ${fmt(session.startTs)}`
    : `${fmt(session.startTs)} – ${fmt(session.endTs)}`;
}
