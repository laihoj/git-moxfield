'use client';

import { Bookmark, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';

import { revokeKeyAction } from '@/app/account-actions';
import { EmptyState } from '@/components/ui/empty-state';
import { ButtonLink } from '@/components/ui/button';
import { InlineConfirm } from '@/components/ui/inline-confirm';
import { MetaItem, MetaList } from '@/components/ui/meta-list';
import { RelativeTime } from '@/components/ui/relative-time';
import { joinList } from '@/lib/format';
import { routes } from '@/lib/routes';
import type { BookmarkletKeyDTO } from '@/server/auth/types';

/**
 * The user's bookmarklets: name, when made (and in a browser which bookmarklet signed
 * in), when last used, and revoke. Revoking says exactly what else ends with it, and
 * offers to revoke the bookmarklets made through it too: what a thief holding a copy of
 * it could have made, or a replacement the user made themselves, which only they know.
 */
export function KeyList({ keys }: { keys: readonly BookmarkletKeyDTO[] }) {
  if (keys.length === 0) {
    return (
      <EmptyState
        variant="inline"
        icon={<Bookmark aria-hidden="true" />}
        title="No bookmarklets yet"
        description="A bookmarklet sends decks from Moxfield and signs its browser in. Make one for each browser you use."
        actions={
          <ButtonLink href={routes.setup()} variant="primary">
            Create a bookmarklet
          </ButtonLink>
        }
      />
    );
  }
  return (
    <ul aria-label="Bookmarklets" className="divide-y divide-border">
      {keys.map((key) => (
        <KeyRow key={key.id} bookmarklet={key} />
      ))}
    </ul>
  );
}

function KeyRow({ bookmarklet: key }: { bookmarklet: BookmarkletKeyDTO }) {
  const [includeDerived, setIncludeDerived] = useState(false);
  const checkboxId = useId();
  const derivedNames = joinList(key.derived.map((derived) => `“${derived.label}”`));
  const several = key.derived.length > 1;

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-3 px-4 py-3.5 md:px-5">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">
        <Bookmark aria-hidden="true" className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium break-words text-fg">{key.label}</p>
        <MetaList className="text-xs text-muted">
          <MetaItem>
            Made <RelativeTime value={key.createdAt} />
          </MetaItem>
          {key.madeFrom !== null && (
            <MetaItem>
              <span
                className="break-words"
                title={`Made in a browser that “${key.madeFrom.label}” signed in`}
              >
                Via “{key.madeFrom.label}”
              </span>
            </MetaItem>
          )}
          <MetaItem>
            {key.lastUsedAt === null ? (
              'Never used'
            ) : (
              <>
                Last used <RelativeTime value={key.lastUsedAt} />
              </>
            )}
          </MetaItem>
        </MetaList>
      </div>
      <InlineConfirm
        trigger={{
          label: 'Revoke',
          icon: <Trash2 aria-hidden="true" className="size-4" />,
          ariaLabel: `Revoke ${key.label}`,
        }}
        message={
          <>
            Revoke <span className="font-semibold">“{key.label}”</span>? It stops working at once. Browsers it
            signed in, and browsers signed in with a device link made on one of them, are signed out (except
            this one). Your decks are not affected.
          </>
        }
        details={
          key.derived.length > 0 && (
            <div className="flex gap-2.5 text-sm text-fg">
              <input
                id={checkboxId}
                type="checkbox"
                checked={includeDerived}
                className="mt-0.5 size-4 shrink-0 cursor-pointer accent-(--accent)"
                onChange={(event) => {
                  setIncludeDerived(event.target.checked);
                }}
              />
              <label htmlFor={checkboxId} className="min-w-0 cursor-pointer text-pretty">
                Also revoke {several ? 'the bookmarklets' : 'the bookmarklet'} made in a browser it signed in:{' '}
                <span className="font-medium break-words">{derivedNames}</span>.{' '}
                <span className="text-muted">
                  Do this if “{key.label}” may have been stolen; leave {several ? 'them' : 'it'} if you made{' '}
                  {several ? 'them' : 'it'} yourself.
                </span>
              </label>
            </div>
          )
        }
        confirmLabel="Revoke bookmarklet"
        onConfirm={async () => {
          const result = await revokeKeyAction(key.id, includeDerived);
          return result.ok ? null : result.message;
        }}
      />
    </li>
  );
}
