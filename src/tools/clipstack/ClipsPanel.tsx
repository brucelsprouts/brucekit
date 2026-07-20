import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { ToolContext } from "../types";
import { errorMessage, type Clip } from "../../core/ipc";
import { EV_CLIP_ADDED } from "../../core/events";
import { formatRelative } from "./time";

/**
 * ClipStack panel: search the clipboard history, click a row to copy it back,
 * pin favorites to the top, delete one or clear everything. The list refreshes
 * live while open via the clip-added event from the Rust monitor.
 */
export function ClipsPanel({ ctx }: { ctx: ToolContext }) {
  const [clips, setClips] = useState<Clip[] | null>(null);
  const [query, setQuery] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  /** Clip id awaiting delete confirmation (one at a time). */
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      setClips(await ctx.invoke("clips_list", { search: query.trim() || null }));
    } catch (err) {
      ctx.toast(errorMessage(err), { kind: "error" });
      setClips([]);
    }
  }, [ctx, query]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live-append while the panel is open.
  useEffect(() => {
    let dispose = () => {};
    listen(EV_CLIP_ADDED, () => void refresh())
      .then((un) => {
        dispose = un;
      })
      .catch(() => {});
    return () => dispose();
  }, [refresh]);

  async function copy(clip: Clip) {
    try {
      await ctx.invoke("clips_copy", { id: clip.id });
      ctx.toast("Copied to clipboard", { kind: "success" });
    } catch (err) {
      ctx.toast(errorMessage(err), { kind: "error" });
    }
  }

  async function togglePin(clip: Clip) {
    try {
      await ctx.invoke("clips_toggle_pin", { id: clip.id });
      await refresh();
    } catch (err) {
      ctx.toast(errorMessage(err), { kind: "error" });
    }
  }

  async function remove(clip: Clip) {
    setConfirmDeleteId(null);
    try {
      await ctx.invoke("clips_delete", { id: clip.id });
      await refresh();
    } catch (err) {
      ctx.toast(errorMessage(err), { kind: "error" });
    }
  }

  async function clearAll() {
    setConfirmClear(false);
    try {
      await ctx.invoke("clips_clear");
      await refresh();
      ctx.toast("History cleared", { kind: "success" });
    } catch (err) {
      ctx.toast(errorMessage(err), { kind: "error" });
    }
  }

  return (
    <div className="bk-clips">
      <input
        className="bk-input"
        type="text"
        placeholder="Search clips…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        spellCheck={false}
        autoComplete="off"
        aria-label="Search clipboard history"
      />

      {clips === null ? (
        <span className="bk-label">LOADING…</span>
      ) : clips.length === 0 ? (
        <div className="bk-clips__empty">
          <span className="bk-label">
            {query.trim() ? "NO MATCHES" : "NOTHING COPIED YET"}
          </span>
          <em>Copied text shows up here while the module is on.</em>
        </div>
      ) : (
        <ul className="bk-clips__list" aria-label="Clipboard history">
          {clips.map((clip) => (
            <li key={clip.id} className={`bk-clip ${clip.pinned ? "bk-clip--pinned" : ""}`}>
              <button
                type="button"
                className="bk-clip__text"
                onClick={() => void copy(clip)}
                title="Copy to clipboard"
              >
                {clip.text}
              </button>
              {confirmDeleteId === clip.id ? (
                <>
                  <span className="bk-clip__confirm">DELETE?</span>
                  <button
                    type="button"
                    className="bk-clip__btn bk-clip__btn--danger"
                    onClick={() => void remove(clip)}
                    aria-label="Confirm delete"
                    title="Yes, delete"
                  >
                    ✓
                  </button>
                  <button
                    type="button"
                    className="bk-clip__btn"
                    onClick={() => setConfirmDeleteId(null)}
                    aria-label="Cancel delete"
                    title="Cancel"
                  >
                    ✕
                  </button>
                </>
              ) : (
                <>
                  <span className="bk-clip__time">{formatRelative(clip.createdAt)}</span>
                  <button
                    type="button"
                    className={`bk-clip__btn ${clip.pinned ? "is-active" : ""}`}
                    onClick={() => void togglePin(clip)}
                    aria-label={clip.pinned ? "Unpin clip" : "Pin clip"}
                    title={clip.pinned ? "Unpin" : "Pin"}
                  >
                    {clip.pinned ? "★" : "☆"}
                  </button>
                  <button
                    type="button"
                    className="bk-clip__btn bk-clip__btn--danger"
                    onClick={() => setConfirmDeleteId(clip.id)}
                    aria-label="Delete clip"
                    title="Delete"
                  >
                    ✕
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="bk-clips__footer">
        {confirmClear ? (
          <>
            <span className="bk-label bk-label--danger">CLEAR EVERYTHING?</span>
            <button type="button" className="bk-btn" onClick={() => void clearAll()}>
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
            disabled={!clips || clips.length === 0}
          >
            Clear history
          </button>
        )}
      </div>
    </div>
  );
}
