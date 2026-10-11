import { describe, expect, it } from 'vitest';

import { jsonResponse, plainText, seeOther } from './responses';

describe('seeOther', () => {
  it('redirects with 303 to the given path, uncached', () => {
    const response = seeOther('/decks/abc?captured=1');
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/decks/abc?captured=1');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.body).toBeNull();
  });
});

describe('plainText', () => {
  it('is UTF-8 text with a trailing newline, uncached', async () => {
    const response = plainText(404, 'Not found.');
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('Not found.\n');
  });

  it('adds headers and lets them replace the defaults', () => {
    const response = plainText(404, 'Not found.', {
      'cache-control': 'private, no-store',
      'x-robots-tag': 'noindex, nofollow',
    });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
  });
});

describe('jsonResponse', () => {
  it('is JSON, uncached, with the given status', async () => {
    const response = jsonResponse({ error: 'No.' }, { status: 403 });
    expect(response.status).toBe(403);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'No.' });
  });

  it('answers 200 by default and keeps headers it is given', () => {
    const response = jsonResponse({}, { headers: { 'set-cookie': 'a=b' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBe('a=b');
  });
});
