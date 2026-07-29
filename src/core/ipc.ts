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

/** A launcher window size in logical pixels. */
export type WindowSize = { width: number; height: number };

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
  /** Legacy single panel size (logical px); the fallback for an unsized view. */
  launcherSize: WindowSize | null;
  /**
   * Last user-dragged size per panel view, keyed by view id — a module id, or
   * `"settings"`. Absent until that particular view is first dragged.
   */
  launcherSizes: Record<string, WindowSize>;
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

/** Which kind of session the xpwaste timer is on. */
export type Phase = "focus" | "shortBreak" | "longBreak";

/**
 * The xpwaste timer, exactly as the panel renders it. The clock lives in Rust
 * so a session survives the launcher being hidden, which means the webview
 * holds no countdown of its own that could drift out of step with it.
 */
export type TimerSnapshot = {
  phase: Phase;
  remainingSec: number;
  totalSec: number;
  running: boolean;
  /** Focus sessions banked toward the current cycle. */
  cyclesCompleted: number;
  cycleLength: number;
  /** Active seconds in the focus session on screen (paused time excluded). */
  activeSec: number;
  /** False when the module is off or eco mode is on — the clock is stopped. */
  ticking: boolean;
};

/** One logged stretch of focus (xpwaste module). Active time only. */
export type FocusEntry = {
  id: number;
  /** Unix millis. */
  startTs: number;
  endTs: number;
  seconds: number;
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
  /**
   * Persist the size the user dragged a *panel* to (logical px), under that
   * panel's view id — a module id, or `"settings"`.
   */
  set_launcher_size: { args: { view: string } & WindowSize; result: null };
  /** Resize the launcher window: grid fit-to-content, or a panel's stored size. */
  resize_launcher: { args: WindowSize; result: null };
  /** Pin the launcher against click-away dismissal (watchable panels). */
  set_keep_open: { args: { enabled: boolean }; result: null };

  /** clipstack: list clips (pinned first, newest first), optionally filtered. */
  clips_list: { args: { search: string | null }; result: Clip[] };
  /**
   * clipstack: put a clip back on the OS clipboard in the flavor it was
   * captured in. `plain` strips the styling off a formatted clip.
   */
  clips_copy: { args: { id: number; plain?: boolean }; result: null };
  /**
   * clipstack: an image clip's PNG bytes — thumbnail unless `thumb` is false.
   * Run the result through `toBytes` before treating it as binary.
   */
  clips_image: { args: { id: number; thumb?: boolean }; result: RawBytes };
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

  /** xpwaste: the timer as it stands. Every control below returns it too. */
  xpwaste_state: { args: void; result: TimerSnapshot };
  /** Start or resume. A no-op while the service is stopped (module off / eco). */
  xpwaste_start: { args: void; result: TimerSnapshot };
  /** Pause, banking the focus time earned so far. */
  xpwaste_pause: { args: void; result: TimerSnapshot };
  /** End this session early and move to the next one. */
  xpwaste_skip: { args: void; result: TimerSnapshot };
  /** Back to the start of this phase, cycle count cleared. */
  xpwaste_reset: { args: void; result: TimerSnapshot };
  /** Jump straight to a phase (the three session buttons). */
  xpwaste_set_phase: { args: { phase: Phase }; result: TimerSnapshot };
  /** Nudge the cycle counter by hand (the − / + controls). */
  xpwaste_bump_cycle: { args: { delta: number }; result: TimerSnapshot };
  /** Adopt freshly saved durations, resizing the current session to match. */
  xpwaste_apply_settings: { args: void; result: TimerSnapshot };
  /** xpwaste: the focus log, oldest first. */
  xpwaste_history: { args: void; result: FocusEntry[] };
  xpwaste_delete_entry: { args: { id: number }; result: null };
  xpwaste_clear_history: { args: void; result: null };
  /** Open a file picker for the alert sound; null when dismissed. */
  xpwaste_pick_sound: { args: void; result: string | null };
  /** Play the configured alert once. */
  xpwaste_test_sound: { args: void; result: null };
};

type Args<K extends keyof CommandMap> = CommandMap[K]["args"];

export type TauriInvoke = <K extends keyof CommandMap>(
  cmd: K,
  ...args: Args<K> extends void ? [] : [Args<K>]
) => Promise<CommandMap[K]["result"]>;

/** Typed wrapper over Tauri's `invoke`. */
export const invoke: TauriInvoke = ((cmd: string, args?: unknown) =>
  tauriInvoke(cmd, args as Record<string, unknown> | undefined)) as TauriInvoke;

/** What a command returning raw bytes can arrive as on the JS side. */
export type RawBytes = ArrayBuffer | ArrayBufferView | number[];

/**
 * Normalize a raw-byte command result to a `Uint8Array`.
 *
 * Tauri delivers a `tauri::ipc::Response` as an `ArrayBuffer` over the custom
 * protocol, but as a plain `number[]` when the payload falls back to JSON. Most
 * consumers never notice, because `new Uint8ClampedArray(x)` accepts both —
 * but `new Blob([x])` does *not* fail on an array, it stringifies it into a
 * text blob, and the resulting object URL renders as a broken image. Normalize
 * before doing anything that treats the value as binary.
 */
export function toBytes(payload: RawBytes): Uint8Array<ArrayBuffer> {
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  if (ArrayBuffer.isView(payload)) {
    // The cast narrows away SharedArrayBuffer, which no IPC payload can be.
    return new Uint8Array(payload.buffer as ArrayBuffer, payload.byteOffset, payload.byteLength);
  }
  return new Uint8Array(payload);
}

/** Normalize an unknown thrown value (string, Error, or serialized enum) to text. */
export function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return "Unexpected error";
}
