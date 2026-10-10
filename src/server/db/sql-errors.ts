/**
 * Classifies database errors into a small set of kinds the rest of the app can act on,
 * the same way for every driver and connection mode:
 *
 * - **Local libSQL** (`file:`, `:memory:`): `LibsqlError` (or `LibsqlBatchError`) with
 *   `code: 'SQLITE_CONSTRAINT'`, an `extendedCode` such as
 *   `'SQLITE_CONSTRAINT_FOREIGNKEY'` and a numeric `rawCode`; its `cause` is the native
 *   `SqliteError` (`code` = the extended code).
 * - **Remote libSQL** (Turso, `sqld` over HTTP): `code` only (`'SQLITE_CONSTRAINT'`,
 *   `'TRANSACTION_TIMEOUT'`, ...), no `extendedCode`/`rawCode`. The kind of a constraint
 *   failure is in the message: `'SQLITE_CONSTRAINT: SQLite error: FOREIGN KEY constraint
 *   failed'`, with the code prefix doubled (`'SQLITE_CONSTRAINT: SQLITE_CONSTRAINT: ...'`)
 *   for statements in a transaction or batch.
 * - **better-sqlite3** (until it is removed): a bare `SqliteError` whose `code` is the
 *   extended code.
 * - Drizzle query builders wrap the driver error in a `DrizzleQueryError` (`cause`);
 *   `db.batch()` and raw client calls throw the driver error itself. App errors may wrap
 *   either again (`RepositoryError`, `TransactionAbortedError`, ...).
 *
 * The classifier walks the `cause` chain and uses the first link that identifies the
 * failure. Two consequences of the remote protocol are deliberate:
 *
 * - A PRIMARY KEY violation is reported as `'unique'` everywhere. Remotely it is
 *   indistinguishable from a UNIQUE index violation (both read `UNIQUE constraint failed:
 *   table.column`), so a separate kind would only exist in local tests.
 * - A `SQLITE_CONSTRAINT` whose message is none of SQLite's built-in constraint texts is a
 *   trigger's `RAISE(...)` text (ours all say "... immutable ...") and reported as
 *   `'trigger'`. Triggers must use `RAISE(ABORT, ...)`: `RAISE(ROLLBACK, ...)` would end
 *   the whole transaction.
 */

/** What went wrong, as far as callers need to know. */
export type SqlErrorKind =
  /** A row references a row that does not exist (or is still referenced). */
  | 'foreign-key'
  /** A UNIQUE index or PRIMARY KEY already has this value. */
  | 'unique'
  /** A NOT NULL column got NULL. */
  | 'not-null'
  /** A CHECK constraint failed. */
  | 'check'
  /** A trigger rejected the statement with `RAISE(ABORT, message)` (immutable history). */
  | 'trigger'
  /** The database is locked by another connection (local) or writer. Retry the transaction. */
  | 'busy'
  /**
   * Remote: the server rolled the transaction back because it held the write lock for
   * more than 5 s while another writer waited. Retry the transaction.
   */
  | 'transaction-timeout'
  /** Remote: the stream (and its transaction) expired after about 10 s of inactivity. Retry. */
  | 'stream-expired'
  /** Turso: the plan's quota (rows read/written, storage) is exhausted; every query fails. */
  | 'quota-blocked'
  /** A string or blob is larger than the database accepts (5,000,000 bytes remotely). */
  | 'too-big'
  /** Anything else, including errors that did not come from the database at all. */
  | 'other';

export interface SqlErrorClassification {
  readonly kind: SqlErrorKind;
  /**
   * The driver's message without code prefixes or `SQLite error: `, e.g.
   * `'FOREIGN KEY constraint failed'`, `'commits are immutable'`. Never contains the
   * query's bound parameters (a `DrizzleQueryError` message does), so it is safe to log.
   * For an error that did not come from the database, its own message.
   */
  readonly message: string;
  /**
   * Whether running the whole transaction (or batch) again may succeed: the failure was
   * transient and nothing was committed (`busy`, `transaction-timeout`, `stream-expired`).
   */
  readonly retryable: boolean;
  /**
   * The most specific code seen: an extended SQLite code locally
   * (`'SQLITE_CONSTRAINT_FOREIGNKEY'`), a libSQL code remotely (`'SQLITE_CONSTRAINT'`,
   * `'TRANSACTION_TIMEOUT'`, `'SQL_PARSE_ERROR'`). `undefined` for non-database errors.
   */
  readonly code: string | undefined;
}

const RETRYABLE_KINDS: ReadonlySet<SqlErrorKind> = new Set(['busy', 'transaction-timeout', 'stream-expired']);

