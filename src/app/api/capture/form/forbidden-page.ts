/**
 * The page a rejected same-tab capture shows. The bookmarklet's form post navigates the
 * tab, so the answer is what the user sees, usually on a phone: a small self-contained
 * HTML page (readable at device width, light and dark like the app) rather than plain
 * text, with the way out. All content is constant; nothing from the request is echoed.
 */
import 'server-only';

import { routes } from '@/lib/routes';

export type CaptureRejection = 'token' | 'origin';

/** Constant, trusted HTML. */
const COPY: Record<CaptureRejection, { title: string; paragraphs: string[] }> = {
  token: {
    title: 'Reinstall the bookmarklet',
    paragraphs: [
      'git-moxfield did not accept this deck: your <span class="nowrap">same-tab</span> bookmarklet is out of date or belongs to another git-moxfield.',
      'Replace it with the one on the Connect Moxfield page, then run it again on the deck.',
    ],
  },
  origin: {
    title: 'Deck not accepted',
    paragraphs: ['git-moxfield only accepts decks sent by its bookmarklet from Moxfield.'],
  },
};

// Mirrors the app's design tokens (src/app/globals.css).
const STYLE = `
:root { color-scheme: light dark; --bg: #f6f6f8; --surface: #fff; --border: #e3e3e8; --fg: #17171c; --muted: #62626e; --accent: #6d3fd8; --accent-hover: #5b2fc4; --accent-fg: #fff; }
@media (prefers-color-scheme: dark) { :root { --bg: #0d0e12; --surface: #15171c; --border: #262933; --fg: #e9e9ee; --muted: #a0a0ad; --accent: #9b7bf0; --accent-hover: #ac90f4; --accent-fg: #120a24; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; background: var(--bg); color: var(--fg); font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; -webkit-text-size-adjust: 100%; }
main { width: 100%; max-width: 28rem; padding: 24px; border: 1px solid var(--border); border-radius: 16px; background: var(--surface); box-shadow: 0 1px 2px rgb(0 0 0 / 0.05); }
h1 { margin: 0 0 8px; font-size: 1.25rem; line-height: 1.3; font-weight: 600; letter-spacing: -0.01em; }
p { margin: 0 0 12px; color: var(--muted); font-size: 0.9375rem; text-wrap: pretty; }
a { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; margin-top: 8px; padding: 0 20px; border-radius: 10px; background: var(--accent); color: var(--accent-fg); font-weight: 600; font-size: 0.9375rem; text-decoration: none; }
a:hover { background: var(--accent-hover); }
a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.nowrap { white-space: nowrap; }
`
  .trim()
  .split('\n')
  .join('');

/** The 403 answer for a rejected same-tab capture. */
export function captureRejectedResponse(reason: CaptureRejection): Response {
  const { title, paragraphs } = COPY[reason];
  const html = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex">',
    `<title>${title} · git-moxfield</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    '<main>',
    `<h1>${title}</h1>`,
    ...paragraphs.map((paragraph) => `<p>${paragraph}</p>`),
    `<a href="${routes.setup()}">Open Connect Moxfield</a>`,
    '</main>',
    '</body>',
    '</html>',
  ].join('\n');
  return new Response(html, {
    status: 403,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}
