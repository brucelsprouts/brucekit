import type { ToolModule } from "../types";
import { OcrIcon } from "./icon";
import { OcrPanel } from "./OcrPanel";

/**
 * OCR grab (spec §10) — a `panel` tool. Selecting the tile opens the OCR
 * screen; "Scan region" hides the launcher and starts the freeze-frame flow
 * (Rust snapshots the monitor, the overlay takes a drag), then the launcher
 * reopens here with the recognized text shown and copied to the clipboard.
 */
const ocrGrab: ToolModule = {
  id: "ocr-grab",
  name: "OCR grab",
  description: "Scan a screen region into text",
  keywords: ["ocr", "text", "recognize", "screenshot", "scan", "copy"],
  icon: OcrIcon,
  kind: "panel",
  render(ctx) {
    return <OcrPanel ctx={ctx} />;
  },
};

export default ocrGrab;
