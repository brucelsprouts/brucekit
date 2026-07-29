import type { ToolModule } from "../types";
import { ClipsIcon } from "./icon";
import { ClipsPanel } from "./ClipsPanel";

/**
 * ClipStack — clipboard history as a brucekit module, ported from
 * github.com/brucelsprouts/clipstack (text clips). The capture itself runs in
 * a Rust background thread that only exists while the module is enabled.
 */
const clipstack: ToolModule = {
  id: "clipstack",
  name: "ClipStack",
  description: "Clipboard history — search, pin, re-copy",
  keywords: ["clipboard", "history", "copy", "paste", "clips", "stack", "pin"],
  icon: ClipsIcon,
  kind: "panel",
  // Tall: the clip list is the point, and image thumbs want the width.
  panelSize: { width: 720, height: 560 },
  render(ctx) {
    return <ClipsPanel ctx={ctx} />;
  },
};

export default clipstack;
