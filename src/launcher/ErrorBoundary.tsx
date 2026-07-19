import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { toolId: string; children: ReactNode };
type State = { error: Error | null };

/**
 * Crash isolation, UI layer (spec §7). A render/runtime crash in one tool shows
 * a compact fallback *inside that tool's panel only*; the launcher and every
 * sibling tool keep running.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[brucekit] tool "${this.props.toolId}" crashed`, error, info);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      return (
        <div className="bk-toolcrash" role="alert">
          <span className="bk-label bk-label--danger">TOOL ERROR</span>
          <p className="bk-toolcrash__msg">
            “{this.props.toolId}” hit a snag and was isolated.
          </p>
          <code className="bk-toolcrash__detail">{error.message}</code>
        </div>
      );
    }
    return this.props.children;
  }
}
