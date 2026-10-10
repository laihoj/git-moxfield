/**
 * The one error the history import reports to the operator: a problem with the source
 * file, the arguments or the data, with a message that says what to do. Anything else
 * escaping the import is unexpected.
 */
export class HistoryImportError extends Error {
  override readonly name = 'HistoryImportError';
}

/** Type guard for {@link HistoryImportError}. */
export function isHistoryImportError(value: unknown): value is HistoryImportError {
  return value instanceof HistoryImportError;
}
