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
export type CaptureMeta = CaptureDims & {
  mode: CaptureMode;
  /** Monotonic capture id — keys per-session overlay state across window reuse. */
  seq: number;
};

export type Config = {
  hotkey: string;
  launchOnStartup: boolean;
  /** Module ids toggled off: hidden from the grid, background services stopped. */
  disabledModules: string[];
  tools: Record<string, Record<string, unknown>>;
};

/** One clipboard history entry (clipstack module). */
export type Clip = {
  id: number;
  text: string;
  pinned: boolean;
  /** Unix millis. */
  createdAt: number;
};

export type PingStatus = "ok" | "high" | "drop";

/** One ping sample (dcheck module). `ms` is -1 on a drop. */
export type PingEntry = { ts: number; ms: number; status: PingStatus };

type CommandMap = {
  /** Freeze the monitor under the cursor into Rust memory and show the overlay. */
  capture_monitor: { args: { mode: CaptureMode }; result: CaptureDims };
  /** Overlay pulls the frozen frame's metadata on each capture-ready signal. */
  get_capture: { args: void; result: CaptureMeta };
  /** Raw RGBA8 pixels of the frozen frame (bytes over IPC, painted to canvas). */
  get_capture_pixels: { args: void; result: ArrayBuffer };
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
  /** Toggle a module: persists + starts/stops its background service. */
  set_module_enabled: { args: { id: string; enabled: boolean }; result: Config };

  /** clipstack: list clips (pinned first, newest first), optionally filtered. */
  clips_list: { args: { search: string | null }; result: Clip[] };
  /** clipstack: write a clip's text back to the OS clipboard. */
  clips_copy: { args: { id: number }; result: null };
  clips_toggle_pin: { args: { id: number }; result: null };
  clips_delete: { args: { id: number }; result: null };
  clips_clear: { args: void; result: null };

  /** dcheck: ping history, oldest first. null/0 rangeSec = everything. */
  dcheck_history: { args: { rangeSec: number | null }; result: PingEntry[] };
  /** dcheck: wipe in-memory history and the on-disk log. */
  dcheck_clear: { args: void; result: null };
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
