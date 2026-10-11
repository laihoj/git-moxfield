'use client';

import { LifeBuoy } from 'lucide-react';

import { revokeRecoveryLinkAction } from '@/app/admin-actions';
import { InlineConfirm } from '@/components/ui/inline-confirm';
import { ItemList, ItemRow, ItemTitle } from '@/components/ui/item-list';
import { MetaItem } from '@/components/ui/meta-list';
import { ExpiryTime, RelativeTime } from '@/components/ui/relative-time';
import { describeCreator } from '@/lib/accounts';
import type { RecoveryLinkDTO } from '@/server/auth/types';

/**
 * The recovery links that can still sign someone in (never their URLs, which were shown
 * once to whoever made them): for whom, by whom, until when, with Withdraw. Whoever
 * opens a recovery link is signed in as the person it is for, so every admin can see
 * and stop the ones that are out there.
 */
export function RecoveryLinkList({ links }: { links: readonly RecoveryLinkDTO[] }) {
  return (
    <ItemList label="Recovery links">
      {links.map((link) => (
        <ItemRow
          key={link.id}
          icon={<LifeBuoy aria-hidden="true" />}
          title={<ItemTitle>For {link.user.displayName}</ItemTitle>}
          meta={
            <>
              <MetaItem>
                {describeCreator(link.createdBy)} <RelativeTime value={link.createdAt} />
              </MetaItem>
              <MetaItem>
                <ExpiryTime value={link.expiresAt} />
              </MetaItem>
            </>
          }
          actions={
            <InlineConfirm
              trigger={{
                label: 'Withdraw',
                ariaLabel: `Withdraw the recovery link for ${link.user.displayName}`,
              }}
              message={`Withdraw the recovery link for ${link.user.displayName}? It stops working at once.`}
              confirmLabel="Withdraw link"
              onConfirm={() => revokeRecoveryLinkAction(link.id)}
            />
          }
        />
      ))}
    </ItemList>
  );
}
