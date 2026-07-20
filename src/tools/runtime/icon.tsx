/** Runtime mark — a clock face in a frame, monochrome stroke like every tool icon. */
export function RuntimeIcon({ size = 24 }: { size?: number }) {
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
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="12" cy="12" r="4.25" />
      <path d="M12 9.75V12l1.75 1.25" />
    </svg>
  );
}
