import { LifeBuoy } from 'lucide-react';

import { MetaItem, MetaList } from '@/components/ui/meta-list';
import { RelativeTime } from '@/components/ui/relative-time';
import type { RecoveryUseDTO } from '@/server/auth/types';

/**
 * The recovery links that signed in as the user, most recent first: who made each one
 * and when it was used. Whoever opens a recovery link is signed in as the person it is
 * for, so this is how the user learns that an admin's link was used, and by whose
 * making. It stays listed for good; nothing a signed-in browser can do removes it.
 */
export function RecoveryHistory({ uses }: { uses: readonly RecoveryUseDTO[] }) {
  return (
    <ul aria-label="Recovery links used" className="divide-y divide-border">
      {uses.map((use) => (
        <li key={`${use.usedAt}-${use.createdAt}`} className="flex items-center gap-3 px-4 py-3.5 md:px-5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">
            <LifeBuoy aria-hidden="true" className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium break-words text-fg">
              {use.createdBy === null
                ? 'Recovery link from the server’s command line'
                : `Recovery link from ${use.createdBy}`}
            </p>
            <MetaList className="text-xs text-muted">
              <MetaItem>
                Used <RelativeTime value={use.usedAt} />
              </MetaItem>
              <MetaItem>
                Made <RelativeTime value={use.createdAt} />
              </MetaItem>
            </MetaList>
          </div>
        </li>
      ))}
    </ul>
  );
}
