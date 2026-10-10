'use client';

import { Link2, Trash2 } from 'lucide-react';

import { revokeKeyShareLinksAction } from '@/app/account-actions';
import { InlineConfirm } from '@/components/ui/inline-confirm';
import { MetaItem, MetaList } from '@/components/ui/meta-list';
import { RelativeTime } from '@/components/ui/relative-time';
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
    <ul aria-label="Share links of revoked bookmarklets" className="divide-y divide-border">
      {keys.map((key) => (
        <RevokedKeyRow key={key.id} revokedKey={key} />
      ))}
    </ul>
  );
}

function RevokedKeyRow({ revokedKey: key }: { revokedKey: RevokedKeyShareLinksDTO }) {
  const links = key.shareLinkCount === 1 ? 'the share link' : `the ${key.shareLinkCount} share links`;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-3 px-4 py-3.5 md:px-5">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">
        <Link2 aria-hidden="true" className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium break-words text-fg">{key.label}</p>
        <MetaList className="text-xs text-muted">
          <MetaItem>
            Revoked <RelativeTime value={key.revokedAt} />
          </MetaItem>
          <MetaItem>{pluralize(key.shareLinkCount, 'share link')} still working</MetaItem>
        </MetaList>
      </div>
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
        onConfirm={async () => {
          const result = await revokeKeyShareLinksAction(key.id);
          return result.ok ? null : result.message;
        }}
      />
    </li>
  );
}