const CONSTRAINT_KINDS: ReadonlySet<SqlErrorKind> = new Set([
  'foreign-key',
  'unique',
  'not-null',
  'check',
  'trigger',
]);

/**
 * Whether `kind` is a constraint violation: the statement was rejected and undone, but a
 * transaction it ran in is still open and usable.
 */
export function isConstraintViolation(kind: SqlErrorKind): boolean {
  return CONSTRAINT_KINDS.has(kind);
}

/** Extended SQLite result codes (as names) that identify a kind. */
const EXTENDED_CODE_KINDS: ReadonlyMap<string, SqlErrorKind> = new Map<string, SqlErrorKind>([
  ['SQLITE_CONSTRAINT_FOREIGNKEY', 'foreign-key'],
  ['SQLITE_CONSTRAINT_UNIQUE', 'unique'],
  ['SQLITE_CONSTRAINT_PRIMARYKEY', 'unique'],
  ['SQLITE_CONSTRAINT_ROWID', 'unique'],
  ['SQLITE_CONSTRAINT_NOTNULL', 'not-null'],
  ['SQLITE_CONSTRAINT_CHECK', 'check'],
  ['SQLITE_CONSTRAINT_TRIGGER', 'trigger'],
  ['SQLITE_TOOBIG', 'too-big'],
]);

/** The same codes as numbers (`rawCode`), for errors that carry only those. */
const RAW_CODE_KINDS: ReadonlyMap<number, SqlErrorKind> = new Map<number, SqlErrorKind>([
  [787, 'foreign-key'],
  [2067, 'unique'],
  [1555, 'unique'],
  [2579, 'unique'],
  [1299, 'not-null'],
  [275, 'check'],
  [1811, 'trigger'],
]);

/** Primary result codes (`rawCode & 0xff`): SQLITE_BUSY, SQLITE_LOCKED, SQLITE_TOOBIG. */
const PRIMARY_RAW_CODE_KINDS: ReadonlyMap<number, SqlErrorKind> = new Map<number, SqlErrorKind>([
  [5, 'busy'],
  [6, 'busy'],
  [18, 'too-big'],
]);

/** libSQL / Hrana / Turso codes that identify a kind. */
const LIBSQL_CODE_KINDS: ReadonlyMap<string, SqlErrorKind> = new Map<string, SqlErrorKind>([
  ['TRANSACTION_TIMEOUT', 'transaction-timeout'],
  ['STREAM_EXPIRED', 'stream-expired'],
  ['BLOCKED', 'quota-blocked'],
]);

/** Driver and system error codes are upper snake case; app error codes are kebab case. */
const DRIVER_CODE = /^[A-Z][A-Z0-9_]*$/;

const MAX_CAUSE_DEPTH = 16;

/** The fields of one error in a cause chain that the classifier looks at. */
interface ChainLink {
  readonly code: string | undefined;
  readonly extendedCode: string | undefined;
  readonly rawCode: number | undefined;
  readonly message: string;
  /** A `DrizzleQueryError`: its message embeds the SQL and the bound parameters. */
  readonly isQueryWrapper: boolean;
}

