import type { ToolModule } from "../types";
import { ColorIcon } from "./icon";
import { ColorPanel } from "./ColorPanel";

/**
 * Color picker (spec §11) — a `panel` tool. Renders inline in the launcher: a
 * HEX/RGB/HSL toggle, the current swatch + value, a manual picker (hex field +
 * R/G/B sliders), an eyedropper to sample any on-screen pixel, and Copy.
 */
const colorPicker: ToolModule = {
  id: "color-picker",
  name: "Color picker",
  description: "Dial in or eyedrop a color as HEX / RGB / HSL",
  keywords: ["color", "colour", "eyedropper", "eyedrop", "pixel", "hex", "rgb", "hsl", "swatch", "picker"],
  icon: ColorIcon,
  kind: "panel",
  render(ctx) {
    return <ColorPanel ctx={ctx} />;
  },
};

export default colorPicker;
