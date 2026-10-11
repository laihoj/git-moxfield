/**
 * A logger that writes nothing and keeps every entry for assertions. No runtime imports,
 * so a `vi.mock('@/server/logger', …)` factory can load it without mocking circularly.
 */
import type { Logger, LogLevel } from '@/core/logger';

export interface LogEntry {
  level: LogLevel;
  message: string;
  context: Record<string, unknown> | undefined;
}

/** A logger that keeps its entries in `entries` (a new list unless one is given). */
export function recordingLogger(entries: LogEntry[] = []): Logger & { entries: LogEntry[] } {
  const log =
    (level: LogLevel) =>
    (message: string, context?: Record<string, unknown>): void => {
      entries.push({ level, message, context });
    };
  return { entries, debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
}

/**
 * The module `vi.mock('@/server/logger', async () => …)` should return so that every
 * logger the code under test creates records into `entries`:
 * `(await import('@tests/support/recording-logger')).recordingLoggerModule(state.logs)`.
 */
export function recordingLoggerModule(entries: LogEntry[]): { createLogger: () => Logger } {
  return { createLogger: () => recordingLogger(entries) };
}
