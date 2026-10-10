import { Bookmark, GitCommitHorizontal, Link2 } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';

import { DeckCard } from '@/components/deck/deck-card';
import { TrackDeckForm } from '@/components/deck/track-deck-form';
import { Card } from '@/components/ui/card';
import { servicesFor } from '@/server/access';
import { requireUser } from '@/server/auth/current-user';

export const dynamic = 'force-dynamic';

// Spelled out in full: the title of the home page does not go through the title template.
export const metadata: Metadata = { title: { absolute: 'Decks · git-moxfield' } };

const LOOP_STEPS = [
  {
    Icon: Link2,
    title: 'Track a deck',
    body: 'Paste the URL of a Moxfield deck. Keep building it on Moxfield like you always do.',
  },
  {
    Icon: Bookmark,
    title: 'Update from Moxfield',
    body: 'git-moxfield fetches the deck, or you send it with one click on the bookmarklet.',
  },
  {
    Icon: GitCommitHorizontal,
    title: 'Review and commit',
    body: 'See exactly what changed, cards moved between boards included, and save it as a version.',
  },
] as const;

export default async function DecksPage() {
  const services = await servicesFor(await requireUser());
  const decks = await services.listDecks();

  if (decks.length === 0) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-8 pt-2 md:pt-6">
        <div className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-balance text-fg md:text-3xl">
            Version history for your Moxfield decks
          </h1>
          <p className="mx-auto mt-2 max-w-lg text-base text-pretty text-muted">
            Commit versions of a deck, compare any two, follow a card through every change, and restore an old
            list with copy and paste.
          </p>
        </div>

        <Card as="section" aria-labelledby="track-heading">
          <h2 id="track-heading" className="mb-3 text-base font-semibold text-fg">
            Track a Moxfield deck
          </h2>
          <TrackDeckForm autoFocus />
        </Card>

        <section aria-labelledby="loop-heading">
          <h2
            id="loop-heading"
            className="mb-3 text-center text-sm font-semibold tracking-wide text-muted uppercase"
          >
            How it works
          </h2>
          <ol className="grid gap-3 md:grid-cols-3">
            {LOOP_STEPS.map(({ Icon, title, body }, index) => (
              <li
                key={title}
                className="flex gap-3.5 rounded-xl border border-border bg-surface p-4 shadow-card md:flex-col md:gap-3 md:p-5"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
                  <Icon aria-hidden="true" className="size-4" />
                </span>
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-subtle tabular">Step {index + 1}</p>
                  <h3 className="text-sm font-semibold text-fg">{title}</h3>
                  <p className="mt-1 text-sm text-muted">{body}</p>
                </div>
              </li>
            ))}
          </ol>
          <p className="mx-auto mt-4 max-w-lg text-center text-sm text-balance text-muted">
            Moxfield blocks most servers, so the{' '}
            <Link href="/setup" className="font-medium text-accent hover:underline">
              Send to git-moxfield bookmarklet
            </Link>{' '}
            is usually how decks get here. Set it up once.
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-fg">Decks</h1>
        <p className="text-sm text-muted">
          Moxfield stays your editor. Commit versions here when the deck changes.
        </p>
      </div>

      <section aria-labelledby="decks-heading">
        <h2 id="decks-heading" className="sr-only">
          Tracked decks
        </h2>
        <ul className="grid gap-3 md:grid-cols-2">
          {decks.map((deck) => (
            <DeckCard key={deck.id} deck={deck} />
          ))}
        </ul>
      </section>

      {/*
       * Spans the deck grid. On wide screens its two halves line up with the grid's
       * columns: the gap equals the grid gap plus both cards' border and padding.
       */}
      <Card
        as="section"
        aria-labelledby="track-heading"
        className="grid items-center gap-x-[calc(0.75rem+2*(1.25rem+1px))] gap-y-3 md:grid-cols-2"
      >
        <div>
          <h2 id="track-heading" className="text-base font-semibold text-fg">
            Track another deck
          </h2>
          <p className="mt-0.5 text-sm text-pretty text-muted">
            Paste the URL of a public or unlisted Moxfield deck. Nothing is ever written to Moxfield.
          </p>
        </div>
        <TrackDeckForm hint={false} />
      </Card>
    </div>
  );
}
