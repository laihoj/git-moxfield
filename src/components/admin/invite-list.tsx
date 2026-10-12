'use client';

import { Mail } from 'lucide-react';

import { revokeInviteAction } from '@/app/admin-actions';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { InlineConfirm } from '@/components/ui/inline-confirm';
import { ItemList, ItemRow } from '@/components/ui/item-list';
import { MetaItem } from '@/components/ui/meta-list';
import { ExpiryTime, RelativeTime } from '@/components/ui/relative-time';
import { describeCreator, describeInviteStatus, roleLabel } from '@/lib/accounts';
import type { InviteDTO } from '@/server/auth/types';

/** Every invite, newest first: state, who it is for, who made it, and Withdraw while pending. */
export function InviteList({ invites }: { invites: readonly InviteDTO[] }) {
  if (invites.length === 0) {
    return (
      <EmptyState
        variant="inline"
        icon={<Mail aria-hidden="true" />}
        title="No invites yet"
        description="Invite links you create appear here, so you can see who joined and withdraw unused ones."
      />
    );
  }
  return (
    <ItemList label="Invites">
      {invites.map((invite) => (
        <InviteRow key={invite.id} invite={invite} />
      ))}
    </ItemList>
  );
}

function InviteRow({ invite }: { invite: InviteDTO }) {
  const status = describeInviteStatus(invite.status);
  const subject = invite.note === '' ? 'this invite' : `the invite for ${invite.note}`;
  return (
    <ItemRow
      title={
        <p className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <Badge tone={status.tone}>{status.label}</Badge>
          {invite.note === '' ? (
            <span className="text-muted italic">No note</span>
          ) : (
            <span className="min-w-0 font-medium break-words text-fg">{invite.note}</span>
          )}
        </p>
      }
      meta={
        <>
          <MetaItem>{roleLabel(invite.role)}</MetaItem>
          <MetaItem>
            {describeCreator(invite.createdBy)} <RelativeTime value={invite.createdAt} />
          </MetaItem>
          {invite.status === 'pending' && (
            <MetaItem>
              <ExpiryTime value={invite.expiresAt} />
            </MetaItem>
          )}
          {invite.status === 'used' && invite.usedAt !== null && (
            <MetaItem>
              {invite.usedBy === null ? 'Accepted' : `Accepted by ${invite.usedBy.displayName}`}{' '}
              <RelativeTime value={invite.usedAt} />
            </MetaItem>
          )}
        </>
      }
      actions={
        invite.status === 'pending' && (
          <InlineConfirm
            trigger={{ label: 'Withdraw', ariaLabel: `Withdraw ${subject}` }}
            message={`Withdraw ${subject}? Its link stops working at once.`}
            confirmLabel="Withdraw invite"
            onConfirm={() => revokeInviteAction(invite.id)}
          />
        )
      }
    />
  );
}
