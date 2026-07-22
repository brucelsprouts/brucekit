import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { ToolContext } from "../types";
import { errorMessage, type Clip } from "../../core/ipc";
import { useUndoSlot } from "../../core/undo";
import { EV_CLIP_ADDED } from "../../core/events";
import { ClipThumb } from "./ClipThumb";
import { formatRelative } from "./time";
import {
  clampMaxHistory,
  formatExcludedApps,
  parseExcludedApps,
  DEFAULT_EXCLUDED_APPS,
  DEFAULT_MAX_HISTORY,
  MAX_HISTORY_LIMIT,
  MIN_MAX_HISTORY,
} from "./settings";

/**
 * ClipStack panel: search the clipboard history, click a row to copy it back,
 * pin favorites to the top, delete one or clear everything. The list refreshes
 * live while open via the clip-added event from the Rust monitor.
 *
 * Rows come in the three flavors the monitor captures. Images show a bounded
 * thumbnail. Formatted text shows its *plain* text — never the markup: the
 * point of the list is to scan what you copied, and a row that renders as a
 * heading, a link, or a table would break the column and misrepresent what
 * lands on the clipboard. The styling is still there, and the `T` button next
 * to such a row is the way to deliberately drop it.
 *
 * The settings drawer writes to `tools.clipstack`, which the Rust monitor
 * re-reads every poll — so changes take effect on the next copy, no restart.
 */
