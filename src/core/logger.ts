/**
 * The structured logger the app logs through (`createLogger` in `src/server/logger.ts`
 * implements it). Only the contract lives here, so adapters that must not import the
 * server can accept a logger all the same.
 */
export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}
