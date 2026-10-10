/**
 * Minimal structured logger. One JSON object per line on stdout/stderr, so logs are
 * greppable locally and parseable by any log shipper later.
 */
import 'server-only';

type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function isLevel(value: string | undefined): value is Level {
  return value !== undefined && value in ORDER;
}

function threshold(): number {
  const level = process.env.LOG_LEVEL;
  return isLevel(level) ? ORDER[level] : ORDER.info;
}

function serializeError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const extra: Record<string, unknown> = {};
  for (const key of Object.keys(error)) extra[key] = (error as unknown as Record<string, unknown>)[key];
  return {
    name: error.name,
    message: error.message,
    ...extra,
    cause: error.cause === undefined ? undefined : serializeError(error.cause),
    stack: error.stack?.split('\n').slice(0, 8).join('\n'),
  };
}

function write(level: Level, scope: string, message: string, context?: Record<string, unknown>): void {
  if (ORDER[level] < threshold()) return;
  const entry: Record<string, unknown> = { time: new Date().toISOString(), level, scope, message };
  if (context) {
    for (const [key, value] of Object.entries(context))
      entry[key] = key === 'error' ? serializeError(value) : value;
  }
  const line = JSON.stringify(entry);
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, c) => {
      write('debug', scope, m, c);
    },
    info: (m, c) => {
      write('info', scope, m, c);
    },
    warn: (m, c) => {
      write('warn', scope, m, c);
    },
    error: (m, c) => {
      write('error', scope, m, c);
    },
  };
}
