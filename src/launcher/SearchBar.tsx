import { useEffect, useRef } from "react";

type Props = {
  value: string;
  onChange: (value: string) => void;
  resultCount: number;
};

export function SearchBar({ value, onChange, resultCount }: Props) {
  const ref = useRef<HTMLInputElement>(null);

  // Autofocus on open (spec §6).
  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <div className="bk-search">
      <span className="bk-search__prompt" aria-hidden="true">
        &gt;
      </span>
      <input
        ref={ref}
        className="bk-search__input"
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="search tools"
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        aria-label="Search tools"
      />
      <span className="bk-search__count" aria-live="polite">
        {resultCount} {resultCount === 1 ? "TOOL" : "TOOLS"}
      </span>
    </div>
  );
}
