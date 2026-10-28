'use client';

import clsx from 'clsx';
import { startTransition, useOptimistic, useRef, type KeyboardEvent } from 'react';

import { setDeckViewAction } from '@/app/view-actions';
import { DECK_VIEW_DESCRIPTIONS, DECK_VIEW_LABELS, DECK_VIEWS, type DeckView } from '@/core/deck-view';

export interface DeckViewToggleProps {
  /** The view the page was rendered in. */
  view: DeckView;
}

/**
 * MTG · cEDH: the deck view of this browser (`@/core/deck-view`), in the deck's chrome.
 * A segmented control of radios; choosing one calls a server action, which remembers
 * the view in a cookie and renders the page again. The chosen segment switches at once
 * (optimistically) and falls back if the action fails. Arrow keys move between the
 * segments, as in a radio group. Buttons, not a form: a share link's pages must hold
 * nothing that posts anywhere (see `tests/e2e/support/share.ts`), and the action is
 * called with the view alone.
 */
export function DeckViewToggle({ view }: DeckViewToggleProps) {
  const [current, setCurrent] = useOptimistic(view);
  const segments = useRef<(HTMLButtonElement | null)[]>([]);

  function choose(option: DeckView): void {
    if (option === current) return;
    startTransition(async () => {
      setCurrent(option);
      await setDeckViewAction(option);
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (step === undefined) return;
    const focused = segments.current.findIndex((segment) => segment === document.activeElement);
    if (focused === -1) return;
    event.preventDefault();
    const index = (focused + step + DECK_VIEWS.length) % DECK_VIEWS.length;
    segments.current[index]?.focus();
    const option = DECK_VIEWS[index];
    if (option !== undefined) choose(option);
  }

  return (
    <div
      role="radiogroup"
      aria-label="Deck view"
      className="inline-flex rounded-lg border border-border bg-surface-2 p-0.5"
      onKeyDown={onKeyDown}
    >
      {DECK_VIEWS.map((option, index) => {
        const active = option === current;
        return (
          <button
            key={option}
            ref={(element) => {
              segments.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={DECK_VIEW_LABELS[option]}
            tabIndex={active ? 0 : -1}
            // The name is the label; the view's description becomes the tooltip and the accessible description.
            title={DECK_VIEW_DESCRIPTIONS[option]}
            className={clsx(
              'flex h-10 items-center justify-center rounded-md px-3 text-sm font-medium transition-colors md:h-8',
              active ? 'bg-surface text-fg shadow-card dark:bg-surface-3' : 'text-muted hover:text-fg',
            )}
            onClick={() => {
              choose(option);
            }}
          >
            {DECK_VIEW_LABELS[option]}
          </button>
        );
      })}
    </div>
  );
}
