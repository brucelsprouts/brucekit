import { getCurrentWindow, Window } from "@tauri-apps/api/window";
import { invoke } from "./ipc";
import type { CaptureMode } from "./ipc";

export { EV_COLOR_PICKED } from "./events";

/**
 * Kick off a freeze-frame capture from the launcher: hide the launcher, then ask
 * Rust to snapshot the active monitor and show the overlay (spec §3.3).
 */
export async function launchCapture(mode: CaptureMode): Promise<void> {
  await getCurrentWindow().hide();
  await invoke("capture_monitor", { mode });
}

/** Hide the overlay and drop the frozen frame. */
export async function endCapture(): Promise<void> {
  await invoke("cancel_capture");
}

/** Bring the launcher back to the foreground (used after a color pick). */
export async function restoreLauncher(): Promise<void> {
  const launcher = await Window.getByLabel("launcher");
  if (launcher) {
    await launcher.show();
    await launcher.setFocus();
  }
}
