import { describe, expect, it } from 'vitest';

import { httpBaseUrl, parseHttpUrl, stripTrailingSlashes } from './http-url';

describe('parseHttpUrl', () => {
  it.each([
    'http://localhost:3000',
    'https://api2.moxfield.com',
    'HTTP://Example.com/x',
    'http://[::1]:3000/',
  ])('accepts %s', (value) => {
    expect(parseHttpUrl(value)).toBeInstanceOf(URL);
  });

  it.each([
    '',
    'localhost:3000',
    'ftp://example.com',
    'javascript:alert(1)',
    'file:///etc/passwd',
    '//example.com',
    'not a url',
  ])('rejects %j', (value) => {
    expect(parseHttpUrl(value)).toBeNull();
  });
});

describe('stripTrailingSlashes', () => {
  it.each([
    ['https://x.example/', 'https://x.example'],
    ['https://x.example/app///', 'https://x.example/app'],
    ['https://x.example/app', 'https://x.example/app'],
    ['/', ''],
    ['', ''],
  ])('%j → %j', (text, expected) => {
    expect(stripTrailingSlashes(text)).toBe(expected);
  });

  it('is linear on a long run of slashes inside the text', () => {
    const text = `a${'/'.repeat(200_000)}b`;
    expect(stripTrailingSlashes(text)).toBe(text);
  });
});

describe('httpBaseUrl', () => {
  it('keeps origin and path, drops trailing slashes, query and fragment', () => {
    expect(httpBaseUrl(new URL('https://tools.example/git-moxfield/?a=1#b'))).toBe(
      'https://tools.example/git-moxfield',
    );
    expect(httpBaseUrl(new URL('http://localhost:3000/'))).toBe('http://localhost:3000');
  });
});
