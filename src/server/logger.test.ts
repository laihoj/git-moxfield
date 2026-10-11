import { sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { openRawDatabase } from '@tests/support/libsql';

import { createLogger } from './logger';

const SECRET = 'f00dfeed'.repeat(8);

/** Logs at every level and returns the parsed JSON lines. */
function capture(): () => Record<string, unknown>[] {
  const spies = [
    vi.spyOn(console, 'log').mockImplementation(() => undefined),
    vi.spyOn(console, 'error').mockImplementation(() => undefined),
  ];
  return () =>
    spies.flatMap((spy) =>
      spy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>),
    );
}

/** A real query failure: Drizzle's error carries the SQL and the bound parameters. */
async function failedQuery(): Promise<unknown> {
  const handle = await openRawDatabase({ url: ':memory:' });
  await handle.db.run(sql`CREATE TABLE parents (id TEXT PRIMARY KEY)`);
  await handle.db.run(sql`CREATE TABLE children (token_hash TEXT NOT NULL REFERENCES parents (id))`);
  try {
    await handle.db.run(sql`INSERT INTO children (token_hash) VALUES (${SECRET})`);
  } catch (error) {
    return error;
  }
  throw new Error('expected the query to fail');
}

describe('logger', () => {
  it('never logs the SQL or the bound parameters of a failed query', async () => {
    const error = await failedQuery();
    // The premise: the driver error's message and properties do carry them.
    expect((error as Error).message).toContain(SECRET);
    const lines = capture();

    createLogger('test').error('Insert failed', { error });
    createLogger('test').warn('Insert failed', { failure: error });

    const output = lines();
    expect(output).toHaveLength(2);
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain('INSERT INTO children');
    for (const [entry, key] of [
      [output[0], 'error'],
      [output[1], 'failure'],
    ] as const) {
      expect(entry?.[key]).toMatchObject({
        message: 'Database query failed: FOREIGN KEY constraint failed',
        sqlErrorKind: 'foreign-key',
        sqlErrorCode: 'SQLITE_CONSTRAINT_FOREIGNKEY',
        query: '[redacted]',
        params: '[redacted]',
        cause: { message: expect.stringContaining('FOREIGN KEY constraint failed') as string },
      });
    }
  });

  it('logs other errors with their message, own properties, cause chain and stack frames', () => {
    const lines = capture();
    const cause = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const error = new Error('Fetching the deck failed', { cause });

    createLogger('sources').warn('Refresh failed', { error, deckId: 'deck-1' });

    const [entry] = lines();
    expect(entry).toMatchObject({
      level: 'warn',
      scope: 'sources',
      message: 'Refresh failed',
      deckId: 'deck-1',
      error: {
        name: 'Error',
        message: 'Fetching the deck failed',
        cause: { name: 'Error', message: 'socket hang up', code: 'ECONNRESET' },
      },
    });
    const stack = (entry?.error as { stack: string }).stack.split('\n');
    expect(stack[0]).toBe('Error: Fetching the deck failed');
    expect(stack.length).toBeGreaterThan(1);
    expect(stack.slice(1).every((line) => /^\s+at /.test(line))).toBe(true);
  });

  it('cuts cyclic cause chains', () => {
    const lines = capture();
    const first = new Error('first');
    const second = new Error('second', { cause: first });
    first.cause = second;

    createLogger('test').error('Cycle', { error: first });

    expect(lines()[0]).toMatchObject({
      error: { message: 'first', cause: { message: 'second', cause: '[cause chain truncated]' } },
    });
  });
});