export function ClipsPanel({ ctx }: { ctx: ToolContext }) {
  const [clips, setClips] = useState<Clip[] | null>(null);
  const [query, setQuery] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  /**
   * Clip id awaiting confirmation, and what for. Delete is destructive and
   * unpinning is nearly so — a pin is a deliberate rescue from the history cap,
   * and one stray click on a star would drop the clip back into the queue to be
   * evicted. Both go through the same one-at-a-time inline confirm.
   */
  const [confirming, setConfirming] = useState<{ id: number; kind: "delete" | "unpin" } | null>(
    null,
  );

  const registerUndo = useUndoSlot();

  const [showSettings, setShowSettings] = useState(false);
  const [maxDraft, setMaxDraft] = useState(String(DEFAULT_MAX_HISTORY));
  const [unlimited, setUnlimited] = useState(false);
  const [excludedDraft, setExcludedDraft] = useState(formatExcludedApps(DEFAULT_EXCLUDED_APPS));
  const [honorSensitive, setHonorSensitive] = useState(true);
  const [captureImages, setCaptureImages] = useState(true);

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

  // Restore persisted settings once.
  useEffect(() => {
    let alive = true;
    Promise.all([
      ctx.settings.get<number>("maxHistory", DEFAULT_MAX_HISTORY),
      ctx.settings.get<string[]>("excludedApps", DEFAULT_EXCLUDED_APPS),
      ctx.settings.get<boolean>("honorSensitive", true),
      ctx.settings.get<boolean>("captureImages", true),
    ])
      .then(([max, apps, honor, images]) => {
        if (!alive) return;
        setUnlimited(max === 0);
        // Keep the last real number in the box so unticking Unlimited restores
        // it rather than showing 0.
        if (max !== 0) setMaxDraft(String(max));
        setExcludedDraft(formatExcludedApps(apps));
        setHonorSensitive(honor);
        setCaptureImages(images);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [ctx]);

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

  /**
   * Put a clip back. `plain` is the escape hatch for a formatted clip you want
   * to paste somewhere the styling would look wrong — the same choice Windows
   * offers as "paste as text".
   */
  async function copy(clip: Clip, plain = false) {
    try {
      await ctx.invoke("clips_copy", { id: clip.id, plain });
      ctx.toast(
        clip.image ? "Image copied" : plain ? "Copied without formatting" : "Copied to clipboard",
        { kind: "success" },
      );
    } catch (err) {
      ctx.toast(errorMessage(err), { kind: "error" });
    }
  }

  /** Pin is immediate; unpin is the branch that asks first (see `confirming`). */
  async function togglePin(clip: Clip) {
    if (clip.pinned) {
      setConfirming({ id: clip.id, kind: "unpin" });
      return;
    }
    await applyPin(clip);
  }

  async function applyPin(clip: Clip) {
    setConfirming(null);
    try {
      await ctx.invoke("clips_toggle_pin", { id: clip.id });
      await refresh();
    } catch (err) {
      ctx.toast(errorMessage(err), { kind: "error" });
    }
  }

  /** Puts clips back through the store, then re-reads it (ctrl+z lands here). */
  const restore = useCallback(
    async (gone: Clip[]) => {
      await ctx.invoke("clips_restore", { clips: gone });
      await refresh();
    },
    [ctx, refresh],
  );

  async function remove(clip: Clip) {
    setConfirming(null);
    try {
      await ctx.invoke("clips_delete", { id: clip.id });
      await refresh();
      registerUndo("the clip", () => restore([clip]));
    } catch (err) {
      ctx.toast(errorMessage(err), { kind: "error" });
    }
  }

  async function clearAll() {
    setConfirmClear(false);
    // Snapshot before the wipe: the store is the only copy, and `clips` is
    // filtered by the search box, so re-read unfiltered first.
    let gone: Clip[] = [];
    try {
      gone = await ctx.invoke("clips_list", { search: null });
    } catch {
      /* undo is best-effort; the clear itself still goes ahead */
    }
    try {
      await ctx.invoke("clips_clear");
      await refresh();
      ctx.toast("History cleared", { kind: "success" });
      if (gone.length > 0) {
        registerUndo(`${gone.length} clip${gone.length === 1 ? "" : "s"}`, () => restore(gone));
      }
    } catch (err) {
      ctx.toast(errorMessage(err), { kind: "error" });
    }
  }

  async function applySettings() {
    const maxHistory = unlimited ? 0 : clampMaxHistory(maxDraft);
    const excludedApps = parseExcludedApps(excludedDraft);
    if (!unlimited) setMaxDraft(String(maxHistory));
    setExcludedDraft(formatExcludedApps(excludedApps));
    try {
      await ctx.settings.set("maxHistory", maxHistory);
      await ctx.settings.set("excludedApps", excludedApps);
      await ctx.settings.set("honorSensitive", honorSensitive);
      await ctx.settings.set("captureImages", captureImages);
      // Apply the new cap to what's already stored, then show the result.
      const kept = await ctx.invoke("clips_apply_limit");
      await refresh();
      ctx.toast(
        maxHistory === 0 ? "Settings saved — history unlimited" : `Settings saved — ${kept} kept`,
        { kind: "success" },
      );
    } catch (err) {
      ctx.toast(errorMessage(err), { kind: "error" });
    }
  }

  async function openFolder() {
    try {
      await ctx.invoke("clips_open_folder");
    } catch (err) {
      ctx.toast(errorMessage(err), { kind: "error" });
    }
  }

  // The Rust side already returns pinned first, newest first; splitting here
  // keeps that order inside each section without a second sort.
  const pinnedClips = clips?.filter((c) => c.pinned) ?? [];
  const recentClips = clips?.filter((c) => !c.pinned) ?? [];

  function clipRow(clip: Clip) {
    const pending = confirming?.id === clip.id ? confirming.kind : null;
    return (
      <li key={clip.id} className={`bk-clip ${clip.pinned ? "bk-clip--pinned" : ""}`}>
        {clip.image ? (
          <button
            type="button"
            className="bk-clip__preview"
            onClick={() => void copy(clip)}
            // The preview is decorative (see ClipThumb) — the size beside it is
            // the only thing a text row's label would have carried, so the
            // whole row names itself here instead.
            aria-label={`Copy image ${clip.image.width}×${clip.image.height} to clipboard`}
            title="Copy image to clipboard"
          >
            <ClipThumb ctx={ctx} clip={clip} />
            <span className="bk-clip__dims">{`${clip.image.width}×${clip.image.height}`}</span>
          </button>
        ) : (
          <button
            type="button"
            className="bk-clip__text"
            onClick={() => void copy(clip)}
            title={clip.html ? "Copy with formatting" : "Copy to clipboard"}
          >
            {clip.text}
          </button>
        )}
        {pending ? (
          <>
            <span className={`bk-clip__confirm ${pending === "unpin" ? "is-warn" : ""}`}>
              {pending === "delete" ? "DELETE?" : "UNPIN?"}
            </span>
            <button
              type="button"
              className={`bk-clip__btn ${pending === "delete" ? "bk-clip__btn--danger" : ""}`}
              onClick={() => void (pending === "delete" ? remove(clip) : applyPin(clip))}
              aria-label={pending === "delete" ? "Confirm delete" : "Confirm unpin"}
              title={pending === "delete" ? "Yes, delete" : "Yes, unpin"}
            >
              ✓
            </button>
            <button
              type="button"
              className="bk-clip__btn"
              onClick={() => setConfirming(null)}
              aria-label="Cancel"
              title="Cancel"
            >
              ✕
            </button>
          </>
        ) : (
          <>
            <span className="bk-clip__time">{formatRelative(clip.createdAt)}</span>
            {clip.html && (
              <button
                type="button"
                className="bk-clip__btn bk-clip__btn--plain"
                onClick={() => void copy(clip, true)}
                aria-label="Copy without formatting"
                title="This clip kept its formatting — copy it as plain text instead"
              >
                T
              </button>
            )}
            <button
              type="button"
              className={`bk-clip__btn ${clip.pinned ? "is-active" : ""}`}
              onClick={() => void togglePin(clip)}
              aria-label={clip.pinned ? "Unpin clip" : "Pin clip"}
              title={clip.pinned ? "Unpin (asks first)" : "Pin — keeps it past the history cap"}
            >
              {clip.pinned ? "★" : "☆"}
            </button>
            <button
              type="button"
              className="bk-clip__btn bk-clip__btn--danger"
              onClick={() => setConfirming({ id: clip.id, kind: "delete" })}
              aria-label="Delete clip"
              title="Delete"
            >
              ✕
            </button>
          </>
        )}
      </li>
    );
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
          <em>Copied text and images show up here while the module is on.</em>
        </div>
      ) : (
        <div className="bk-clips__scroll">
          {pinnedClips.length > 0 && (
            <>
              <div className="bk-divider">
                <span>{`// PINNED · ${pinnedClips.length}`}</span>
              </div>
              <ul className="bk-clips__list bk-clips__list--pinned" aria-label="Pinned clips">
                {pinnedClips.map(clipRow)}
              </ul>
            </>
          )}
          {recentClips.length > 0 && (
            <>
              {pinnedClips.length > 0 && (
                <div className="bk-divider">
                  <span>{`// RECENT · ${recentClips.length}`}</span>
                </div>
              )}
              <ul className="bk-clips__list" aria-label="Clipboard history">
                {recentClips.map(clipRow)}
              </ul>
            </>
          )}
        </div>
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
          <>
            <button
              type="button"
              className="bk-btn"
              onClick={() => setConfirmClear(true)}
              disabled={!clips || clips.length === 0}
            >
              Clear history
            </button>
            <button
              type="button"
              className={`bk-btn ${showSettings ? "bk-btn--accent" : ""}`}
              onClick={() => setShowSettings((s) => !s)}
              aria-expanded={showSettings}
              aria-controls="bk-clips-settings"
            >
              Settings
            </button>
          </>
        )}
      </div>

      {showSettings && (
        <div className="bk-clips__settings" id="bk-clips-settings">
          <div className="bk-clips__form">
            <label className="bk-dcheck__field bk-dcheck__field--num">
              <span className="bk-label">KEEP</span>
              <input
                className="bk-input"
                type="number"
                min={MIN_MAX_HISTORY}
                max={MAX_HISTORY_LIMIT}
                step={10}
                value={unlimited ? "" : maxDraft}
                placeholder={unlimited ? "∞" : ""}
                disabled={unlimited}
                onChange={(e) => setMaxDraft(e.target.value)}
                aria-label="Maximum clips to keep"
              />
            </label>
            <label className="bk-toggle" title="Never drop old clips">
              <input
                type="checkbox"
                checked={unlimited}
                onChange={(e) => setUnlimited(e.target.checked)}
                aria-label="Unlimited history"
              />
              <span>Unlimited</span>
            </label>
            <button type="button" className="bk-btn" onClick={() => void openFolder()}>
              Open folder
            </button>
          </div>

          <label className="bk-toggle" title="Windows lets apps mark a copy as not-for-history">
            <input
              type="checkbox"
              checked={honorSensitive}
              onChange={(e) => setHonorSensitive(e.target.checked)}
              aria-label="Skip clips marked sensitive"
            />
            <span>Skip copies apps mark as sensitive</span>
          </label>

          <label className="bk-toggle" title="Copied pictures are saved as PNGs beside clips.json">
            <input
              type="checkbox"
              checked={captureImages}
              onChange={(e) => setCaptureImages(e.target.checked)}
              aria-label="Record copied images"
            />
            <span>Record copied images</span>
          </label>

          <label className="bk-dcheck__field">
            <span className="bk-label">NEVER RECORD FROM</span>
            <textarea
              className="bk-input bk-clips__apps"
              rows={4}
              value={excludedDraft}
              onChange={(e) => setExcludedDraft(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              placeholder="1password&#10;keepass"
              aria-label="Apps excluded from clipboard capture"
            />
          </label>
          <em className="bk-clips__note">
            One app per line, matched against the foreground app's name — partial names work, so
            “keepass” also covers KeePassXC. Password managers ship pre-filled; the sensitive-copy
            toggle above catches the ones that mark their own copies, including apps not listed
            here.
          </em>

          <div className="bk-clips__footer">
            <button type="button" className="bk-btn bk-btn--accent" onClick={() => void applySettings()}>
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
