import type { ToolModule } from "../types";
import { XpwasteIcon } from "./icon";

/**
 * xpwaste — pomodoro focus timer as a brucekit module, ported from
 * github.com/brucelsprouts/xpwaste. The countdown itself runs in a Rust
 * background thread that only exists while the module is enabled, so a session
 * keeps time with the launcher hidden and can still announce itself when it
 * ends.
 *
 * Launching it opens a window of its own (`XpwasteWindow`) instead of a view
 * in the launcher. A timer is something you keep beside the work, and the
 * launcher is deliberately a transient surface that can't be moved aside,
 * minimised, or left up while you switch tabs.
 */
const xpwaste: ToolModule = {
  id: "xpwaste",
  name: "xpwaste",
  description: "Pomodoro focus timer — sessions, cycles, and a focus log",
  keywords: [
    "pomodoro",
    "timer",
    "focus",
    "study",
    "break",
    "session",
    "countdown",
    "productivity",
  ],
  icon: XpwasteIcon,
  kind: "action",
  async activate(ctx) {
    await ctx.invoke("open_xpwaste_window");
    // The launcher has done its job; the timer window takes over from here.
    ctx.closeLauncher();
  },
};

export default xpwaste;
