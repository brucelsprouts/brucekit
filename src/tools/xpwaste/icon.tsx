/**
 * Countdown dial — a ring opened at the top with a hand sweeping out of it,
 * monochrome and stroke-only like every tool icon. Deliberately not a tomato:
 * the tile row is a set of technical marks, and one piece of fruit in it would
 * read as a sticker.
 */
export function XpwasteIcon({ size = 24 }: { size?: number }) {
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
      {/* Ring, broken at the top where the stem crosses it. */}
      <path d="M14.4 4.4a8 8 0 1 1-4.8 0" />
      <path d="M9.5 3h5" />
      {/* The hand: twenty-five past, pointing out of the centre. */}
      <path d="M12 12V8" />
      <path d="M12 12l3.2 2" />
    </svg>
  );
}
