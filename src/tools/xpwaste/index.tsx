import type { ToolModule } from "../types";
import { XpwasteIcon } from "./icon";
import { XpwastePanel } from "./XpwastePanel";

/**
 * xpwaste — pomodoro focus timer as a brucekit module, ported from
 * github.com/brucelsprouts/xpwaste. The countdown itself runs in a Rust
 * background thread that only exists while the module is enabled, so a session
 * keeps time with the launcher hidden and can still announce itself when it
 * ends.
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
  kind: "panel",
  // A countdown you can't see is a countdown you don't trust, so this panel
  // opts out of click-away dismissal and sits on screen while you work in the
  // window you're actually focusing in. Esc and the close button still close
  // it — and closing it doesn't stop the clock.
  keepOpen: true,
  // Narrow on purpose: this one sits on screen beside the window you're
  // actually working in, so it should take as little of it as it can.
  panelSize: { width: 620, height: 540 },
  render(ctx) {
    return <XpwastePanel ctx={ctx} />;
  },
};

export default xpwaste;
