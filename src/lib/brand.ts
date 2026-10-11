/**
 * What identifies the app, written once for the places that cannot read the stylesheet:
 * the page metadata, the web app manifest, the generated PNG icons and the constant HTML
 * page of a rejected capture. Pure and client-safe.
 *
 * `src/app/globals.css` and the static `src/app/icon.svg` cannot import this module and
 * stay the sources of the colors; `brand.test.ts` checks that {@link THEME} and the icon
 * still agree with them.
 */

export const APP_NAME = 'git-moxfield';
export const APP_DESCRIPTION = 'Version control, semantic diffs and history for Moxfield decks.';

/** The core design tokens of a theme (the custom properties of the same name in `globals.css`). */
export interface ThemeTokens {
  bg: string;
  surface: string;
  border: string;
  fg: string;
  muted: string;
  accent: string;
  accentHover: string;
  accentFg: string;
}

export const THEME: { light: ThemeTokens; dark: ThemeTokens } = {
  light: {
    bg: '#f6f6f8',
    surface: '#ffffff',
    border: '#e3e3e8',
    fg: '#17171c',
    muted: '#62626e',
    accent: '#6d3fd8',
    accentHover: '#5b2fc4',
    accentFg: '#ffffff',
  },
  dark: {
    bg: '#0d0e12',
    surface: '#15171c',
    border: '#262933',
    fg: '#e9e9ee',
    muted: '#a0a0ad',
    accent: '#9b7bf0',
    accentHover: '#ac90f4',
    accentFg: '#120a24',
  },
};

/**
 * The generated PNG icons (`/icons/<name>`). `rounded` ones draw their own rounded square;
 * `full-bleed` ones fill the square and keep the glyph inside the maskable safe zone.
 */
export const PNG_ICONS = {
  '192': { size: 192, shape: 'rounded' },
  '512': { size: 512, shape: 'rounded' },
  'maskable-512': { size: 512, shape: 'full-bleed' },
} as const;

export type PngIconName = keyof typeof PNG_ICONS;
