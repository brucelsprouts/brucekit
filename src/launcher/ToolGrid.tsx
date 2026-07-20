import type { ToolModule } from "../tools/types";
import { ToolTile } from "./ToolTile";

type Props = {
  tools: ToolModule[];
  /** Index to ring, or -1 for none (highlight follows hover / keyboard only). */
  selectedIndex: number;
  onSelect: (tool: ToolModule) => void;
  onHover: (index: number) => void;
  onLeave: () => void;
};

export function ToolGrid({ tools, selectedIndex, onSelect, onHover, onLeave }: Props) {
  if (tools.length === 0) {
    return (
      <div className="bk-grid__empty">
        <span className="bk-label">NO MATCHES</span>
      </div>
    );
  }

  return (
    <div className="bk-grid" role="listbox" aria-label="Tools">
      {tools.map((tool, i) => (
        <ToolTile
          key={tool.id}
          tool={tool}
          selected={i === selectedIndex}
          onSelect={() => onSelect(tool)}
          onHover={() => onHover(i)}
          onLeave={onLeave}
        />
      ))}
    </div>
  );
}
