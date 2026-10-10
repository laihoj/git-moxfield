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

describe('parseConfig — GIT_MOXFIELD_E2E', () => {
  it.each(['development', 'test', undefined])('allows the test-only endpoints with NODE_ENV=%s', (env) => {
    expect(parseConfig({ GIT_MOXFIELD_E2E: 'true', NODE_ENV: env }).GIT_MOXFIELD_E2E).toBe(true);
  });

  it('refuses to start a production server with the test-only endpoints enabled', () => {
    expect(() => parseConfig({ GIT_MOXFIELD_E2E: 'true', NODE_ENV: 'production' })).toThrow(
      'Invalid git-moxfield configuration: GIT_MOXFIELD_E2E must not be set when NODE_ENV=production',
    );
  });

  it.each([undefined, 'false', '0'])('accepts production without the flag (GIT_MOXFIELD_E2E=%s)', (flag) => {
    expect(parseConfig({ GIT_MOXFIELD_E2E: flag, NODE_ENV: 'production' }).GIT_MOXFIELD_E2E).not.toBe(true);
  });
});
