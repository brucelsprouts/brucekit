/** Event names shared between Rust and the two windows. Keep in sync with Rust. */

/** Overlay → launcher: a color was picked ({ r, g, b }). */
export const EV_COLOR_PICKED = "brucekit://color-picked";

/** Tray → launcher: open the Settings view. */
export const EV_OPEN_SETTINGS = "brucekit://open-settings";

/** Hotkey/tray → launcher: freshly opened, reset to the tool grid. */
export const EV_RESET = "brucekit://reset";

/** Rust → overlay: a fresh capture is stored; refetch the frame + mode. */
export const EV_CAPTURE_READY = "brucekit://capture-ready";

/** Overlay → launcher: an OCR scan finished ({ text, error? }). */
export const EV_OCR_DONE = "brucekit://ocr-done";
export type OcrDonePayload = { text: string; error?: string };

/** Overlay → launcher: the user aborted the capture (Esc / right-click). */
export const EV_CAPTURE_CANCELED = "brucekit://capture-canceled";
