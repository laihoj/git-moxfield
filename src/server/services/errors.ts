/**
 * Errors thrown by the service layer (deck services and the auth service) for requests
 * that cannot be answered with an outcome value. The UI maps them: `not-found` to a 404
 * (`notFound()`), `invalid-input` to a 400 / form error, `forbidden` to a 404 or 403.
 * Every other outcome is returned as data (see `./types`, `@/server/auth/types`).
 */

export type ServiceErrorCode =
  /** The deck, version or user does not exist (e.g. it was untracked in another tab). */
  | 'not-found'
  /** The input is invalid; the message is user-facing. */
  | 'invalid-input'
  /** The acting user may not do this (e.g. a member calling an admin operation). */
  | 'forbidden';

export class ServiceError extends Error {
  override readonly name = 'ServiceError';
  readonly code: ServiceErrorCode;

  constructor(code: ServiceErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

/** Type guard, optionally narrowing to one error code. */
export function isServiceError(value: unknown, code?: ServiceErrorCode): value is ServiceError {
  return value instanceof ServiceError && (code === undefined || value.code === code);
}
