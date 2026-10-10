/**
 * The app icon as JSX for `ImageResponse` (PNG icons for the web manifest and iOS).
 * Mirrors `app/icon.svg` and `BrandMark`: the branch glyph on the accent violet.
 */

/** Accent violet of the light theme (`--accent`). */
export const ICON_BACKGROUND = '#6d3fd8';

export interface AppIconProps {
  size: number;
  /**
   * `rounded` draws its own rounded square (regular icons); `full-bleed` fills the
   * square and keeps the glyph inside the maskable safe zone (Android, iOS).
   */
  shape: 'rounded' | 'full-bleed';
}

export function AppIcon({ size, shape }: AppIconProps) {
  const glyph = Math.round(size * (shape === 'full-bleed' ? 0.5 : 0.6));
  return (
    <div
      style={{
        width: size,
        height: size,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: ICON_BACKGROUND,
        borderRadius: shape === 'rounded' ? Math.round(size * 0.22) : 0,
      }}
    >
      <svg
        width={glyph}
        height={glyph}
        viewBox="0 0 24 24"
        fill="none"
        stroke="#ffffff"
        strokeWidth="2.25"
        strokeLinecap="round"
      >
        <circle cx="7" cy="6" r="2.25" />
        <circle cx="7" cy="18" r="2.25" />
        <circle cx="17" cy="8" r="2.25" />
        <path d="M7 8.25v7.5" />
        <path d="M17 10.25c0 3.5-3 4.75-8.5 5.75" />
      </svg>
    </div>
  );
}
