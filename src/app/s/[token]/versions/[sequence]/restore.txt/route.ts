/**
 * `GET /s/{token}/versions/{n}/restore.txt`: the restore export of a shared deck's
 * version as a plain-text download (ADR 0007), like the owner's
 * (`/decks/{deckId}/versions/{n}/restore.txt`) except that its steps restore into a deck
 * of the viewer's own: nothing in it leads to the owner's deck on Moxfield.
 *
 * The share link token is the only authorization: viewers may be signed out, and no
 * session is looked at. Every failure (malformed, unknown or revoked token, untracked
 * deck, disabled owner, unknown version) is the same 404, so a revoked link reveals
 * nothing a mistyped one does not. Responses are private: never stored by caches, never
 * indexed. The token is never logged.
 */
import type { NextRequest } from 'next/server';

import { restoreFileName, restoreText, type RestoreDownload } from '@/app/restore-download';
import { parseSequence } from '@/app/route-segments';
import { sharedDeckTitle } from '@/lib/presentation';
import { sharedDeckServices } from '@/server/access';

export const dynamic = 'force-dynamic';

/** Headers of every response of a shared deck's download, found or not. */
const PRIVATE_HEADERS = {
  'cache-control': 'private, no-store',
  'x-robots-tag': 'noindex, nofollow',
  'referrer-policy': 'no-referrer',
} as const;

export async function GET(
  _request: NextRequest,
  { params }: RouteContext<'/s/[token]/versions/[sequence]/restore.txt'>,
): Promise<Response> {
  const { token, sequence: rawSequence } = await params;
  const sequence = parseSequence(rawSequence);
  const access = sequence === null ? null : await sharedDeckServices(token);
  const restore = access === null || sequence === null ? null : await access.services.restoreExport(sequence);
  if (restore === null) {
    return new Response('Not found.\n', {
      status: 404,
      headers: { ...PRIVATE_HEADERS, 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  // Named as the pages name the deck (its latest version's name).
  const download: RestoreDownload = { ...restore, deck: { name: sharedDeckTitle(restore.deck) } };
  return new Response(restoreText(download), {
    headers: {
      ...PRIVATE_HEADERS,
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': `attachment; filename="${restoreFileName(download)}"`,
    },
  });
}
