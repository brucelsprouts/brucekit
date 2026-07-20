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
  render(ctx) {
    return <DcheckPanel ctx={ctx} />;
  },
};

export default dcheck;
