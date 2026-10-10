'use client';

import { ArrowUpRight, Link2 } from 'lucide-react';
import Link from 'next/link';
import { useActionState, useEffect, useId, useState, type ReactNode } from 'react';

import type { RelinkDeckState } from '@/app/action-types';
import { relinkDeckAction } from '@/app/actions';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { fieldDescriptionIds, Input } from '@/components/ui/field';
import { AbsoluteTime } from '@/components/ui/relative-time';
import { routes } from '@/lib/routes';
import type { DeckRelinkDTO } from '@/server/services/types';

export interface MoxfieldDeckPanelProps {
  deckId: string;
  /** The Moxfield public id the deck follows. */
  externalId: string;
  /** Its URL on Moxfield. */
  url: string;
  /** The deck's earlier Moxfield decks, newest change first. */
  relinks: readonly DeckRelinkDTO[];
}

/** Id of the panel, the target of {@link ChangeMoxfieldDeckLink}. */
const PANEL_ID = 'moxfield-deck';

/** Asks the page's {@link MoxfieldDeckPanel} to open its form. */
const OPEN_EVENT = 'git-moxfield:change-moxfield-deck';

/**
 * A link that opens "Change Moxfield deck" (and scrolls to it), for messages that suggest
 * it, such as "Deck not found on Moxfield". Without JavaScript it scrolls to the panel.
 * With it, the link does not navigate: following the fragment would take the focus from
 * the form's field, which the form gives it as it opens.
 */
export function ChangeMoxfieldDeckLink({ children }: { children: ReactNode }) {
  return (
    <a
      href={`#${PANEL_ID}`}
      className="font-medium text-accent hover:underline"
      onClick={(event) => {
        event.preventDefault();
        document.getElementById(PANEL_ID)?.scrollIntoView({ block: 'nearest' });
        window.dispatchEvent(new Event(OPEN_EVENT));
      }}
    >
      {children}
    </a>
  );
}

/**
 * The deck's Moxfield deck on its owner's Status page: a link to it, the Moxfield decks it
 * followed before, and "Change Moxfield deck" for a deck that was deleted on Moxfield and
 * made again (which gives it a new link). Changing keeps every version; the form opens in
 * place and the server action opens the Status page again, which greets the change.
 */
export function MoxfieldDeckPanel({ deckId, externalId, url, relinks }: MoxfieldDeckPanelProps) {
  const [open, setOpen] = useState(false);
  /** After Cancel, the trigger takes focus back (it remounts in place of the form). */
  const [returnFocus, setReturnFocus] = useState(false);

  useEffect(() => {
    const openForm = (): void => {
      setOpen(true);
    };
    window.addEventListener(OPEN_EVENT, openForm);
    return () => {
      window.removeEventListener(OPEN_EVENT, openForm);
    };
  }, []);

  return (
    <Card
      as="section"
      id={PANEL_ID}
      aria-labelledby="moxfield-deck-heading"
      className="flex scroll-mt-20 flex-col gap-3"
    >
      <div>
        <h2 id="moxfield-deck-heading" className="text-base font-semibold text-fg">
          Moxfield deck
        </h2>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1 inline-flex max-w-full items-center gap-1 text-sm font-medium text-accent hover:underline"
        >
          <span className="truncate font-mono text-[0.8125rem]">{externalId}</span>
          <ArrowUpRight aria-hidden="true" className="size-4 shrink-0" />
          <span className="sr-only">(opens on Moxfield in a new tab)</span>
        </a>
        {relinks.length > 0 && (
          <ul aria-label="Earlier Moxfield decks" className="mt-2 flex flex-col gap-1 text-xs text-muted">
            {relinks.map((relink) => (
              <li key={`${relink.at}:${relink.previousExternalId}`} className="break-words">
                Followed{' '}
                <span className="font-mono text-[0.75rem] break-all text-fg/80">
                  {relink.previousExternalId}
                </span>{' '}
                <span className="whitespace-nowrap">
                  until <AbsoluteTime value={relink.at} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {open ? (
        <RelinkForm
          deckId={deckId}
          onCancel={() => {
            setOpen(false);
            setReturnFocus(true);
          }}
        />
      ) : (
        <div>
          <Button
            variant="ghost"
            size="sm"
            className="-ml-3"
            icon={<Link2 aria-hidden="true" className="size-4" />}
            autoFocus={returnFocus}
            onClick={() => {
              setOpen(true);
            }}
          >
            Change Moxfield deck
          </Button>
        </div>
      )}
    </Card>
  );
}

function RelinkForm({ deckId, onCancel }: { deckId: string; onCancel: () => void }) {
  const id = useId();
  const ids = fieldDescriptionIds(id);
  const explanationId = `${id}-explanation`;
  const [state, formAction, pending] = useActionState<RelinkDeckState, FormData>(relinkDeckAction, {
    status: 'idle',
  });
  const error = state.status === 'error' ? state : null;

  return (
    <form
      action={formAction}
      aria-label="Change Moxfield deck"
      aria-describedby={explanationId}
      className="flex flex-col gap-3 rounded-lg border border-accent/30 bg-accent-soft/60 p-3 md:p-4"
    >
      <input type="hidden" name="deckId" value={deckId} />
      <p id={explanationId} className="text-sm text-pretty text-fg">
        Deleted this deck on Moxfield and made it again? Its new copy has a new link. Paste it here: every
        version stays, and new versions continue from the new deck. Nothing is changed on Moxfield.
      </p>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={id} className="text-sm font-medium text-fg">
          New Moxfield deck URL
        </label>
        <Input
          id={id}
          name="deck"
          type="text"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus
          required
          defaultValue={error?.input ?? ''}
          key={error === null ? 'idle' : `error:${error.input}:${error.message}`}
          placeholder="https://moxfield.com/decks/…"
          aria-invalid={error !== null || undefined}
          aria-describedby={error !== null ? ids.error : undefined}
        />
        {error !== null && (
          <p id={ids.error} role="alert" className="text-sm text-pretty text-remove">
            {error.message}
            {error.trackedBy !== undefined && (
              <>
                {' '}
                <Link
                  href={routes.deck(error.trackedBy.deckId)}
                  className="font-medium text-accent hover:underline"
                >
                  Open “{error.trackedBy.name}”
                </Link>
              </>
            )}
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" size="sm" loading={pending}>
          Change deck
        </Button>
        <Button variant="secondary" size="sm" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
