'use client';

import { Bookmark, Trash2 } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';

import { revokeKeyAction } from '@/app/account-actions';
import { EmptyState } from '@/components/ui/empty-state';
import { ButtonLink } from '@/components/ui/button';
import { InlineConfirm } from '@/components/ui/inline-confirm';
import { ItemList, ItemRow, ItemTitle } from '@/components/ui/item-list';
import { MetaItem } from '@/components/ui/meta-list';
import { LabeledTime, RelativeTime } from '@/components/ui/relative-time';
import { theShareLinks } from '@/lib/accounts';
import { joinList } from '@/lib/format';
import { routes } from '@/lib/routes';
import type { BookmarkletKeyDTO } from '@/server/auth/types';

/**
 * The user's bookmarklets: name, when made (and in a browser which bookmarklet signed
 * in), when last used, and revoke. Revoking says exactly what else ends with it, and
 * offers to revoke the bookmarklets and the share links made through it too: what a thief
 * holding a copy of it could have made, or what the user made themselves, which only
 * they know. The share links are always offered, whatever this page counted when it
 * loaded: a thief may make one meanwhile, and the server revokes those that exist when
 * the revocation runs.
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
    <ItemList label="Bookmarklets">
      {keys.map((key) => (
        <KeyRow key={key.id} bookmarklet={key} />
      ))}
    </ItemList>
  );
}

function KeyRow({ bookmarklet: key }: { bookmarklet: BookmarkletKeyDTO }) {
  const [includeDerived, setIncludeDerived] = useState(false);
  const [includeShareLinks, setIncludeShareLinks] = useState(false);
  const derivedCheckboxId = useId();
  const shareLinksCheckboxId = useId();
  const derivedNames = joinList(key.derived.map((derived) => `“${derived.label}”`));
  const several = key.derived.length > 1;
  // The links revokeKey reaches with these choices, as counted when the page loaded.
  const shareLinkCount = key.shareLinkCount + (includeDerived ? key.derivedShareLinkCount : 0);
  const shareLinks = theShareLinks(shareLinkCount);

  return (
    <ItemRow
      icon={<Bookmark aria-hidden="true" />}
      title={<ItemTitle>{key.label}</ItemTitle>}
      meta={
        <>
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
            <LabeledTime label="Last used" value={key.lastUsedAt} fallback="Never used" />
          </MetaItem>
        </>
      }
      actions={
        <InlineConfirm
          trigger={{
            label: 'Revoke',
            icon: <Trash2 aria-hidden="true" className="size-4" />,
            ariaLabel: `Revoke ${key.label}`,
          }}
          message={
            <>
              Revoke <span className="font-semibold">“{key.label}”</span>? It stops working at once. Browsers
              it signed in, and browsers signed in with a device link made on one of them, are signed out
              (except this one). Your decks are not affected.
            </>
          }
          details={
            <div className="flex flex-col gap-3">
              {key.derived.length > 0 && (
                <ConfirmOption id={derivedCheckboxId} checked={includeDerived} onChange={setIncludeDerived}>
                  Also revoke {several ? 'the bookmarklets' : 'the bookmarklet'} made in a browser it signed
                  in: <span className="font-medium break-words">{derivedNames}</span>.{' '}
                  <span className="text-muted">
                    Do this if “{key.label}” may have been stolen; leave {several ? 'them' : 'it'} if you made{' '}
                    {several ? 'them' : 'it'} yourself.
                  </span>
                </ConfirmOption>
              )}
              <ConfirmOption
                id={shareLinksCheckboxId}
                checked={includeShareLinks}
                onChange={setIncludeShareLinks}
              >
                Also revoke {shareLinks} made in{' '}
                {includeDerived && key.derived.length > 0
                  ? 'browsers these bookmarklets signed in'
                  : 'a browser it signed in'}
                .{' '}
                <span className="text-muted">
                  Read-only links to your decks keep working otherwise. Do this if “{key.label}” may have been
                  stolen; links you shared yourself stop working too.
                </span>
              </ConfirmOption>
            </div>
          }
          confirmLabel="Revoke bookmarklet"
          onConfirm={() => revokeKeyAction(key.id, includeDerived, includeShareLinks)}
        />
      }
    />
  );
}

/** A checkbox choice inside the revoke confirmation. */
function ConfirmOption({
  id,
  checked,
  onChange,
  children,
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <div className="flex gap-2.5 text-sm text-fg">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        className="mt-0.5 size-4 shrink-0 cursor-pointer accent-(--accent)"
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
      <label htmlFor={id} className="min-w-0 cursor-pointer text-pretty">
        {children}
      </label>
    </div>
  );
}
