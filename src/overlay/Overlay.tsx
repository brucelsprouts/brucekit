import { useCallback, useEffect, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { invoke, errorMessage, type CaptureMeta } from "../core/ipc";
import { EV_CAPTURE_CANCELED, EV_CAPTURE_READY } from "../core/events";
import { endCapture, restoreLauncher } from "../core/overlay";
import { RegionSelect } from "./RegionSelect";
import { Eyedropper } from "./Eyedropper";

/**
 * The fullscreen capture window (spec §3.2 / §3.3). It pulls the frozen frame
 * from Rust — metadata plus raw RGBA bytes painted straight into a canvas (no
 * PNG/base64 round-trip) — then hands off to the region selector (OCR) or
 * eyedropper (color) per the active mode.
 *
 * The window is created hidden at startup and *reused* for every capture, so
 * mount-time state is never trusted: each `EV_CAPTURE_READY` refetches the
 * frame, and the mode components are keyed by capture `seq` so drag/busy state
 * from a previous session can never leak into the next one.
 */
export function Overlay() {
  const [meta, setMeta] = useState<CaptureMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Frozen frame at native size — the sampling source for the eyedropper.
  const srcRef = useRef<HTMLCanvasElement | null>(null);
  // The visible backdrop canvas (CSS-scaled to the viewport).
  const viewRef = useRef<HTMLCanvasElement | null>(null);

  const load = useCallback(() => {
    setMeta(null);
    setError(null);
    srcRef.current = null;
    void (async () => {
      try {
        const m = await invoke("get_capture");
        const buf = await invoke("get_capture_pixels");
        const src = document.createElement("canvas");
        src.width = m.width;
        src.height = m.height;
        src
          .getContext("2d")
          ?.putImageData(
            new ImageData(new Uint8ClampedArray(buf), m.width, m.height),
            0,
            0,
          );
        srcRef.current = src;
        setMeta(m);
      } catch (err) {
        const msg = errorMessage(err);
        // Expected when the pre-created window mounts before any capture.
        if (msg !== "no active capture") setError(msg);
      }
    })();
  }, []);

  useEffect(() => {
    load();
    let dispose = () => {};
    listen(EV_CAPTURE_READY, load)
      .then((un) => {
        dispose = un;
      })
      .catch(() => {});
    return () => dispose();
  }, [load]);

  // Paint the frozen frame into the visible backdrop once it's ready.
  useEffect(() => {
    if (!meta) return;
    const view = viewRef.current;
    const src = srcRef.current;
    if (view && src) view.getContext("2d")?.drawImage(src, 0, 0);
  }, [meta]);

  // Esc or right-click aborts: tell the launcher, bring it back, drop the frame.
  const abort = useCallback(() => {
    void (async () => {
      try {
        await emit(EV_CAPTURE_CANCELED, null);
      } catch {
        /* launcher just won't hear about it */
      }
      try {
        await restoreLauncher();
      } catch {
        /* launcher window may be gone */
      }
      await endCapture();
    })();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") abort();
    }
    function onCtx(e: Event) {
      e.preventDefault();
      abort();
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("contextmenu", onCtx);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("contextmenu", onCtx);
    };
  }, [abort]);

  if (error) {
    return (
      <div className="bk-overlay bk-overlay--error" data-window="overlay">
        <span className="bk-label bk-label--danger">CAPTURE ERROR</span>
        <code>{error}</code>
      </div>
    );
  }

  if (!meta) return <div className="bk-overlay" data-window="overlay" />;

  return (
    <div className="bk-overlay" data-window="overlay">
      <canvas
        ref={viewRef}
        width={meta.width}
        height={meta.height}
        className="bk-overlay__frame"
        aria-hidden="true"
      />
      {meta.mode === "ocr" ? (
        <RegionSelect key={`ocr-${meta.seq}`} meta={meta} />
      ) : (
        <Eyedropper key={`color-${meta.seq}`} meta={meta} srcRef={srcRef} />
      )}
    </div>
  );
}
