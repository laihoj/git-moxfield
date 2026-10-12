/**
 * The base of each layer's errors (`RepositoryError`, `ServiceError`, ...): a machine-readable
 * `code` next to the message. Each layer keeps a class of its own, for `instanceof` and `name`.
 */
export class CodedError<C extends string> extends Error {
  readonly code: C;

  constructor(code: C, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}
