import { describe, expect, it } from 'vitest';

import { CodedError } from './coded-error';

class FirstError extends CodedError<'a' | 'b'> {
  override readonly name = 'FirstError';
}

describe('CodedError', () => {
  it('carries the code, the message and the cause, under the name of its class', () => {
    const cause = new Error('underlying');
    const error = new FirstError('b', 'went wrong', { cause });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('FirstError');
    expect(error.code).toBe('b');
    expect(error.message).toBe('went wrong');
    expect(error.cause).toBe(cause);
    expect(new FirstError('a', 'no cause').cause).toBeUndefined();
  });
});
