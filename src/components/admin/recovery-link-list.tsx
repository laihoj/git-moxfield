'use client';

import { LifeBuoy } from 'lucide-react';

import { revokeRecoveryLinkAction } from '@/app/admin-actions';
import { InlineConfirm } from '@/components/ui/inline-confirm';
import { MetaItem, MetaList } from '@/components/ui/meta-list';
import { ExpiryTime, RelativeTime } from '@/components/ui/relative-time';
import type { RecoveryLinkDTO } from '@/server/auth/types';

/**
 * The recovery links that can still sign someone in (never their URLs, which were shown
 * once to whoever made them): for whom, by whom, until when, with Withdraw. Whoever
 * opens a recovery link is signed in as the person it is for, so every admin can see
 * and stop the ones that are out there.
 */
export function RecoveryLinkList({ links }: { links: readonly RecoveryLinkDTO[] }) {
  return (
    <ul aria-label="Recovery links" className="divide-y divide-border">
      {links.map((link) => (
        <li key={link.id} className="flex flex-wrap items-center gap-x-3 gap-y-3 px-4 py-3.5 md:px-5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">
            <LifeBuoy aria-hidden="true" className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium break-words text-fg">For {link.user.displayName}</p>
            <MetaList className="text-xs text-muted">
              <MetaItem>
                {link.createdBy === null ? 'Made on the command line' : `By ${link.createdBy}`}{' '}
                <RelativeTime value={link.createdAt} />
              </MetaItem>
              <MetaItem>
                <ExpiryTime value={link.expiresAt} />
              </MetaItem>
            </MetaList>
          </div>
          <InlineConfirm
            trigger={{
              label: 'Withdraw',
              ariaLabel: `Withdraw the recovery link for ${link.user.displayName}`,
            }}
            message={`Withdraw the recovery link for ${link.user.displayName}? It stops working at once.`}
            confirmLabel="Withdraw link"
            onConfirm={async () => {
              const result = await revokeRecoveryLinkAction(link.id);
              return result.ok ? null : result.message;
            }}
          />
        </li>
      ))}
    </ul>
  );
}
