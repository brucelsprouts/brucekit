import type { ToolModule } from "../tools/types";

type Props = {
  tool: ToolModule;
  selected: boolean;
  /** Pinned tools carry a corner marker so the front of the grid explains itself. */
  pinned?: boolean;
  onSelect: () => void;
  /** Pin/unpin from the tile itself; omitted where pinning doesn't apply. */
  onTogglePin?: () => void;
  onHover: () => void;
  onLeave: () => void;
};

export function ToolTile({
  tool,
  selected,
  pinned = false,
  onSelect,
  onTogglePin,
  onHover,
  onLeave,
}: Props) {
  const Icon = tool.icon;
  return (
    <div
      className={`bk-tile ${selected ? "is-selected" : ""} ${pinned ? "is-pinned" : ""}`}
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      data-tool-id={tool.id}
    >
      <button
        type="button"
        className="bk-tile__hit"
        onClick={onSelect}
        title={tool.description ?? tool.name}
      >
        <span className="bk-tile__tick bk-tile__tick--tl" aria-hidden="true" />
        <span className="bk-tile__tick bk-tile__tick--br" aria-hidden="true" />
        <span className="bk-tile__icon">
          <Icon size={26} />
        </span>
        <span className="bk-tile__name">{tool.name}</span>
      </button>
      {onTogglePin && (
        <button
          type="button"
          className={`bk-tile__pin ${pinned ? "is-active" : ""}`}
          onClick={onTogglePin}
          aria-label={pinned ? `Unpin ${tool.name}` : `Pin ${tool.name}`}
          title={pinned ? "Unpin from grid + tray" : "Pin to grid + tray"}
        >
          {pinned ? "★" : "☆"}
        </button>
      )}
    </div>
  );
}
