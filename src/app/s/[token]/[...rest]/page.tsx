import { loadSharedDeck } from '../data';
import { SharedPageMissing } from '../page-missing';

export const dynamic = 'force-dynamic';

/**
 * Any other path below a share link: checked like every page (the layout resolves the
 * link first), then answered with the shared deck's not-found page in its frame, or the
 * dead link page once the link no longer works.
 */
export default async function UnknownSharedPage({ params }: PageProps<'/s/[token]/[...rest]'>) {
  const { token } = await params;
  return <SharedPageMissing access={await loadSharedDeck(token)} />;
}
