import type { ToolModule } from "../types";
import { errorMessage } from "../../core/ipc";
import { launchCapture } from "../../core/overlay";
import { OcrIcon } from "./icon";

/**
 * OCR grab (spec §10) — an `action` tool.
 *
 * Selecting the tile closes the launcher and starts the freeze-frame flow: Rust
 * snapshots the active monitor, the overlay shows the frozen frame with a
 * crosshair, the user drags a rectangle, and the cropped region is OCR'd to the
 * clipboard. All heavy lifting is async Rust; this module only kicks it off.
 */
const ocrGrab: ToolModule = {
  id: "ocr-grab",
  name: "OCR grab",
  description: "Drag a box to copy on-screen text",
  keywords: ["ocr", "text", "recognize", "screenshot", "scan", "copy"],
  icon: OcrIcon,
  kind: "action",
  async activate(ctx) {
    ctx.closeLauncher();
    try {
      await launchCapture("ocr");
    } catch (err) {
      ctx.toast(errorMessage(err), { kind: "error" });
    }
  },
};

export default ocrGrab;
