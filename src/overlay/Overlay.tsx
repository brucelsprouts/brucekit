import { useEffect, useState } from "react";
import { invoke, errorMessage, type CaptureFrame } from "../core/ipc";
import { endCapture } from "../core/overlay";
import { RegionSelect } from "./RegionSelect";
import { Eyedropper } from "./Eyedropper";

/**
 * The on-demand fullscreen capture window (spec §3.2 / §3.3). On mount it pulls
 * the frozen frame from Rust and shows it as a static backdrop, then hands off to
 * the region selector (OCR) or eyedropper (color) per the active mode.
 */
export function Overlay() {
  const [frame, setFrame] = useState<CaptureFrame | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke("get_capture")
      .then(setFrame)
      .catch((err) => setError(errorMessage(err)));
  }, []);

  // Esc or right-click aborts the capture.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") void endCapture();
    }
    function onCtx(e: Event) {
      e.preventDefault();
      void endCapture();
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("contextmenu", onCtx);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("contextmenu", onCtx);
    };
  }, []);

  if (error) {
    return (
      <div className="bk-overlay bk-overlay--error" data-window="overlay">
        <span className="bk-label bk-label--danger">CAPTURE ERROR</span>
        <code>{error}</code>
      </div>
    );
  }

  if (!frame) return <div className="bk-overlay" data-window="overlay" />;

  return (
    <div
      className="bk-overlay"
      data-window="overlay"
      style={{ backgroundImage: `url(${frame.dataUrl})` }}
    >
      {frame.mode === "ocr" ? (
        <RegionSelect frame={frame} />
      ) : (
        <Eyedropper frame={frame} />
      )}
    </div>
  );
}
