/** The {@link DeckSourceError}s the Moxfield adapter throws, all naming Moxfield as their source. */
import { DeckSourceError, type DeckSourceErrorCode } from '../deck-source';

import { MOXFIELD_SOURCE_ID } from './constants';

/** Most issues a schema error names in its message. */
const MAX_REPORTED_ISSUES = 20;

export function moxfieldError(
  code: DeckSourceErrorCode,
  message: string,
  extra: { status?: number; retryAfterSeconds?: number; cause?: unknown } = {},
): DeckSourceError {
  return new DeckSourceError(code, message, { source: MOXFIELD_SOURCE_ID, ...extra });
}

/** A `schema` error: Moxfield's data is not what the adapter understands. `issues` are appended to `message`. */
export function moxfieldSchemaError(
  message: string,
  issues: readonly string[] = [],
  cause?: unknown,
): DeckSourceError {
  const detail = issues.length > 0 ? ` ${issues.slice(0, MAX_REPORTED_ISSUES).join('; ')}` : '';
  return moxfieldError('schema', `${message}${detail}`, cause === undefined ? {} : { cause });
}
