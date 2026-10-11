/**
 * `GET /decks/{deckId}/versions/{n}/restore.txt`: the restore export of a version as a
 * plain-text download (steps, every section, limitations). Viewers of a shared deck get
 * the same file from `/s/{token}/versions/{n}/restore.txt`.
 */
import type { NextRequest } from 'next/server';

import { restoreDownloadResponse } from '@/app/restore-download';
import { plainText } from '@/server/http/responses';

import { deckServices, decodeSegment, parseSequence } from '../../../data';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  { params }: RouteContext<'/decks/[deckId]/versions/[sequence]/restore.txt'>,
): Promise<Response> {
  const { deckId, sequence: rawSequence } = await params;
  const sequence = parseSequence(rawSequence);
  const id = decodeSegment(deckId);
  const restore = sequence === null ? null : await (await deckServices(id)).restoreExport(id, sequence);
  if (restore === null) return plainText(404, 'Version not found.');
  return restoreDownloadResponse(restore, { 'cache-control': 'no-store' });
}
