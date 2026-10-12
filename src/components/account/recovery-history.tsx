import { LifeBuoy } from 'lucide-react';

import { ItemList, ItemRow, ItemTitle } from '@/components/ui/item-list';
import { MetaItem } from '@/components/ui/meta-list';
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
    <ItemList label="Recovery links used">
      {uses.map((use) => (
        <ItemRow
          key={`${use.usedAt}-${use.createdAt}`}
          icon={<LifeBuoy aria-hidden="true" />}
          title={
            <ItemTitle>
              {use.createdBy === null
                ? 'Recovery link from the server’s command line'
                : `Recovery link from ${use.createdBy}`}
            </ItemTitle>
          }
          meta={
            <>
              <MetaItem>
                Used <RelativeTime value={use.usedAt} />
              </MetaItem>
              <MetaItem>
                Made <RelativeTime value={use.createdAt} />
              </MetaItem>
            </>
          }
        />
      ))}
    </ItemList>
  );
}
