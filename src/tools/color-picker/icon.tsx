import type { FC } from "react";

/** Monochrome eyedropper glyph. Inherits color via `currentColor`. */
export const ColorIcon: FC<{ size?: number }> = ({ size = 26 }) => (
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
    <path d="M4.5 19.5 4 20l.5-3 8-8" />
    <path d="m4.5 16.5 3 3" />
    <path d="m13 7 4 4" />
    <path d="M15 5.2 16.7 3.5a2.2 2.2 0 0 1 3.1 3.1L18.1 8.3" />
  </svg>
);

export default ColorIcon;
