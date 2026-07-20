import type { ToolModule } from "../types";
import { RuntimeIcon } from "./icon";
import { RuntimePanel } from "./RuntimePanel";

/**
 * runtime — how long things have been running (docs/module-ideas.md). Formerly
 * `pulse`, which led with machine vitals; the question it kept getting opened
 * for was "what have I had running, and for how long?", so app time is the
 * whole subject now and the vitals are gone.
 *
 * A Rust thread does the tracking in the background while the module is
 * enabled (like dcheck's pinger); toggling the module off or turning eco mode
 * on stops it entirely.
 */
const runtime: ToolModule = {
  id: "runtime",
  name: "runtime",
  description: "How long each app has been running",
  keywords: [
    "uptime",
    "runtime",
    "screen time",
    "app time",
    "usage",
    "foreground",
    "tracking",
  ],
  icon: RuntimeIcon,
  kind: "panel",
  render(ctx) {
    return <RuntimePanel ctx={ctx} />;
  },
};

export default runtime;
