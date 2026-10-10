/**
 * Shared helpers for component tests (jsdom). Not imported by application code.
 */
import { cleanup, render, within, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach } from 'vitest';

import type { CardFacts, CardKey } from '@/core/model';
import { Toaster } from '@/components/ui/toaster';

// Vitest runs without globals, so Testing Library cannot register its own cleanup.
afterEach(() => {
  cleanup();
});

/** Renders inside the providers the root layout supplies (toasts). */
export function renderWithProviders(ui: ReactElement): RenderResult {
  return render(<Toaster>{ui}</Toaster>);
}

/** Card facts for tests; mana cost and type are the only display-relevant fields. */
export function facts(key: CardKey, name: string, manaCost: string, primaryType = 'Instant'): CardFacts {
  return {
    key,
    name,
    typeLine: primaryType,
    primaryType,
    manaCost,
    cmc: 0,
    colorIdentity: [],
    layout: 'normal',
  };
}

/** Texts of a `MetaList`'s items, without their decorative `·` separators. */
export function metaItemTexts(list: HTMLElement): string[] {
  return within(list)
    .getAllByRole('listitem')
    .map((item) => {
      const copy = item.cloneNode(true) as HTMLElement;
      for (const separator of copy.querySelectorAll('.meta-separator')) separator.remove();
      return copy.textContent;
    });
}
