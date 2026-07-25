import type { FC } from "react";

/**
 * Monochrome glyph mark: an "A" wearing an acute accent, which is the whole
 * module in one shape. Drawn as strokes so it matches the other tool icons
 * rather than reading as a text character at a different weight.
 */
export const GlyphsIcon: FC<{ size?: number }> = ({ size = 26 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.4}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {/* the accent */}
    <path d="m10 3.2 3.4-1.9" />
    {/* the A */}
    <path d="M5.5 19 11.5 6l6 13" />
    <path d="M7.9 14.2h7.2" />
    {/* baseline rule, so the mark reads as type rather than a triangle */}
    <path d="M3.5 22h17" />
  </svg>
);

export default GlyphsIcon;
