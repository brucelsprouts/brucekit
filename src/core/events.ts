/** Event names shared between Rust and the two windows. Keep in sync with Rust. */

/** Overlay → launcher: a color was picked ({ r, g, b }). */
export const EV_COLOR_PICKED = "brucekit://color-picked";

/** Tray → launcher: open the Settings view. */
export const EV_OPEN_SETTINGS = "brucekit://open-settings";

/** Hotkey/tray → launcher: freshly opened, reset to the tool grid. */
export const EV_RESET = "brucekit://reset";
