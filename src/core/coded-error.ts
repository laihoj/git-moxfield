/**
 * The shape of the errors each layer defines for failures its callers handle by code
 * (`RepositoryError`, `ServiceError`, ...): a machine-readable `code` next to the message.
 * Every layer keeps a class of its own, so that `instanceof` and `name` tell them apart.
 */
export class CodedError<C extends string> extends Error {
  readonly code: C;

  constructor(code: C, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

/**
 * A type guard for a {@link CodedError} subclass, optionally narrowing to one code:
 * `export const isXError = codedErrorGuard(XError)`.
 */
export function codedErrorGuard<E extends CodedError<string>>(
  errorClass: abstract new (...args: never[]) => E,
): (value: unknown, code?: E['code']) => value is E {
  return (value, code): value is E =>
    value instanceof errorClass && (code === undefined || value.code === code);
}
