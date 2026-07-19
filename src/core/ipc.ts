import { invoke as tauriInvoke } from "@tauri-apps/api/core";

/**
 * The complete, typed Rust <-> JS command surface (spec §13).
 * Native flows are async and return `Result`; a rejected promise carries a
 * typed error string that callers surface as a toast.
 */

export type Rect = { x: number; y: number; width: number; height: number };
export type Point = { x: number; y: number };
export type Rgb = { r: number; g: number; b: number };

export type CaptureMode = "ocr" | "color";
export type CaptureDims = { width: number; height: number };
export type CaptureFrame = CaptureDims & { dataUrl: string; mode: CaptureMode };

export type Config = {
  hotkey: string;
  launchOnStartup: boolean;
  tools: Record<string, Record<string, unknown>>;
};

type CommandMap = {
  /** Freeze the monitor under the cursor into Rust memory and show the overlay. */
  capture_monitor: { args: { mode: CaptureMode }; result: CaptureDims };
  /** Overlay pulls the frozen frame (as a data URL) + active mode on mount. */
  get_capture: { args: void; result: CaptureFrame };
  /** Crop the frozen frame to `rect`, OCR it, return recognized text. */
  ocr_region: { args: { rect: Rect }; result: string };
  /** Read one pixel from the frozen frame. */
  pick_color: { args: { point: Point }; result: Rgb };
  /** Discard the frozen frame and hide the overlay (Esc / click-away). */
  cancel_capture: { args: void; result: null };

  get_config: { args: void; result: Config };
  set_config: { args: { config: Config }; result: Config };
  set_hotkey: { args: { chord: string }; result: null };
  set_autostart: { args: { enabled: boolean }; result: null };
};

type Args<K extends keyof CommandMap> = CommandMap[K]["args"];

export type TauriInvoke = <K extends keyof CommandMap>(
  cmd: K,
  ...args: Args<K> extends void ? [] : [Args<K>]
) => Promise<CommandMap[K]["result"]>;

/** Typed wrapper over Tauri's `invoke`. */
export const invoke: TauriInvoke = ((cmd: string, args?: unknown) =>
  tauriInvoke(cmd, args as Record<string, unknown> | undefined)) as TauriInvoke;

/** Normalize an unknown thrown value (string, Error, or serialized enum) to text. */
export function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return "Unexpected error";
}
