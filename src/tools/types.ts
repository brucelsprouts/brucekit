import type { FC, ReactNode } from "react";
import type { TauriInvoke } from "../core/ipc";
import type { ToastOptions } from "../core/toast";
import type { ToolSettings } from "../core/settings";

export type { ToastOptions, ToolSettings };

/** Everything a tool is handed at activate/render time. */
export type ToolContext = {
  /** Typed wrapper over Tauri `invoke`. */
  invoke: TauriInvoke;
  toast: (msg: string, opts?: ToastOptions) => void;
  closeLauncher: () => void;
  /** Namespaced get/set for THIS tool only. */
  settings: ToolSettings;
};

export type ToolKind = "action" | "panel";

export interface ToolModule {
  /** Stable unique id, e.g. "ocr-grab". */
  id: string;
  /** Display name. */
  name: string;
  /** Subtitle + search text. */
  description?: string;
  /** Extra search terms. */
  keywords?: string[];
  /** Monochrome SVG icon component. */
  icon: FC<{ size?: number }>;
  kind: ToolKind;
  /**
   * Panels meant to be *watched* rather than used and dismissed. While one is
   * open the launcher stops closing on click-away, so it can sit on screen
   * while you work elsewhere. Esc, the close button, the tray toggle, and the
   * hotkey all still close it.
   */
  keepOpen?: boolean;
  /** action tools: run a native flow, no inline UI. */
  activate?: (ctx: ToolContext) => void | Promise<void>;
  /** panel tools: render inline UI hosted by the launcher. */
  render?: (ctx: ToolContext) => ReactNode;
}
