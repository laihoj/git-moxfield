interface BrandGlyphProps {
  stroke?: string;
  /** Explicit size for renderers without CSS (`ImageResponse`); leave out to size it with `className`. */
  size?: number;
  className?: string;
}

/** The glyph of the git-moxfield mark (`BrandMark`, `AppIcon`), mirrored by the static `app/icon.svg`. */
export function BrandGlyph({ stroke = 'currentColor', size, className }: BrandGlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={stroke}
      strokeWidth="2.25"
      strokeLinecap="round"
      className={className}
    >
      <circle cx="7" cy="6" r="2.25" />
      <circle cx="7" cy="18" r="2.25" />
      <circle cx="17" cy="8" r="2.25" />
      <path d="M7 8.25v7.5" />
      <path d="M17 10.25c0 3.5-3 4.75-8.5 5.75" />
    </svg>
  );
}
