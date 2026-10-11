import type { ComponentPropsWithRef } from 'react';

import { Input } from '@/components/ui/field';
import { DEFAULT_MOXFIELD_SITE_ORIGIN } from '@/integrations/moxfield/constants';

export interface DeckUrlInputProps extends Omit<
  ComponentPropsWithRef<'input'>,
  'type' | 'inputMode' | 'autoComplete' | 'autoCapitalize' | 'spellCheck' | 'placeholder'
> {
  /** The Moxfield site the placeholder points at; default: Moxfield itself. */
  siteOrigin?: string;
}

/** The input for a Moxfield deck URL or id: a URL keyboard on phones, nothing autocorrected. */
export function DeckUrlInput({ siteOrigin = DEFAULT_MOXFIELD_SITE_ORIGIN, ...props }: DeckUrlInputProps) {
  return (
    <Input
      type="text"
      inputMode="url"
      autoComplete="off"
      autoCapitalize="none"
      spellCheck={false}
      placeholder={`${siteOrigin}/decks/…`}
      {...props}
    />
  );
}
