import type { ToolModule } from "../tools/types";

type Props = {
  tool: ToolModule;
  selected: boolean;
  onSelect: () => void;
  onHover: () => void;
};

export function ToolTile({ tool, selected, onSelect, onHover }: Props) {
  const Icon = tool.icon;
  return (
    <button
      type="button"
      className={`bk-tile ${selected ? "is-selected" : ""}`}
      onClick={onSelect}
      onMouseEnter={onHover}
      aria-pressed={selected}
      data-tool-id={tool.id}
      title={tool.description ?? tool.name}
    >
      <span className="bk-tile__tick bk-tile__tick--tl" aria-hidden="true" />
      <span className="bk-tile__tick bk-tile__tick--br" aria-hidden="true" />
      <span className="bk-tile__icon">
        <Icon size={26} />
      </span>
      <span className="bk-tile__name">{tool.name}</span>
    </button>
  );
}
