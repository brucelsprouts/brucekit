import type { FC } from "react";

/** Monochrome viewfinder-with-text glyph. Inherits color via `currentColor`. */
export const OcrIcon: FC<{ size?: number }> = ({ size = 26 }) => (
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
    <path d="M3 8V4h4" />
    <path d="M21 8V4h-4" />
    <path d="M3 16v4h4" />
    <path d="M21 16v4h-4" />
    <path d="M8 10h8" />
    <path d="M8 13.5h5" />
  </svg>
);

export default OcrIcon;
