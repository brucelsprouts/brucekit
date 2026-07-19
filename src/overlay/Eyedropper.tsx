import { useRef, useState, type MouseEvent, type RefObject } from "react";
import { emit } from "@tauri-apps/api/event";
import { invoke, errorMessage, type CaptureMeta, type Rgb } from "../core/ipc";
import { toast } from "../core/toast";
import { EV_COLOR_PICKED, endCapture, restoreLauncher } from "../core/overlay";
import { rgbToHex } from "../tools/color-picker/color";

const LOUPE_PX = 132;
const CELLS = 15; // odd, so there is a centered pixel

type Props = {
  meta: CaptureMeta;
  /** Frozen frame at native size, rasterized once by the overlay. */
  srcRef: RefObject<HTMLCanvasElement | null>;
};

/** Color picker (spec §11): magnifier loupe + live readout over the frozen frame. */
export function Eyedropper({ meta, srcRef }: Props) {
  const loupeRef = useRef<HTMLCanvasElement | null>(null);
  const [pos, setPos] = useState<Pt | null>(null);
  const [rgb, setRgb] = useState<Rgb | null>(null);
  const busy = useRef(false);

  function toPhysical(clientX: number, clientY: number): Pt {
    return {
      x: Math.floor((clientX * meta.width) / window.innerWidth),
      y: Math.floor((clientY * meta.height) / window.innerHeight),
    };
  }

  function sample(px: number, py: number): Rgb | null {
    const g = srcRef.current?.getContext("2d", { willReadFrequently: true });
    if (!g) return null;
    const x = Math.max(0, Math.min(meta.width - 1, px));
    const y = Math.max(0, Math.min(meta.height - 1, py));
    const d = g.getImageData(x, y, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2] };
  }

  function drawLoupe(px: number, py: number) {
    const src = srcRef.current;
    const g = loupeRef.current?.getContext("2d");
    if (!src || !g) return;
    const half = Math.floor(CELLS / 2);
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, LOUPE_PX, LOUPE_PX);
    g.drawImage(src, px - half, py - half, CELLS, CELLS, 0, 0, LOUPE_PX, LOUPE_PX);
    const cell = LOUPE_PX / CELLS;
    // Dark halo + white ring: readable over any pixel color.
    g.strokeStyle = "rgba(0, 0, 0, 0.8)";
    g.lineWidth = 3;
    g.strokeRect(half * cell + 0.5, half * cell + 0.5, cell - 1, cell - 1);
    g.strokeStyle = "rgba(255, 255, 255, 0.95)";
    g.lineWidth = 1.5;
    g.strokeRect(half * cell + 0.5, half * cell + 0.5, cell - 1, cell - 1);
  }

  function onMove(e: MouseEvent) {
    setPos({ x: e.clientX, y: e.clientY });
    const p = toPhysical(e.clientX, e.clientY);
    const s = sample(p.x, p.y);
    if (s) setRgb(s);
    drawLoupe(p.x, p.y);
  }

  async function onClick(e: MouseEvent) {
    if (busy.current) return;
    busy.current = true;
    const point = toPhysical(e.clientX, e.clientY);
    try {
      // Rust reads the authoritative pixel from the frozen frame.
      const picked = await invoke("pick_color", { point });
      await emit(EV_COLOR_PICKED, picked);
    } catch (err) {
      toast(errorMessage(err), { kind: "error" });
    } finally {
      await restoreLauncher();
      await endCapture();
      busy.current = false;
    }
  }

  // Keep the loupe fully on-screen near the right/bottom edges.
  const loupeStyle = pos
    ? {
        left: Math.min(pos.x + 20, window.innerWidth - LOUPE_PX - 16),
        top: Math.min(pos.y + 20, window.innerHeight - LOUPE_PX - 52),
      }
    : undefined;

  return (
    <div className="bk-eyedropper" onMouseMove={onMove} onClick={onClick}>
      {!pos && (
        <div className="bk-region__hint">
          <span className="bk-label">CLICK TO PICK · COLOR</span>
          <span className="bk-region__sub">esc / right-click to cancel</span>
        </div>
      )}
      {pos && (
        <div className="bk-loupe" style={loupeStyle}>
          <canvas
            ref={loupeRef}
            width={LOUPE_PX}
            height={LOUPE_PX}
            className="bk-loupe__canvas"
          />
          <div className="bk-loupe__readout">
            <span
              className="bk-swatch bk-swatch--mini"
              style={{ background: rgb ? rgbToHex(rgb) : "#000" }}
            />
            <code>{rgb ? rgbToHex(rgb) : "#------"}</code>
          </div>
        </div>
      )}
    </div>
  );
}

type Pt = { x: number; y: number };
