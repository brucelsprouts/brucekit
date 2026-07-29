import type { ReactNode } from "react";
import type { ToolContext, ToolModule } from "../tools/types";
import { ErrorBoundary } from "./ErrorBoundary";

type Props = {
  tool: ToolModule;
  ctx: ToolContext;
};

/**
 * Hosts a `panel` tool inline (spec §6). The grid collapses and the panel
 * expands here, wrapped in an error boundary (§7). Invoking `render()` is itself
 * guarded so a throw at call time degrades to a toast + fallback, not a crash.
 *
 * Navigation is not this component's job: back / forward / refresh / close all
 * live in the sysbar chrome, so a panel gets the full width of its own header.
 */
export function ToolHost({ tool, ctx }: Props) {
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

  const Icon = tool.icon;
  return (
    <section className="bk-host">
      <header className="bk-host__bar">
        <span className="bk-host__icon" aria-hidden="true">
          <Icon size={15} />
        </span>
        <span className="bk-host__title">{tool.name}</span>
        <span className="bk-host__desc">{tool.description ?? ""}</span>
        {/* Esc means "close" at the grid and "back" here, and until now nothing
            on screen said which — the footer hint strip that would have
            explained it only renders at the grid, where there is no ambiguity
            to explain. */}
        {tool.keepOpen && (
          <span
            className="bk-host__flag bk-label"
            title="Stays open when you click away, and lets other windows sit over it"
          >
            STAYS OPEN
          </span>
        )}
        <span className="bk-host__hint bk-label">[ESC] BACK</span>
      </header>
      <div className="bk-host__body">
        <ErrorBoundary toolId={tool.id}>{body}</ErrorBoundary>
      </div>
    </section>
  );
}
