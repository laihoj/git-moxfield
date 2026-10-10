import { describe, expect, it } from 'vitest';

import { runsOnNetlify } from './platform';

describe('runsOnNetlify', () => {
  it.each([
    [{ NETLIFY: 'true' }, true],
    [{ SITE_ID: 'abc' }, true],
    [{ SITE_ID: 'abc', NETLIFY_DEV: 'true' }, false],
    [{ NETLIFY: 'true', NETLIFY_DEV: 'true' }, false],
    [{ SITE_ID: '' }, false],
    [{ NETLIFY: 'false' }, false],
    [{}, false],
  ])('%j → %s', (env, expected) => {
    expect(runsOnNetlify(env)).toBe(expected);
  });
});
