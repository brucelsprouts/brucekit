/** Stacked-clipboard mark — monochrome, stroke-only like every tool icon. */
export function ClipsIcon({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="8" y="3" width="13" height="13" rx="1" />
      <path d="M16 16v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h3" />
      <path d="M11.5 8h6M11.5 11h6" />
    </svg>
  );
}
