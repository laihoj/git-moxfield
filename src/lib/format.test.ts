import { describe, expect, it } from 'vitest';

import { formatClockTime, formatRelativeTime } from './format';

const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const DAY = 86_400_000;

function ago(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

describe('formatRelativeTime', () => {
  it.each<[number, string, string]>([
    [10_000, 'just now', 'now'],
    [5 * 60_000, '5 min ago', '5m'],
    [3 * 3_600_000, '3 hours ago', '3h'],
    [4 * DAY, '4 days ago', '4d'],
    [3 * 7 * DAY, '3 weeks ago', '3w'],
  ])('describes %i ms ago as "%s" (short "%s")', (elapsed, long, short) => {
    expect(formatRelativeTime(ago(elapsed), NOW)).toBe(long);
    expect(formatRelativeTime(ago(elapsed), NOW, 'short')).toBe(short);
    expect(formatRelativeTime(ago(elapsed), NOW, 'words')).toBe(long);
  });

  it('shows a date after about a month, except in the words style', () => {
    const value = ago(39 * DAY);
    expect(formatRelativeTime(value, NOW)).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
    expect(formatRelativeTime(value, NOW, 'short')).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
    expect(formatRelativeTime(value, NOW, 'words')).toBe('1 month ago');
  });

  it.each<[number, string]>([
    [70 * DAY, '2 months ago'],
    [300 * DAY, '10 months ago'],
    [360 * DAY, '1 year ago'],
    [800 * DAY, '2 years ago'],
  ])('describes %i ms ago in words as "%s"', (elapsed, words) => {
    expect(formatRelativeTime(ago(elapsed), NOW, 'words')).toBe(words);
  });

  it('describes upcoming times when asked to', () => {
    expect(formatRelativeTime(ago(-3_600_000), NOW, 'long', { future: true })).toBe('in 1 hour');
    expect(formatRelativeTime(ago(-3_600_000), NOW)).toBe('just now');
  });

  it('rounds an upcoming time just under a day to a day, not to 24 hours', () => {
    const future = { future: true };
    expect(formatRelativeTime(ago(-23 * 3_600_000), NOW, 'long', future)).toBe('in 23 hours');
    expect(formatRelativeTime(ago(-(DAY - 60_000)), NOW, 'long', future)).toBe('in 1 day');
    expect(formatRelativeTime(ago(-DAY), NOW, 'long', future)).toBe('in 1 day');
    expect(formatRelativeTime(ago(-7 * DAY), NOW, 'long', future)).toBe('in 7 days');
  });
});

describe('formatClockTime', () => {
  it('shows only the time on the same day, and the date too on another day', () => {
    const sameDay = new Date(NOW);
    sameDay.setHours(sameDay.getHours() === 23 ? 22 : sameDay.getHours() + 1, 47);
    expect(formatClockTime(sameDay, NOW)).toMatch(/^\d{1,2}:47\s[AP]M$/);

    const nextDay = new Date(NOW + 2 * DAY);
    expect(formatClockTime(nextDay, NOW)).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2}\s[AP]M$/);
  });

  it('is empty for an invalid date', () => {
    expect(formatClockTime('not a date', NOW)).toBe('');
  });
});
