import { describe, expect, it } from 'vitest';

import { DeckSourceError } from '../deck-source';

import { moxfieldError, moxfieldSchemaError } from './errors';

describe('moxfieldError', () => {
  it('names Moxfield as the source and carries the extras', () => {
    const cause = new Error('socket');
    const error = moxfieldError('rate-limited', 'Slow down.', { status: 429, retryAfterSeconds: 7, cause });
    expect(error).toBeInstanceOf(DeckSourceError);
    expect(error).toMatchObject({
      code: 'rate-limited',
      message: 'Slow down.',
      source: 'moxfield',
      status: 429,
      retryAfterSeconds: 7,
      cause,
    });
  });
});

describe('moxfieldSchemaError', () => {
  it('is a schema error with just the message', () => {
    expect(moxfieldSchemaError('Not JSON.')).toMatchObject({ code: 'schema', message: 'Not JSON.' });
  });

  it('appends the issues, at most 20 of them, so a malformed payload cannot make an endless message', () => {
    const issues = Array.from({ length: 30 }, (_, index) => `issue ${index + 1}`);
    const { message } = moxfieldSchemaError('The payload is malformed:', issues);
    expect(message.startsWith('The payload is malformed: issue 1; issue 2;')).toBe(true);
    expect(message.endsWith('issue 20')).toBe(true);
    expect(message).not.toContain('issue 21');
  });

  it('keeps the cause', () => {
    const cause = new Error('inner');
    expect(moxfieldSchemaError('Bad.', [], cause).cause).toBe(cause);
  });
});
