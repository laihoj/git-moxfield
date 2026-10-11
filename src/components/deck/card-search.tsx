'use client';

import { Search, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Form } from '@/components/ui/navigation';
import { Spinner } from '@/components/ui/spinner';
import { useRestartableTimeout } from '@/components/ui/use-timeout';
import { deckRoutes, type DeckScope } from '@/lib/routes';

const DEBOUNCE_MS = 250;

export interface CardSearchProps {
  /** The deck pages the search runs within (the owner's or a share link's). */
  scope: DeckScope;
  /** The current `?q=` value. */
  query: string;
}

/**
 * Search box for cards across the deck's whole history. Typing updates `?q=` after a
 * short pause (results are rendered by the server); Enter searches immediately and
 * the form works as a plain GET form without JavaScript.
 */
export function CardSearch({ scope, query }: CardSearchProps) {
  const router = useRouter();
  const routes = deckRoutes(scope);
  const [value, setValue] = useState(query);
  const [pending, startTransition] = useTransition();
  const debounce = useRestartableTimeout();

  function search(next: string): void {
    debounce.start(() => {
      startTransition(() => {
        router.replace(routes.cards({ q: next.trim() }), { scroll: false });
      });
    }, DEBOUNCE_MS);
  }

  return (
    <Form action={routes.cards()} role="search" className="relative">
      <label htmlFor="card-search" className="sr-only">
        Search cards
      </label>
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-3.5 size-4.5 -translate-y-1/2 text-muted"
      />
      <input
        id="card-search"
        name="q"
        type="search"
        value={value}
        placeholder="Search any card that was ever in this deck"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        enterKeyHint="search"
        className="block h-12 w-full rounded-xl border border-border-strong bg-surface pr-11 pl-10 text-base text-fg shadow-card placeholder:text-subtle focus:border-accent focus:ring-3 focus:ring-accent/20 focus:outline-none [&::-webkit-search-cancel-button]:hidden"
        onChange={(event) => {
          setValue(event.target.value);
          search(event.target.value);
        }}
      />
      <span className="absolute top-1/2 right-2 flex -translate-y-1/2 items-center">
        {pending ? (
          <span className="flex size-8 items-center justify-center text-muted">
            <Spinner />
          </span>
        ) : (
          value !== '' && (
            <button
              type="button"
              aria-label="Clear search"
              className="flex size-8 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg"
              onClick={() => {
                setValue('');
                search('');
              }}
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          )
        )}
      </span>
    </Form>
  );
}
