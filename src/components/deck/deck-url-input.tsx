import type { ComponentPropsWithRef } from 'react';

import { Input } from '@/components/ui/field';
import { DEFAULT_MOXFIELD_SITE_ORIGIN } from '@/integrations/moxfield/constants';

/**
 * The input for a Moxfield deck URL or id: a URL keyboard on phones, nothing autocorrected.
 * `siteOrigin` is the Moxfield site the placeholder points at.
 */
export function DeckUrlInput({
  siteOrigin = DEFAULT_MOXFIELD_SITE_ORIGIN,
  ...props
}: ComponentPropsWithRef<'input'> & { siteOrigin?: string }) {
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
