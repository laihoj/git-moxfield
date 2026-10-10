'use client';

import { Link2, Trash2 } from 'lucide-react';

import { revokeShareLinkAction } from '@/app/share-actions';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { InlineConfirm } from '@/components/ui/inline-confirm';
import { MetaItem, MetaList } from '@/components/ui/meta-list';
import { RelativeTime } from '@/components/ui/relative-time';
import type { ShareLinkDTO } from '@/server/services/types';

export interface ShareLinkListProps {
  deckId: string;
  /** The deck's links that work, newest first. */
  links: readonly ShareLinkDTO[];
}

/**
 * A deck's share links: name, when made, when last viewed (recorded at most hourly),
 * whether it shows notes, and revoke (after confirming). Links never show their URL
 * again: only a fingerprint of the token is stored.
 */
export function ShareLinkList({ deckId, links }: ShareLinkListProps) {
  if (links.length === 0) {
    return (
      <EmptyState
        variant="inline"
        icon={<Link2 aria-hidden="true" />}
        title="No links yet"
        description="Links you create show up here, with when they were last viewed, so you can revoke any you no longer want to work."
      />
    );
  }
  return (
    <ul aria-label="Share links" className="divide-y divide-border">
      {links.map((link) => (
        <li key={link.id} className="flex flex-wrap items-center gap-x-3 gap-y-3 px-4 py-3.5 md:px-5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">
            <Link2 aria-hidden="true" className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium break-words text-fg">
              <span className="min-w-0 break-words">{link.label}</span>
              {link.includeNotes && <Badge tone="accent">Includes notes</Badge>}
            </p>
            <MetaList className="text-xs text-muted">
              <MetaItem>
                Created <RelativeTime value={link.createdAt} />
              </MetaItem>
              <MetaItem>
                {link.lastViewedAt === null ? (
                  'Not viewed yet'
                ) : (
                  <>
                    Last viewed <RelativeTime value={link.lastViewedAt} />
                  </>
                )}
              </MetaItem>
            </MetaList>
          </div>
          <InlineConfirm
            trigger={{
              label: 'Revoke',
              icon: <Trash2 aria-hidden="true" className="size-4" />,
              ariaLabel: `Revoke ${link.label}`,
            }}
            message={
              <>
                Revoke <span className="font-semibold">“{link.label}”</span>? Anyone using it loses access at
                once. This can’t be undone, but you can always create a new link.
              </>
            }
            confirmLabel="Revoke link"
            onConfirm={async () => {
              const result = await revokeShareLinkAction(deckId, link.id);
              return result.ok ? null : result.message;
            }}
          />
        </li>
      ))}
    </ul>
  );
}