/** `value[key]`, or `undefined` when reading it throws (a getter or a proxy). */
function field(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function stringField(value: object, key: string): string | undefined {
  const result = field(value, key);
  return typeof result === 'string' ? result : undefined;
}

function toLink(value: unknown): ChainLink {
  if (typeof value !== 'object' || value === null) {
    return {
      code: undefined,
      extendedCode: undefined,
      rawCode: undefined,
      message: typeof value === 'string' ? value : String(value),
      isQueryWrapper: false,
    };
  }
  const rawCode = field(value, 'rawCode');
  const message = stringField(value, 'message') ?? '';
  return {
    code: stringField(value, 'code'),
    extendedCode: stringField(value, 'extendedCode'),
    rawCode: typeof rawCode === 'number' ? rawCode : undefined,
    message,
    isQueryWrapper:
      typeof field(value, 'query') === 'string' &&
      Array.isArray(field(value, 'params')) &&
      message.startsWith('Failed query:'),
  };
}

/** `error`, its `cause`, the cause's `cause`, ... (bounded; cycles are cut). */
function causeChain(error: unknown): ChainLink[] {
  const links: ChainLink[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (links.length < MAX_CAUSE_DEPTH && !seen.has(current)) {
    seen.add(current);
    links.push(toLink(current));
    if (typeof current !== 'object' || current === null) break;
    current = field(current, 'cause');
    if (current === undefined) break;
  }
  return links;
}

/** Removes `CODE: ` prefixes (possibly repeated) and `SQLite error: ` from a driver message. */
function cleanMessage(message: string, codes: ReadonlySet<string>): string {
  let text = message.trim();
  for (let changed = true; changed;) {
    changed = false;
    for (const code of codes) {
      if (text.startsWith(`${code}: `)) {
        text = text.slice(code.length + 2);
        changed = true;
      }
    }
    if (text.startsWith('SQLite error: ')) {
      text = text.slice('SQLite error: '.length);
      changed = true;
    }
  }
  return text;
}

function kindFromSqliteCode(code: string): SqlErrorKind | undefined {
  const mapped = EXTENDED_CODE_KINDS.get(code);
  if (mapped !== undefined) return mapped;
  if (/^SQLITE_(BUSY|LOCKED)(_|$)/.test(code)) return 'busy';
  return undefined;
}

function kindFromRawCode(rawCode: number): SqlErrorKind | undefined {
  return RAW_CODE_KINDS.get(rawCode) ?? PRIMARY_RAW_CODE_KINDS.get(rawCode & 0xff);
}

/** The kind of a `SQLITE_CONSTRAINT` failure that carries no extended code (remote). */
function kindFromConstraintMessage(message: string): SqlErrorKind {
  if (message.includes('FOREIGN KEY constraint failed')) return 'foreign-key';
  if (message.includes('UNIQUE constraint failed')) return 'unique';
  if (message.includes('NOT NULL constraint failed')) return 'not-null';
  if (message.includes('CHECK constraint failed')) return 'check';
  // SQLITE_CONSTRAINT_DATATYPE (STRICT tables): "cannot store TEXT value in INTEGER column t.c".
  if (/cannot store \S+ value in \S+ column/.test(message)) return 'other';
  // Anything else is the text of a trigger's RAISE(ABORT, '...').
  return 'trigger';
}

/** The kind one link identifies on its own, with the code that identified it. */
function classifyLink(link: ChainLink, message: string): { kind: SqlErrorKind; code: string } | undefined {
  for (const code of [link.extendedCode, link.code]) {
    if (code?.startsWith('SQLITE_')) {
      const kind = kindFromSqliteCode(code);
      if (kind !== undefined) return { kind, code };
    }
  }
  if (link.rawCode !== undefined) {
    const kind = kindFromRawCode(link.rawCode);
    if (kind !== undefined) return { kind, code: link.extendedCode ?? link.code ?? String(link.rawCode) };
  }
  if (link.code === undefined) return undefined;
  const libsqlKind = LIBSQL_CODE_KINDS.get(link.code);
  if (libsqlKind !== undefined) return { kind: libsqlKind, code: link.code };
  if (link.code === 'ARGS_INVALID' && /too big/i.test(message)) return { kind: 'too-big', code: link.code };
  if (link.code === 'SQLITE_CONSTRAINT') return { kind: kindFromConstraintMessage(message), code: link.code };
  // Remote errors carry no extended code; a lock conflict reads "database is locked".
  if (DRIVER_CODE.test(link.code) && /database (table )?is locked/.test(message)) {
    return { kind: 'busy', code: link.code };
  }
  return undefined;
}

/**
 * Classifies `error` (anything a database call, a repository or a transaction can throw)
 * by walking its `cause` chain. Never throws.
 */
export function classifySqlError(error: unknown): SqlErrorClassification {
  const links = causeChain(error);
  const codes = new Set(
    links.flatMap((link) => [link.code, link.extendedCode]).filter((code) => code !== undefined),
  );
  const driverLinks = links.filter((link) => link.code !== undefined && DRIVER_CODE.test(link.code));

  let identified: { kind: SqlErrorKind; code: string } | undefined;
  for (const link of links) {
    identified = classifyLink(link, cleanMessage(link.message, codes));
    if (identified !== undefined) break;
  }

  // The innermost driver error has the plainest message (no code prefixes).
  const messageSource =
    driverLinks.at(-1) ?? links.find((link) => !link.isQueryWrapper && link.message !== '') ?? links[0];
  const message =
    messageSource === undefined || messageSource.isQueryWrapper
      ? 'Database query failed'
      : cleanMessage(messageSource.message, codes) || 'Unknown error';

  const kind = identified?.kind ?? 'other';
  return {
    kind,
    message,
    retryable: RETRYABLE_KINDS.has(kind),
    code: identified?.code ?? driverLinks[0]?.extendedCode ?? driverLinks[0]?.code,
  };
}

/** Whether `error` (or an error in its cause chain) is a database error of `kind`. */
export function isSqlErrorKind(error: unknown, kind: SqlErrorKind): boolean {
  return classifySqlError(error).kind === kind;
}

/** Whether running the failed transaction or batch again may succeed (see {@link SqlErrorClassification.retryable}). */
export function isRetryableSqlError(error: unknown): boolean {
  return classifySqlError(error).retryable;
}
