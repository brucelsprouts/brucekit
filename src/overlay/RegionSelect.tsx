import { useRef, useState, type MouseEvent } from "react";
import { emit } from "@tauri-apps/api/event";
import { invoke, errorMessage, type CaptureMeta, type Rect } from "../core/ipc";
import { EV_OCR_DONE, type OcrDonePayload } from "../core/events";
import { endCapture, restoreLauncher } from "../core/overlay";

type Pt = { x: number; y: number };

const normalize = (a: Pt, b: Pt) => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  width: Math.abs(a.x - b.x),
  height: Math.abs(a.y - b.y),
});

/**
 * OCR grab (spec §10): drag a rectangle over the frozen frame, Rust crops +
 * OCRs it, and the result is handed back to the launcher's OCR panel — which
 * reopens to show the text (and copies it to the clipboard).
 */
export function RegionSelect({ meta }: { meta: CaptureMeta }) {
  const [start, setStart] = useState<Pt | null>(null);
  const [cur, setCur] = useState<Pt | null>(null);
  const busy = useRef(false);

  const box = start && cur ? normalize(start, cur) : null;

  function onDown(e: MouseEvent) {
    if (e.button !== 0) return;
    setStart({ x: e.clientX, y: e.clientY });
    setCur({ x: e.clientX, y: e.clientY });
  }

  function onMove(e: MouseEvent) {
    if (start) setCur({ x: e.clientX, y: e.clientY });
  }

  async function onUp() {
    const sel = box;
    setStart(null);
    setCur(null);
    if (!sel || busy.current || sel.width < 3 || sel.height < 3) return;

    busy.current = true;
    // Map logical CSS pixels to physical frame pixels (DPI-safe).
    const sx = meta.width / window.innerWidth;
    const sy = meta.height / window.innerHeight;
    const rect: Rect = {
      x: Math.round(sel.x * sx),
      y: Math.round(sel.y * sy),
      width: Math.round(sel.width * sx),
      height: Math.round(sel.height * sy),
    };

    let payload: OcrDonePayload;
    try {
      payload = { text: await invoke("ocr_region", { rect }) };
    } catch (err) {
      payload = { text: "", error: errorMessage(err) };
    }
    try {
      await emit(EV_OCR_DONE, payload);
    } catch {
      /* launcher just won't hear about it */
    }
    await restoreLauncher();
    await endCapture();
    busy.current = false;
  }

  return (
    <div className="bk-region" onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp}>
      {!start && (
        <div className="bk-region__hint">
          <span className="bk-label">DRAG TO SELECT · OCR</span>
          <span className="bk-region__sub">esc / right-click to cancel</span>
        </div>
      )}
      {box && (
        <div
          className="bk-region__box"
          style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
        >
          <span className="bk-region__dims">
            {Math.round(box.width)}×{Math.round(box.height)}
          </span>
        </div>
      )}
    </div>
  );
}
