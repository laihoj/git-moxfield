/**
 * Minimal structured logger. One JSON object per line on stdout/stderr, so logs are
 * greppable locally and parseable by any log shipper later.
 *
 * Errors in the context are serialized with their cause chain, but never with a query's
 * SQL or bound parameters: Drizzle's `DrizzleQueryError` puts both into its message and
 * into `query`/`params` properties, and parameters include secrets (token hashes) and user
 * data. Such errors are logged with the classified database failure instead
 * (`classifySqlError`: kind, code and the driver's message).
 */
import 'server-only';

import { LOG_LEVELS, type Logger, type LogLevel } from '@/core/logger';

import { classifySqlError } from './db/sql-errors';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function isLevel(value: string | undefined): value is LogLevel {
  return value !== undefined && (LOG_LEVELS as readonly string[]).includes(value);
}

function threshold(): number {
  const level = process.env.LOG_LEVEL;
  return isLevel(level) ? ORDER[level] : ORDER.info;
}

/** Error properties that may hold SQL or bound parameters; logged as `[redacted]`. */
const REDACTED_ERROR_KEYS: ReadonlySet<string> = new Set([
  'params',
  'query',
  'sql',
  'args',
  'stmt',
  'statement',
]);

/** Stack frames kept per error. */
const MAX_STACK_FRAMES = 7;

/** Errors serialized per cause chain (cycles are cut as well). */
const MAX_CAUSE_DEPTH = 8;

/** Whether `error` describes a failed query and so may embed its SQL and parameters. */
function describesQuery(error: Error, own: Record<string, unknown>): boolean {
  return 'params' in own || 'query' in own || error.message.startsWith('Failed query:');
}

/** The stack's frames under a header with `message` (the original header repeats the original message). */
function safeStack(error: Error, message: string): string | undefined {
  if (error.stack === undefined) return undefined;
  const frames = error.stack
    .split('\n')
    .filter((line) => /^\s+at /.test(line))
    .slice(0, MAX_STACK_FRAMES);
  return [`${error.name}: ${message}`, ...frames].join('\n');
}

function serializeError(error: unknown, seen = new Set<unknown>()): unknown {
  if (!(error instanceof Error)) return error;
  if (seen.has(error) || seen.size >= MAX_CAUSE_DEPTH) return '[cause chain truncated]';
  seen.add(error);
  const own = error as unknown as Record<string, unknown>;
  const extra: Record<string, unknown> = {};
  for (const key of Object.keys(error)) {
    if (key === 'cause') continue;
    extra[key] = REDACTED_ERROR_KEYS.has(key) ? '[redacted]' : own[key];
  }
  let message = error.message;
  if (describesQuery(error, own)) {
    const failure = classifySqlError(error);
    message = `Database query failed: ${failure.message}`;
    extra.sqlErrorKind = failure.kind;
    if (failure.code !== undefined) extra.sqlErrorCode = failure.code;
  }
  return {
    name: error.name,
    message,
    ...extra,
    cause: error.cause === undefined ? undefined : serializeError(error.cause, seen),
    stack: safeStack(error, message),
  };
}

function write(level: LogLevel, scope: string, message: string, context?: Record<string, unknown>): void {
  if (ORDER[level] < threshold()) return;
  const entry: Record<string, unknown> = { time: new Date().toISOString(), level, scope, message };
  if (context) {
    // Any error, under any key: `JSON.stringify` would otherwise copy its own properties.
    for (const [key, value] of Object.entries(context))
      entry[key] = key === 'error' || value instanceof Error ? serializeError(value) : value;
  }
  const line = JSON.stringify(entry);
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export type { Logger };

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
