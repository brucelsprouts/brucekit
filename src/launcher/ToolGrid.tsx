import type { ToolModule } from "../tools/types";
import { ToolTile } from "./ToolTile";

type Props = {
  tools: ToolModule[];
  /** Index to ring, or -1 for none (highlight follows hover / keyboard only). */
  selectedIndex: number;
  /**
   * Where this grid's first tile sits in the launcher's flat result list. The
   * pinned and unpinned sections render as two grids over one array, so
   * keyboard selection stays a single index across both.
   */
  indexOffset?: number;
  /** Ids currently pinned — drives the tile marker and the pin button state. */
  pinned?: string[];
  onSelect: (tool: ToolModule) => void;
  onTogglePin?: (tool: ToolModule) => void;
  onHover: (index: number) => void;
  onLeave: () => void;
};

export function ToolGrid({
  tools,
  selectedIndex,
  indexOffset = 0,
  pinned = [],
  onSelect,
  onTogglePin,
  onHover,
  onLeave,
}: Props) {
  if (tools.length === 0) {
    return (
      <div className="bk-grid__empty">
        <span className="bk-label">NO MATCHES</span>
      </div>
    );
  }

  return (
    // A group, not a listbox: each tile is a launch button paired with its own
    // pin button, which is not a shape `option` children can legally take.
    //
    // `is-selected` is only ever set during keyboard navigation, so a live
    // index means the keyboard owns the highlight — which the grid advertises
    // so hover styling can stand down. Otherwise a mouse resting on one tile
    // stays lit while the arrows light another, and two tiles glow at once.
    <div
      className={`bk-grid ${selectedIndex >= 0 ? "is-keynav" : ""}`}
      role="group"
      aria-label="Tools"
    >
      {tools.map((tool, i) => (
        <ToolTile
          key={tool.id}
          tool={tool}
          selected={indexOffset + i === selectedIndex}
          pinned={pinned.includes(tool.id)}
          onSelect={() => onSelect(tool)}
          onTogglePin={onTogglePin ? () => onTogglePin(tool) : undefined}
          onHover={() => onHover(indexOffset + i)}
          onLeave={onLeave}
        />
      ))}
    </div>
  );
}
