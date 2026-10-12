/**
 * What identifies the app, for the places that cannot read the stylesheet (metadata,
 * manifest, PNG icons, the rejected-capture page). `src/app/globals.css` and
 * `src/app/icon.svg` stay the sources of the colors; `brand.test.ts` keeps them in step.
 */

export const APP_NAME = 'git-moxfield';
export const APP_DESCRIPTION = 'Version control, semantic diffs and history for Moxfield decks.';

/** The core design tokens of each theme (the custom properties of the same name in `globals.css`). */
export const THEME = {
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

export type ThemeTokens = (typeof THEME)['light'];

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
