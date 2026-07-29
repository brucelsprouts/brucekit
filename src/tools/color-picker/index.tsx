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
  // Sized to the whole panel rather than to an impression of it: the readout
  // and the picker measure 439px together, over 109px of launcher chrome. An
  // earlier 440 guess put the sliders below the fold and made you scroll a
  // panel that has no reason to scroll.
  panelSize: { width: 560, height: 580 },
  render(ctx) {
    return <ColorPanel ctx={ctx} />;
  },
};

export default colorPicker;
