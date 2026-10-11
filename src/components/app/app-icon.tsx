/**
 * The app icon as JSX for `ImageResponse` (PNG icons for the web manifest and iOS).
 * Mirrors `app/icon.svg` and `BrandMark`: the branch glyph on the accent violet.
 */

import { THEME } from '@/lib/brand';

import { BrandGlyph } from './brand-glyph';

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
        background: THEME.light.accent,
        borderRadius: shape === 'rounded' ? Math.round(size * 0.22) : 0,
      }}
    >
      <BrandGlyph size={glyph} stroke={THEME.light.accentFg} />
    </div>
  );
}
