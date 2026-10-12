/**
 * What the server action modules share. A plain `server-only` module, not a `'use server'`
 * one: those may only export async functions, and each export becomes an endpoint.
 */
import 'server-only';

import { z } from 'zod';

import type { Logger } from '@/core/logger';
import { isServiceError } from '@/server/services';

/** What the browser is told about a failure that is not the user's to fix (details are logged). */
export const GENERIC_ERROR = 'Something went wrong. Please try again.';

/** Input that is not what the UI sends: a tampered or stale request. */
export const INVALID_REQUEST = 'Invalid request.';

/** Sanity bound for ids from the browser; the services look them up within the user's scope. */
export const idSchema = z.string().trim().min(1).max(128);

/** Longest short form value (names, labels, tokens) read at all; the services validate the exact rules. */
export const MAX_FIELD_LENGTH = 1024;

/** For {@link formString} fields whose own validation bounds them (notes, commit messages, pasted decks). */
export const UNBOUNDED = Number.POSITIVE_INFINITY;

/** A text field of a submitted form, cut to `maxLength`; `''` when it is missing or a file. */
export function formString(formData: FormData, name: string, maxLength = MAX_FIELD_LENGTH): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.slice(0, maxLength) : '';
}

/**
 * User-facing message for a failed action: a service error's own message, else (logged to
 * `log` with `context`) {@link GENERIC_ERROR}, so no internal details reach the browser.
 */
export function failureMessage(
  log: Logger,
  error: unknown,
  what: string,
  context: Record<string, unknown> = {},
): string {
  if (isServiceError(error)) return error.message;
  log.error(`${what} failed`, { error, ...context });
  return GENERIC_ERROR;
}
