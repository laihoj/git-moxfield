import type { ComponentPropsWithRef } from 'react';

import { Input } from '@/components/ui/field';
import { MAX_DISPLAY_NAME_LENGTH } from '@/core/text-limits';

/**
 * The input for a display name (`name`): as long as the server accepts, and offered to
 * browsers as a nickname. Used where people choose or change their name.
 */
export function DisplayNameInput(
  props: Omit<ComponentPropsWithRef<'input'>, 'name' | 'maxLength' | 'autoComplete'>,
) {
  return (
    <Input name="name" required maxLength={MAX_DISPLAY_NAME_LENGTH} autoComplete="nickname" {...props} />
  );
}
