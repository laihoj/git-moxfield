'use client';

import { Link2, Trash2 } from 'lucide-react';

import { revokeShareLinkAction } from '@/app/share-actions';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { InlineConfirm } from '@/components/ui/inline-confirm';
import { ItemList, ItemRow, ItemTitle } from '@/components/ui/item-list';
import { MetaItem } from '@/components/ui/meta-list';
import { LabeledTime, RelativeTime } from '@/components/ui/relative-time';
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
    <ItemList label="Share links">
      {links.map((link) => (
        <ItemRow
          key={link.id}
          icon={<Link2 aria-hidden="true" />}
          title={
            <ItemTitle badges={link.includeNotes && <Badge tone="accent">Includes notes</Badge>}>
              {link.label}
            </ItemTitle>
          }
          meta={
            <>
              <MetaItem>
                Created <RelativeTime value={link.createdAt} />
              </MetaItem>
              <MetaItem>
                <LabeledTime label="Last viewed" value={link.lastViewedAt} fallback="Not viewed yet" />
              </MetaItem>
            </>
          }
          actions={
            <InlineConfirm
              trigger={{
                label: 'Revoke',
                icon: <Trash2 aria-hidden="true" className="size-4" />,
                ariaLabel: `Revoke ${link.label}`,
              }}
              message={
                <>
                  Revoke <span className="font-semibold">“{link.label}”</span>? Anyone using it loses access
                  at once. This can’t be undone, but you can always create a new link.
                </>
              }
              confirmLabel="Revoke link"
              onConfirm={() => revokeShareLinkAction(deckId, link.id)}
            />
          }
        />
      ))}
    </ItemList>
  );
}
