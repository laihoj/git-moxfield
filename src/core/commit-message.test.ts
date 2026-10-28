import { describe, expect, it } from 'vitest';

import { composeCommitMessage, splitCommitMessage } from './commit-message';

describe('splitCommitMessage', () => {
  it('reads a one-line message as its subject', () => {
    expect(splitCommitMessage('Cut Dress Down')).toEqual({ subject: 'Cut Dress Down', description: '' });
    expect(splitCommitMessage('  Cut Dress Down ')).toEqual({ subject: 'Cut Dress Down', description: '' });
    expect(splitCommitMessage('')).toEqual({ subject: '', description: '' });
  });

  it('splits Git-style: the first line, a blank line, then the description with its line breaks', () => {
    expect(
      splitCommitMessage('Cut Dress Down\n\nIt never did anything.\n\n- too slow\n- no targets\n'),
    ).toEqual({
      subject: 'Cut Dress Down',
      description: 'It never did anything.\n\n- too slow\n- no targets',
    });
  });

  it('takes the rest as the description even without a blank line, and accepts CRLF', () => {
    expect(splitCommitMessage('Subject\nMore')).toEqual({ subject: 'Subject', description: 'More' });
    expect(splitCommitMessage('Subject\r\n\r\nMore\r\nlines')).toEqual({
      subject: 'Subject',
      description: 'More\nlines',
    });
  });
});

describe('composeCommitMessage', () => {
  it('is the subject alone without a description, else both with a blank line between', () => {
    expect(composeCommitMessage('Cut Dress Down', '')).toBe('Cut Dress Down');
    expect(composeCommitMessage('Cut Dress Down', 'Too slow.')).toBe('Cut Dress Down\n\nToo slow.');
  });

  it('round-trips through splitCommitMessage', () => {
    const parts = { subject: 'Cut Dress Down', description: 'Too slow.\n\nAnd no targets.' };
    expect(splitCommitMessage(composeCommitMessage(parts.subject, parts.description))).toEqual(parts);
  });
});
