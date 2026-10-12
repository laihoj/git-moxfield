import type { MetadataRoute } from 'next';

import { APP_DESCRIPTION, APP_NAME, PNG_ICONS, THEME, type PngIconName } from '@/lib/brand';

/** Web app manifest: installable as a standalone app on phones and desktops (no service worker). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: APP_NAME,
    short_name: APP_NAME,
    description: APP_DESCRIPTION,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: THEME.light.bg,
    theme_color: THEME.light.bg,
    categories: ['games', 'utilities'],
    icons: [
      ...(Object.keys(PNG_ICONS) as PngIconName[]).map((name) => ({
        src: `/icons/${name}`,
        sizes: `${PNG_ICONS[name].size}x${PNG_ICONS[name].size}`,
        type: 'image/png',
        purpose: PNG_ICONS[name].shape === 'rounded' ? ('any' as const) : ('maskable' as const),
      })),
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
  };
}
