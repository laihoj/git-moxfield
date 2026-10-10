'use client';

import clsx from 'clsx';
import { LifeBuoy, UserRoundCheck, UserRoundX, X } from 'lucide-react';
import { useState, useTransition } from 'react';

import type { IssuedLinkState } from '@/app/action-types';
import { createRecoveryLinkAction, setUserDisabledAction } from '@/app/admin-actions';
import { OneTimeLink } from '@/components/account/one-time-link';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { InlineConfirm } from '@/components/ui/inline-confirm';
import { MetaItem, MetaList } from '@/components/ui/meta-list';
import { RelativeTime } from '@/components/ui/relative-time';
import { roleLabel } from '@/lib/accounts';
import { pluralize } from '@/lib/format';
import type { UserDTO } from '@/server/auth/types';

export interface PeopleListProps {
  people: readonly UserDTO[];
  /** The signed-in admin, who cannot disable themselves. */
  currentUserId: string;
  /**
   * People with a recovery link that can still be used. A link this page just made stays
   * shown only while it is one of those: once used or withdrawn, it is hidden.
   */
  withPendingRecovery: readonly string[];
}

/**
 * Everyone with an account: role, activity, decks and bookmarklets (counts only: admins
 * manage accounts, not decks), with a recovery link for someone locked out, and disable
 * or enable. A recovery link signs in as the person it is for, so it is shown once, with
 * the warning to give it only to them.
 */
export function PeopleList({ people, currentUserId, withPendingRecovery }: PeopleListProps) {
  return (
    <ul aria-label="People" className="divide-y divide-border">
      {people.map((person) => (
        <PersonRow
          key={person.id}
          person={person}
          isSelf={person.id === currentUserId}
          hasPendingRecovery={withPendingRecovery.includes(person.id)}
        />
      ))}
    </ul>
  );
}

function PersonRow({
  person,
  isSelf,
  hasPendingRecovery,
}: {
  person: UserDTO;
  isSelf: boolean;
  hasPendingRecovery: boolean;
}) {
  const disabled = person.disabledAt !== null;
  const [recovery, setRecovery] = useState<IssuedLinkState>({ status: 'idle' });
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <li className="flex gap-3 px-4 py-3.5 md:px-5">
      <Avatar name={person.displayName} className={clsx('mt-0.5', disabled && 'opacity-50')} />
      {/* The actions wrap below the details when the row is narrow (phones), never squeezing them. */}
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2.5">
          <div className="min-w-[min(100%,12rem)] flex-1">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-fg">
              <span className="min-w-0 break-words">{person.displayName}</span>
              {isSelf && <Badge tone="outline">You</Badge>}
              {person.role === 'admin' && <Badge tone="accent">{roleLabel(person.role)}</Badge>}
              {disabled && <Badge tone="remove">Disabled</Badge>}
            </p>
            <MetaList className="text-xs text-muted tabular">
              <MetaItem>
                Joined <RelativeTime value={person.createdAt} />
              </MetaItem>
              <MetaItem>
                {person.lastSeenAt === null ? (
                  'Not seen yet'
                ) : (
                  <>
                    Active <RelativeTime value={person.lastSeenAt} />
                  </>
                )}
              </MetaItem>
              <MetaItem>{pluralize(person.deckCount, 'deck')}</MetaItem>
              <MetaItem>{pluralize(person.activeKeyCount, 'bookmarklet')}</MetaItem>
            </MetaList>
          </div>
          {!isSelf && (
            <div className="flex flex-wrap items-center gap-2">
              {!disabled && (
                <Button
                  variant="secondary"
                  size="sm"
                  loading={pending}
                  icon={<LifeBuoy aria-hidden="true" className="size-4" />}
                  aria-label={`Create a recovery link for ${person.displayName}`}
                  onClick={() => {
                    startTransition(async () => {
                      setRecovery(await createRecoveryLinkAction(person.id));
                    });
                  }}
                >
                  Recovery link
                </Button>
              )}
              {disabled ? (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<UserRoundCheck aria-hidden="true" className="size-4" />}
                  aria-label={`Enable ${person.displayName}`}
                  onClick={() => {
                    startTransition(async () => {
                      const result = await setUserDisabledAction(person.id, false);
                      setError(result.ok ? null : result.message);
                    });
                  }}
                >
                  Enable
                </Button>
              ) : (
                <InlineConfirm
                  trigger={{
                    label: 'Disable',
                    icon: <UserRoundX aria-hidden="true" className="size-4" />,
                    ariaLabel: `Disable ${person.displayName}`,
                  }}
                  message={
                    <>
                      Disable <span className="font-semibold">{person.displayName}</span>? They are signed out
                      everywhere and can’t sign in until you enable them again. Their decks are kept.
                    </>
                  }
                  confirmLabel="Disable"
                  onConfirm={async () => {
                    const result = await setUserDisabledAction(person.id, true);
                    if (result.ok) setRecovery({ status: 'idle' });
                    return result.ok ? null : result.message;
                  }}
                />
              )}
            </div>
          )}
        </div>

        {error !== null && (
          <p role="alert" className="text-sm text-remove">
            {error}
          </p>
        )}
        {recovery.status === 'error' && (
          <p role="alert" className="text-sm text-remove">
            {recovery.message}
          </p>
        )}
        {recovery.status === 'created' && hasPendingRecovery && (
          <div className="relative rounded-lg border border-border bg-surface-2/60 p-4 pr-12">
            <OneTimeLink
              url={recovery.url}
              expiresAt={recovery.expiresAt}
              subject="Recovery link"
              meta="works once"
            >
              Send this only to <span className="font-medium">{person.displayName}</span>: whoever opens it
              signs in as them, and their other devices and bookmarklets are signed out. It works once; this
              is the only time it’s shown.
            </OneTimeLink>
            {/* IconButton positions itself (relative, for its touch target), so a wrapper places it. */}
            <div className="absolute top-2.5 right-2.5">
              <IconButton
                label="Hide recovery link"
                icon={<X aria-hidden="true" className="size-4" />}
                size="sm"
                onClick={() => {
                  setRecovery({ status: 'idle' });
                }}
              />
            </div>
          </div>
        )}
      </div>
    </li>
  );
}
