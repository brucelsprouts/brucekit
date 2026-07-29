import type { ToolModule } from "../types";
import { DcheckIcon } from "./icon";
import { DcheckPanel } from "./DcheckPanel";

/**
 * dcheck — network dropout monitor as a brucekit module, ported from
 * github.com/brucelsprouts/dcheck. The pinger runs in a Rust background
 * thread that only exists while the module is enabled.
 */
const dcheck: ToolModule = {
  id: "dcheck",
  name: "dcheck",
  description: "Network dropout monitor — live ping graph",
  keywords: ["ping", "network", "wifi", "latency", "dropout", "disconnect", "uptime", "monitor"],
  icon: DcheckIcon,
  kind: "panel",
  // A ping graph is only useful if it can stay on screen while you work in the
  // window you're actually testing, so this panel opts out of click-away
  // dismissal. Esc and the close button still close it.
  keepOpen: true,
  // The widest room of any panel: the graph is the module, and it plots more
  // history the more horizontal space it gets.
  panelSize: { width: 860, height: 620 },
  render(ctx) {
    return <DcheckPanel ctx={ctx} />;
  },
};

export default dcheck;
