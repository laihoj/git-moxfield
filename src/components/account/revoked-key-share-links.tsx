'use client';

import { Link2, Trash2 } from 'lucide-react';

import { revokeKeyShareLinksAction } from '@/app/account-actions';
import { InlineConfirm } from '@/components/ui/inline-confirm';
import { ItemList, ItemRow, ItemTitle } from '@/components/ui/item-list';
import { MetaItem } from '@/components/ui/meta-list';
import { RelativeTime } from '@/components/ui/relative-time';
import { theShareLinks } from '@/lib/accounts';
import { pluralize } from '@/lib/format';
import type { RevokedKeyShareLinksDTO } from '@/server/auth/types';

/**
 * Revoked bookmarklets whose share links still work (ADR 0007): read-only links made in
 * browsers they signed in, which outlived them because they were revoked without their
 * share links. The links can still be revoked here, one bookmarklet at a time, so a
 * stolen key's links never become impossible to find.
 */
export function RevokedKeyShareLinks({ keys }: { keys: readonly RevokedKeyShareLinksDTO[] }) {
  return (
    <ItemList label="Share links of revoked bookmarklets">
      {keys.map((key) => (
        <RevokedKeyRow key={key.id} revokedKey={key} />
      ))}
    </ItemList>
  );
}

function RevokedKeyRow({ revokedKey: key }: { revokedKey: RevokedKeyShareLinksDTO }) {
  const links = theShareLinks(key.shareLinkCount);
  return (
    <ItemRow
      icon={<Link2 aria-hidden="true" />}
      title={<ItemTitle>{key.label}</ItemTitle>}
      meta={
        <>
          <MetaItem>
            Revoked <RelativeTime value={key.revokedAt} />
          </MetaItem>
          <MetaItem>{pluralize(key.shareLinkCount, 'share link')} still working</MetaItem>
        </>
      }
      actions={
        <InlineConfirm
          trigger={{
            label: 'Revoke links',
            icon: <Trash2 aria-hidden="true" className="size-4" />,
            ariaLabel: `Revoke the share links of ${key.label}`,
          }}
          message={
            <>
              Revoke {links} made in a browser <span className="font-semibold">“{key.label}”</span> signed in?
              Anyone using {key.shareLinkCount === 1 ? 'it' : 'them'} loses access at once, also people you
              shared {key.shareLinkCount === 1 ? 'it' : 'them'} with yourself.
            </>
          }
          confirmLabel={key.shareLinkCount === 1 ? 'Revoke share link' : 'Revoke share links'}
          onConfirm={() => revokeKeyShareLinksAction(key.id)}
        />
      }
    />
  );
}
