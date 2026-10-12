/**
 * Errors raised by repositories.
 *
 * Repositories validate their preconditions and the shape of stored data, and report
 * every failure through {@link RepositoryError} with a machine-readable code, so the
 * service layer can map failures to user-facing outcomes without parsing SQLite
 * messages. Raw driver errors only escape for genuinely unexpected conditions.
 */
import { CodedError } from '@/core/coded-error';

export type RepositoryErrorCode =
  /** The caller violated a documented precondition (invalid tag, non-canonical snapshot, bad commit id, ...). */
  | 'invalid-input'
  /** A referenced row (deck, branch, commit, snapshot, ...) does not exist. */
  | 'not-found'
  /** A uniqueness rule or a compare-and-set expectation failed. */
  | 'conflict'
  /** Stored data does not have the expected shape or does not match its content hash. */
  | 'corrupt-data'
  /** Stored data uses a schema version or encoding this build cannot read. */
  | 'unsupported-version';

export class RepositoryError extends CodedError<RepositoryErrorCode> {
  override readonly name = 'RepositoryError';
}

/** Type guard, optionally narrowing to a specific error code. */
export function isRepositoryError(value: unknown, code?: RepositoryErrorCode): value is RepositoryError {
  return value instanceof RepositoryError && (code === undefined || value.code === code);
}
