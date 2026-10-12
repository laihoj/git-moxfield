/**
 * Client-safe formatting helpers: relative and absolute dates, counts, plurals.
 *
 * Everything here is pure and deterministic for a given `now` and time zone. Server
 * and browser usually share both (git-moxfield is local-first), so server-rendered
 * relative times match what the browser renders (see `RelativeTime`).
 */

import { pluralize } from '@/core/text';

export { formatBytes, joinList, MINUS_SIGN, pluralize } from '@/core/text';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
/** Average month and year, for "3 months ago" style approximations. */
const MONTH = 30.44 * DAY;
const YEAR = 365.25 * DAY;

export type RelativeTimeStyle =
  /** `just now`, `5 min ago`, `3 hours ago`, `yesterday`, `4 days ago`, `Sep 12`. */
  | 'long'
  /** `now`, `5m`, `3h`, `4d`, `2w`, `Sep 12`. For dense lists. */
  | 'short'
  /**
   * Like `long`, but always words, never a date (`5 weeks ago`, `3 months ago`,
   * `2 years ago`): for use next to an absolute date, which it must not repeat.
   */
  | 'words';

function toTime(value: string | Date): number {
  return typeof value === 'string' ? Date.parse(value) : value.getTime();
}

/**
 * Human relative time of `value` as seen at `now`. Past events whose time lies slightly
 * in the future (clock skew between Moxfield, the browser and the server) read as
 * "just now"; pass `future: true` for genuinely upcoming times (`in 25 min`). After
 * about a month the `long` and `short` styles show the date instead, because "37 days
 * ago" is harder to place; the `words` style switches to months and years.
 */
export function formatRelativeTime(
  value: string | Date,
  now: number,
  style: RelativeTimeStyle = 'long',
  options: { future?: boolean } = {},
): string {
  const time = toTime(value);
  if (Number.isNaN(time)) return '';
  if (options.future === true && time - now >= 45_000) return formatFutureTime(time - now);
  const elapsed = Math.max(0, now - time);
  const short = style === 'short';

  if (elapsed < 45_000) return short ? 'now' : 'just now';
  if (elapsed < HOUR) {
    const minutes = Math.max(1, Math.round(elapsed / MINUTE));
    return short ? `${minutes}m` : `${minutes} min ago`;
  }
  if (elapsed < DAY) {
    const hours = Math.round(elapsed / HOUR);
    if (hours >= 24) return short ? '1d' : 'yesterday';
    return short ? `${hours}h` : `${pluralize(hours, 'hour')} ago`;
  }
  if (elapsed < WEEK) {
    const days = Math.round(elapsed / DAY);
    if (short) return `${days}d`;
    return days === 1 ? 'yesterday' : `${days} days ago`;
  }
  if (elapsed < 5 * WEEK) {
    const weeks = Math.round(elapsed / WEEK);
    return short ? `${weeks}w` : `${pluralize(weeks, 'week')} ago`;
  }
  if (style !== 'words') return formatCalendarDate(time, now);
  if (elapsed < 11.5 * MONTH) {
    const months = Math.max(1, Math.round(elapsed / MONTH));
    return `${pluralize(months, 'month')} ago`;
  }
  const years = Math.max(1, Math.round(elapsed / YEAR));
  return `${pluralize(years, 'year')} ago`;
}

/** `in 5 min`, `in 3 hours`, `in 2 days`. */
function formatFutureTime(remaining: number): string {
  if (remaining < HOUR) return `in ${Math.max(1, Math.round(remaining / MINUTE))} min`;
  if (remaining < DAY) {
    const hours = Math.round(remaining / HOUR);
    // 23.5 hours and more round to a day, as in the past tense (`yesterday`).
    if (hours >= 24) return 'in 1 day';
    return `in ${pluralize(hours, 'hour')}`;
  }
  const days = Math.round(remaining / DAY);
  return `in ${pluralize(days, 'day')}`;
}

const MONTH_DAY = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' });
const MONTH_DAY_YEAR = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' });

/** `Sep 12` in the current year, `Sep 12, 2025` otherwise (local time zone). */
function formatCalendarDate(time: number, now: number): string {
  const sameYear = new Date(time).getFullYear() === new Date(now).getFullYear();
  return (sameYear ? MONTH_DAY : MONTH_DAY_YEAR).format(time);
}

const DATE_TIME = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });
const FULL_DATE_TIME = new Intl.DateTimeFormat('en', { dateStyle: 'full', timeStyle: 'short' });
const TIME_OF_DAY = new Intl.DateTimeFormat('en', { timeStyle: 'short' });
const MONTH_DAY_TIME = new Intl.DateTimeFormat('en', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function formatWith(format: Intl.DateTimeFormat, value: string | Date): string {
  const time = toTime(value);
  return Number.isNaN(time) ? '' : format.format(time);
}

/** Date and time in the local time zone: `Oct 9, 2026, 2:03 PM`. */
export function formatDateTime(value: string | Date): string {
  return formatWith(DATE_TIME, value);
}

/** Full date and time in the local time zone, for tooltips: `Friday, October 9, 2026 at 2:03 PM`. */
export function formatFullDateTime(value: string | Date): string {
  return formatWith(FULL_DATE_TIME, value);
}

/**
 * A moment in the near future or past as a clock time: `9:47 PM` on the same day as
 * `now`, `Oct 10, 9:47 AM` on another day (local time zone).
 */
export function formatClockTime(value: string | Date, now: number): string {
  const time = toTime(value);
  if (Number.isNaN(time)) return '';
  return new Date(time).toDateString() === new Date(now).toDateString()
    ? TIME_OF_DAY.format(time)
    : MONTH_DAY_TIME.format(time);
}

/** Small counts as words for running text (`once`, `twice`, `3 times`). */
export function formatTimes(count: number): string {
  if (count === 1) return 'once';
  if (count === 2) return 'twice';
  return `${count} times`;
}

/** `v12`. */
export function versionLabel(sequence: number): string {
  return `v${sequence}`;
}

/** Inclusive version range: `v19`, or `v19–v24`. */
export function versionRangeLabel(first: number, last: number): string {
  return first === last ? versionLabel(first) : `${versionLabel(first)}–${versionLabel(last)}`;
}

/** A lifetime in the largest unit that holds it exactly (`7 days` from 2 days, `24 hours`), else minutes. */
export function formatDuration(ms: number): string {
  if (ms >= 2 * DAY && ms % DAY === 0) return pluralize(ms / DAY, 'day');
  if (ms >= HOUR && ms % HOUR === 0) return pluralize(ms / HOUR, 'hour');
  return pluralize(Math.max(1, Math.round(ms / MINUTE)), 'minute');
}

/** Text made safe for an element id: everything but letters, digits and `-` becomes `-`. */
export function domIdSlug(value: string): string {
  return value.replace(/[^a-z0-9-]/gi, '-');
}
