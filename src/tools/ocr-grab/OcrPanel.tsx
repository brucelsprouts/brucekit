import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { ToolContext } from "../types";
import { errorMessage } from "../../core/ipc";
import { launchCapture } from "../../core/overlay";
import { OcrIcon } from "./icon";
import {
  EV_CAPTURE_CANCELED,
  EV_OCR_DONE,
  type OcrDonePayload,
} from "../../core/events";

type Status = "idle" | "scanning" | "done" | "empty" | "error";

/**
 * OCR grab panel (spec §10, reworked): "Scan region" hides the launcher and
 * starts the freeze-frame flow; when the drag completes the launcher reopens
 * right here with the recognized text on screen and on the clipboard — every
 * scan has a visible result.
 */
export function OcrPanel({ ctx }: { ctx: ToolContext }) {
  const [status, setStatus] = useState<Status>("idle");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

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

  const statusLine: Record<Status, string> = {
    idle: "READY",
    scanning: "SCANNING — DRAG A REGION",
    done: `OK · ${text.length} CHARS → CLIPBOARD`,
    empty: "NO TEXT FOUND",
    error: `ERROR — ${error ?? "unknown"}`,
  };

  return (
    <div className="bk-ocrpanel">
      <button
        type="button"
        className="bk-action"
        onClick={scan}
        disabled={status === "scanning"}
      >
        <OcrIcon size={18} />
        <span>{status === "scanning" ? "Scanning…" : "Scan region"}</span>
      </button>
      <span
        className={`bk-label bk-ocrpanel__status ${
          status === "error" ? "bk-label--danger" : ""
        }`}
        aria-live="polite"
      >
        {statusLine[status]}
      </span>

      <div className="bk-ocrpanel__result">
        <div className="bk-ocrpanel__resultbar">
          <span className="bk-label">RESULT</span>
          <button type="button" className="bk-btn" onClick={copy} disabled={!text}>
            Copy
          </button>
        </div>
        <textarea
          className="bk-ocrpanel__text"
          readOnly
          value={text}
          placeholder="Recognized text appears here — and lands on your clipboard."
          spellCheck={false}
          aria-label="Recognized text"
        />
      </div>
    </div>
  );
}
