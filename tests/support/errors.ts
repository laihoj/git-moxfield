/**
 * Capturing and asserting what an operation rejects or throws. The kinds of errors have
 * helpers of their own next to the code that throws them (`expectRepositoryError`,
 * `expectServiceError`, …); they are built on these.
 */
import { expect } from 'vitest';

/**
 * What `operation` (a promise, or a function returning one, a value or throwing) rejects
 * or throws.
 * @throws {Error} when it does not fail.
 */
export async function rejectionOf(operation: Promise<unknown> | (() => unknown)): Promise<unknown> {
  try {
    await (typeof operation === 'function' ? operation() : operation);
  } catch (error) {
    return error;
  }
  throw new Error('Expected the operation to fail');
}

/**
 * Asserts that `operation` fails with an error of class `type` that has `fields`
 * (compared as `toMatchObject` does); returns the error.
 */
export async function expectRejection<E extends Error>(
  operation: Promise<unknown> | (() => unknown),
  type: abstract new (...args: never[]) => E,
  fields?: Partial<Record<keyof E, unknown>>,
): Promise<E> {
  const caught = await rejectionOf(operation);
  expect(caught).toBeInstanceOf(type);
  if (fields !== undefined) expect(caught).toMatchObject(fields);
  return caught as E;
}
