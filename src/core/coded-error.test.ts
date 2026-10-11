import { describe, expect, it } from 'vitest';

import { CodedError, codedErrorGuard } from './coded-error';

class FirstError extends CodedError<'a' | 'b'> {
  override readonly name = 'FirstError';
}
class SecondError extends CodedError<'a'> {
  override readonly name = 'SecondError';
}

const isFirstError = codedErrorGuard(FirstError);

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

describe('codedErrorGuard', () => {
  it('recognizes the class, optionally with a code', () => {
    const error = new FirstError('a', 'x');
    expect(isFirstError(error)).toBe(true);
    expect(isFirstError(error, 'a')).toBe(true);
    expect(isFirstError(error, 'b')).toBe(false);
  });

  it('does not take errors of other classes or other values', () => {
    expect(isFirstError(new SecondError('a', 'x'))).toBe(false);
    expect(isFirstError(new Error('x'))).toBe(false);
    expect(isFirstError({ name: 'FirstError', code: 'a' })).toBe(false);
    expect(isFirstError(null)).toBe(false);
  });
});
