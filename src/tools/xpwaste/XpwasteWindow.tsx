import { useMemo } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ToolContext } from "../types";
import { invoke } from "../../core/ipc";
import { toast } from "../../core/toast";
import { makeToolSettings } from "../../core/settings";
import { XpwastePanel } from "./XpwastePanel";

/**
 * The xpwaste window: an ordinary, decorated, taskbar-resident window rather
 * than a view inside the launcher. It exists so the timer can be dragged
 * aside, minimised and alt-tabbed like any other window while you work — the
 * launcher is built to vanish on click-away and can't be that.
 *
 * It owns no chrome of its own. The OS title bar is the drag handle and the
 * minimise / close buttons, and closing only hides the window: the clock lives
 * in Rust and keeps counting regardless.
 */
export function XpwasteWindow() {
  const ctx = useMemo<ToolContext>(
    () => ({
      invoke,
      toast,
      closeLauncher: () => {
        try {
          void getCurrentWindow().hide();
        } catch {
          /* outside a Tauri webview (browser preview) — nothing to hide */
        }
      },
      settings: makeToolSettings("xpwaste"),
    }),
    [],
  );

  return (
    <div className="bk-xpwin" data-window="xpwaste">
      <XpwastePanel ctx={ctx} />
    </div>
  );
}
