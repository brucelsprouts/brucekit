import type { ReactNode } from "react";
import type { ToolContext, ToolModule } from "../tools/types";
import { ErrorBoundary } from "./ErrorBoundary";

type Props = {
  tool: ToolModule;
  ctx: ToolContext;
  onBack: () => void;
};

/**
 * Hosts a `panel` tool inline (spec §6). The grid collapses and the panel
 * expands here, wrapped in an error boundary (§7). Invoking `render()` is itself
 * guarded so a throw at call time degrades to a toast + fallback, not a crash.
 */
export function ToolHost({ tool, ctx, onBack }: Props) {
  let body: ReactNode;
  try {
    body = tool.render?.(ctx) ?? null;
  } catch (err) {
    console.error(`[brucekit] tool "${tool.id}" render() threw`, err);
    ctx.toast(`${tool.name} failed to open`, { kind: "error" });
    body = (
      <div className="bk-toolcrash" role="alert">
        <span className="bk-label bk-label--danger">TOOL ERROR</span>
        <p className="bk-toolcrash__msg">“{tool.id}” could not render.</p>
      </div>
    );
  }

  return (
    <section className="bk-host">
      <header className="bk-host__bar">
        <button type="button" className="bk-back" onClick={onBack} aria-label="Back to tools">
          ← BACK
        </button>
        <span className="bk-host__title">{"// "}{tool.name}</span>
      </header>
      <div className="bk-host__body">
        <ErrorBoundary toolId={tool.id}>{body}</ErrorBoundary>
      </div>
    </section>
  );
}
