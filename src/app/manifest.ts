import type { MetadataRoute } from 'next';

/** Web app manifest: installable as a standalone app on phones and desktops (no service worker). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'git-moxfield',
    short_name: 'git-moxfield',
    description: 'Version control, semantic diffs and history for Moxfield decks.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#f6f6f8',
    theme_color: '#f6f6f8',
    categories: ['games', 'utilities'],
    icons: [
      { src: '/icons/192', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/512', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
  };
}
