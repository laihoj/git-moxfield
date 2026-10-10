import { describe, expect, it } from 'vitest';

import { parseConfig } from './config';

describe('parseConfig — ALLOWED_HOSTS', () => {
  it('is optional', () => {
    expect(parseConfig({}).ALLOWED_HOSTS).toBeUndefined();
  });

  it('accepts comma-separated host names with optional ports', () => {
    expect(parseConfig({ ALLOWED_HOSTS: 'mybox.local, deck.example.com:443' }).ALLOWED_HOSTS).toBe(
      'mybox.local, deck.example.com:443',
    );
  });

  it('rejects entries that are not host names, naming them', () => {
    expect(() => parseConfig({ ALLOWED_HOSTS: 'mybox.local, http://deck.example.com' })).toThrow(
      /ALLOWED_HOSTS: expected host names such as mybox\.local, got "http:\/\/deck\.example\.com"/,
    );
  });
});
