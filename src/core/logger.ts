/** The contract of `createLogger` (`src/server/logger.ts`), for code that must not import the server. */
export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

/** The levels, least severe first: one per {@link Logger} method. */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const satisfies readonly (keyof Logger)[];
export type LogLevel = (typeof LOG_LEVELS)[number];
