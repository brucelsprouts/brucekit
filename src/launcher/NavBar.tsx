type Props = {
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onRefresh: () => void;
  onClose: () => void;
};

/**
 * Window chrome in the sysbar's top-right: back / forward / refresh, then the
 * close control set apart from them. Back and forward mirror mouse buttons 3
 * and 4 and the Esc key exactly — this is the visible face of a stack the
 * launcher already had, not a second history implementation.
 *
 * Pointer-down is stopped here so a click on a control never starts the
 * window drag the sysbar arms.
 */
export function NavBar({
  canGoBack,
  canGoForward,
  onBack,
  onForward,
  onRefresh,
  onClose,
}: Props) {
  return (
    <div
      className="bk-nav"
      onPointerDown={(e) => e.stopPropagation()}
      role="toolbar"
      aria-label="Window controls"
    >
      <button
        type="button"
        className="bk-nav__btn"
        onClick={onBack}
        disabled={!canGoBack}
        aria-label="Back"
        title="Back (Esc)"
      >
        <ChevronIcon dir="left" />
      </button>
      <button
        type="button"
        className="bk-nav__btn"
        onClick={onForward}
        disabled={!canGoForward}
        aria-label="Forward"
        title="Forward"
      >
        <ChevronIcon dir="right" />
      </button>
      <button
        type="button"
        className="bk-nav__btn"
        onClick={onRefresh}
        aria-label="Refresh"
        title="Refresh this view"
      >
        <RefreshIcon />
      </button>
      <span className="bk-nav__sep" aria-hidden="true" />
      <button
        type="button"
        className="bk-nav__btn bk-nav__btn--close"
        onClick={onClose}
        aria-label="Close brucekit"
        title="Close"
      >
        <CloseIcon />
      </button>
    </div>
  );
}

const strokeProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

function ChevronIcon({ dir }: { dir: "left" | "right" }) {
  return (
    <svg width={13} height={13} {...strokeProps}>
      <path d={dir === "left" ? "M15 18L9 12l6-6" : "M9 18l6-6-6-6"} />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width={13} height={13} {...strokeProps}>
      <path d="M20 11a8 8 0 0 0-13.7-5.7L3 8.5" />
      <path d="M3 4v4.5h4.5" />
      <path d="M4 13a8 8 0 0 0 13.7 5.7L21 15.5" />
      <path d="M21 20v-4.5h-4.5" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width={13} height={13} {...strokeProps}>
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}
