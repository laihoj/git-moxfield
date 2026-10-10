'use client';

import { Search, X } from 'lucide-react';
import Form from 'next/form';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';

import { Spinner } from '@/components/ui/spinner';
import { routes } from '@/lib/routes';

const DEBOUNCE_MS = 250;

export interface CardSearchProps {
  deckId: string;
  /** The current `?q=` value. */
  query: string;
}

/**
 * Search box for cards across the deck's whole history. Typing updates `?q=` after a
 * short pause (results are rendered by the server); Enter searches immediately and
 * the form works as a plain GET form without JavaScript.
 */
export function CardSearch({ deckId, query }: CardSearchProps) {
  const router = useRouter();
  const [value, setValue] = useState(query);
  const [pending, startTransition] = useTransition();
  const timer = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
    },
    [],
  );

  function search(next: string): void {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      startTransition(() => {
        router.replace(routes.cards(deckId, { q: next.trim() }), { scroll: false });
      });
    }, DEBOUNCE_MS);
  }

  return (
    <Form action={routes.cards(deckId)} role="search" className="relative">
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
