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
  /** Module ids pinned, in pin order: sorted to the front of the grid + tray. */
  pinnedModules: string[];
  /** Per-module global hotkeys: module id → accelerator chord. */
  moduleHotkeys: Record<string, string>;
  /** Eco mode: all background services paused, module toggles untouched. */
  ecoMode: boolean;
  /** Last user-dragged *panel* size (logical px); null until first resize. */
  launcherSize: { width: number; height: number } | null;
  tools: Record<string, Record<string, unknown>>;
};

/** Where an image clip's pixels live, relative to the clipstack image dir. */
export type ClipImage = {
  width: number;
  height: number;
  /** Full-resolution PNG. */
  file: string;
  /** Downscaled PNG the panel previews. */
  thumb: string;
  /** Fingerprint of the source pixels. */
  hash: string;
};

/** One clipboard history entry (clipstack module). */
export type Clip = {
  id: number;
  /** Plain text; for an image clip, its label ("Image 800×600"). */
  text: string;
  /**
   * Styling captured with the text, restored on copy. Deliberately never
   * rendered — the panel shows `text` and this only goes back to the clipboard.
   */
  html?: string;
  /** Present on image clips only. */
  image?: ClipImage;
  pinned: boolean;
  /** Unix millis. */
  createdAt: number;
};

export type PingStatus = "ok" | "high" | "drop";

/** One ping sample (dcheck module). `ms` is -1 on a drop. */
export type PingEntry = { ts: number; ms: number; status: PingStatus };

/** One tracked stretch of per-app screen time (runtime module). */
export type UsageSession = {
  /** Unix millis. */
  startTs: number;
  /** Unix millis of the last accumulation. */
  endTs: number;
  /** Foreground millis per app (exe name, extension stripped). */
  apps: Record<string, number>;
};

/** The usage ledger: the live session plus the previous run's session. */
export type AppUsage = {
  current: UsageSession | null;
  last: UsageSession | null;
};

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
  /** Bind (or clear with null) a per-module launch hotkey. */
  set_module_hotkey: { args: { id: string; chord: string | null }; result: Config };
  /** Pin/unpin a module: reorders the grid and rebuilds the tray menu. */
  set_module_pinned: { args: { id: string; pinned: boolean }; result: Config };
  /** Eco mode: pause/resume every background service in one flip. */
  set_eco_mode: { args: { enabled: boolean }; result: Config };
  /** Persist the size the user dragged a *panel* to (logical px). */
  set_launcher_size: { args: { width: number; height: number }; result: null };
  /** Resize the launcher window: grid fit-to-content, or a panel's stored size. */
  resize_launcher: { args: { width: number; height: number }; result: null };
  /** Pin the launcher against click-away dismissal (watchable panels). */
  set_keep_open: { args: { enabled: boolean }; result: null };

  /** clipstack: list clips (pinned first, newest first), optionally filtered. */
  clips_list: { args: { search: string | null }; result: Clip[] };
  /**
   * clipstack: put a clip back on the OS clipboard in the flavor it was
   * captured in. `plain` strips the styling off a formatted clip.
   */
  clips_copy: { args: { id: number; plain?: boolean }; result: null };
  /** clipstack: an image clip's PNG bytes — thumbnail unless `thumb` is false. */
  clips_image: { args: { id: number; thumb?: boolean }; result: ArrayBuffer };
  clips_toggle_pin: { args: { id: number }; result: null };
  clips_delete: { args: { id: number }; result: null };
  clips_clear: { args: void; result: null };
  /** clipstack: put deleted clips back (undo). Known ids are skipped. */
  clips_restore: { args: { clips: Clip[] }; result: null };
  /** Re-applies the persisted history cap; resolves to the surviving count. */
  clips_apply_limit: { args: void; result: number };
  clips_open_folder: { args: void; result: null };

  /** dcheck: ping history, oldest first. null/0 rangeSec = everything. */
  dcheck_history: { args: { rangeSec: number | null }; result: PingEntry[] };
  /** dcheck: wipe in-memory history and the on-disk log. */
  dcheck_clear: { args: void; result: null };

  /** runtime: seconds since the machine booted. */
  runtime_uptime: { args: void; result: number };
  /** runtime: per-app screen time — current session + the previous run's. */
  runtime_apps: { args: void; result: AppUsage };
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
