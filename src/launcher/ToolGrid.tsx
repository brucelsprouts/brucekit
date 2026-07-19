import type { ToolModule } from "../tools/types";
import { ToolTile } from "./ToolTile";

type Props = {
  tools: ToolModule[];
  selectedIndex: number;
  onSelect: (tool: ToolModule) => void;
  onHover: (index: number) => void;
};

export function ToolGrid({ tools, selectedIndex, onSelect, onHover }: Props) {
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
        />
      ))}
    </div>
  );
}
