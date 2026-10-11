import { describe, expect, it } from 'vitest';

import { isLoopbackHostname } from './hosts';

describe('isLoopbackHostname', () => {
  it.each(['localhost', 'app.localhost', 'a.b.localhost', '127.0.0.1', '[::1]'])('accepts %s', (hostname) => {
    expect(isLoopbackHostname(hostname)).toBe(true);
  });

  it.each(['example.com', 'localhost.example.com', 'notlocalhost', '127.0.0.2', '192.168.1.5', '::1', ''])(
    'rejects %j',
    (hostname) => {
      expect(isLoopbackHostname(hostname)).toBe(false);
    },
  );
});
