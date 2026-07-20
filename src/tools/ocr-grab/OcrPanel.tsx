import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { ToolContext } from "../types";
import { errorMessage } from "../../core/ipc";
import { useUndoSlot } from "../../core/undo";
import { launchCapture } from "../../core/overlay";
import { OcrIcon } from "./icon";
import {
  EV_CAPTURE_CANCELED,
  EV_OCR_DONE,
  type OcrDonePayload,
} from "../../core/events";

type Status = "idle" | "scanning" | "done" | "empty" | "error";

/** Word/line counts are worth showing next to a scan; both are cheap and pure. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

export function countLines(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\r?\n/).length;
}

/**
 * OCR grab panel (spec §10, reworked): "Scan region" hides the launcher and
 * starts the freeze-frame flow; when the drag completes the launcher reopens
 * right here with the recognized text on screen and on the clipboard — every
 * scan has a visible result.
 *
 * The result area carries the state rather than a separate status line: an
 * empty scan and a failed scan are different things, and neither should look
 * like a blank textarea with a caption above it.
 */
export function OcrPanel({ ctx }: { ctx: ToolContext }) {
  const [status, setStatus] = useState<Status>("idle");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** Clear throws away a scan that can't be re-run, so it asks first. */
  const [confirmClear, setConfirmClear] = useState(false);
  const registerUndo = useUndoSlot();

  // Receive the scan result from the overlay; the panel stays mounted while
  // the launcher window is hidden, so this listener survives the round-trip.
  useEffect(() => {
    const disposers: Array<() => void> = [];
    listen<OcrDonePayload>(EV_OCR_DONE, async (event) => {
      const { text: raw, error: err } = event.payload;
      if (err) {
        setStatus("error");
        setError(err);
        return;
      }
      const result = raw.trim();
      setError(null);
      // A fresh scan lands on a stale prompt otherwise — and the text the
      // prompt was asking about is already gone by then.
      setConfirmClear(false);
      if (!result) {
        setStatus("empty");
        return;
      }
      setText(result);
      setStatus("done");
      try {
        await writeText(result);
        ctx.toast(
          `Copied ${result.length} character${result.length === 1 ? "" : "s"}`,
          { kind: "success" },
        );
      } catch (clipErr) {
        ctx.toast(errorMessage(clipErr), { kind: "error" });
      }
    })
      .then((un) => disposers.push(un))
      .catch(() => {});
    listen(EV_CAPTURE_CANCELED, () => {
      setStatus((s) => (s === "scanning" ? "idle" : s));
    })
      .then((un) => disposers.push(un))
      .catch(() => {});
    return () => disposers.forEach((d) => d());
  }, [ctx]);

  async function scan() {
    setStatus("scanning");
    setError(null);
    try {
      // Hides the launcher so the screen underneath is scannable.
      await launchCapture("ocr");
    } catch (err) {
      setStatus("error");
      setError(errorMessage(err));
    }
  }

  async function copy() {
    try {
      await writeText(text);
      ctx.toast("Copied to clipboard", { kind: "success" });
    } catch (err) {
      ctx.toast(errorMessage(err), { kind: "error" });
    }
  }

  function clear() {
    const discarded = text;
    setConfirmClear(false);
    setText("");
    setError(null);
    setStatus("idle");
    // The region it came from is long gone, so the scan is only recoverable
    // from here. Ctrl+Z puts it back (see core/undo).
    registerUndo("the scan", () => {
      setText(discarded);
      setStatus("done");
      setError(null);
    });
  }

  const hasText = text !== "";

  return (
    <div className="bk-ocr">
      <div className="bk-ocr__bar">
        <button
          type="button"
          className="bk-action bk-action--inline"
          onClick={scan}
          disabled={status === "scanning"}
        >
          <OcrIcon size={18} />
          <span>{status === "scanning" ? "Drag a region…" : hasText ? "Scan again" : "Scan region"}</span>
        </button>
        <span className={`bk-ocr__state bk-ocr__state--${status}`} aria-live="polite">
          <span className="bk-ocr__dot" aria-hidden="true" />
          {status === "scanning"
            ? "WAITING FOR SELECTION"
            : status === "error"
              ? `FAILED — ${error ?? "unknown"}`
              : status === "empty"
                ? "NO TEXT IN THAT REGION"
                : status === "done"
                  ? "COPIED TO CLIPBOARD"
                  : "READY"}
        </span>
      </div>

      <div className="bk-ocr__result">
        <div className="bk-ocr__resultbar">
          <span className="bk-label">RESULT</span>
          {confirmClear ? (
            <>
              <span className="bk-ocr__counts bk-label bk-label--danger">DISCARD THIS SCAN?</span>
              <button type="button" className="bk-btn bk-btn--sm" onClick={clear}>
                Clear
              </button>
              <button
                type="button"
                className="bk-btn bk-btn--sm"
                onClick={() => setConfirmClear(false)}
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              {hasText && (
                <span className="bk-ocr__counts">
                  {text.length} chars · {countWords(text)} words · {countLines(text)} lines
                </span>
              )}
              <button
                type="button"
                className="bk-btn bk-btn--sm"
                onClick={() => setConfirmClear(true)}
                disabled={!hasText}
              >
                Clear
              </button>
              <button
                type="button"
                className="bk-btn bk-btn--sm bk-btn--accent"
                onClick={copy}
                disabled={!hasText}
              >
                Copy
              </button>
            </>
          )}
        </div>

        {hasText ? (
          <textarea
            className="bk-ocr__text"
            readOnly
            value={text}
            spellCheck={false}
            aria-label="Recognized text"
          />
        ) : (
          <div className="bk-ocr__placeholder">
            <OcrIcon size={30} />
            <span className="bk-label">
              {status === "empty" ? "THAT REGION HAD NO READABLE TEXT" : "NO SCAN YET"}
            </span>
            <em>
              {status === "empty"
                ? "Try a tighter crop, or a region with more contrast."
                : "Scan a region — the text lands here and on your clipboard."}
            </em>
          </div>
        )}
      </div>
    </div>
  );
}
