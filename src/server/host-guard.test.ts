import { describe, expect, it } from 'vitest';

import {
  configuredHostnames,
  firstHeaderValue,
  forwardedHost,
  hostnameOf,
  invalidAllowedHosts,
  isAllowedHostname,
  isAllowedRequestHost,
  splitList,
} from './host-guard';

function headers(values: Record<string, string>): Headers {
  return new Headers(values);
}

describe('hostnameOf', () => {
  it.each([
    ['localhost', 'localhost'],
    ['localhost:3000', 'localhost'],
    ['LOCALHOST:3000', 'localhost'],
    ['localhost:80', 'localhost'],
    [' localhost:3000 ', 'localhost'],
    ['localhost.:3000', 'localhost'],
    ['127.0.0.1:3000', '127.0.0.1'],
    ['[::1]:3000', '[::1]'],
    ['[::1]', '[::1]'],
    ['mybox.lan', 'mybox.lan'],
  ])('%j → %j', (value, expected) => {
    expect(hostnameOf(value)).toBe(expected);
  });

  it.each([
    '',
    '   ',
    'evil@localhost',
    'user:pass@localhost:3000',
    'localhost/x',
    'localhost/',
    'localhost?x',
    'localhost#x',
    'localhost\\x',
    'localhost:99999',
    'localhost:x',
    '%6cocalhost',
    'local\thost',
    '::1',
    '[::1',
    '127.1',
    'http://localhost:3000',
  ])('rejects %j', (value) => {
    expect(hostnameOf(value)).toBeNull();
  });
});

describe('isAllowedHostname', () => {
  const configured = new Set(['mybox.lan']);

  it.each(['localhost', 'app.localhost', 'a.b.localhost', '127.0.0.1', '192.168.1.20', '[::1]', 'mybox.lan'])(
    'allows %j',
    (name) => {
      expect(isAllowedHostname(name, configured)).toBe(true);
    },
  );

  it.each([
    'rebind.attacker.example',
    'localhost.attacker.example',
    'attacker-localhost',
    '127.0.0.1.nip.io',
    'sub.mybox.lan',
    'mybox.lan.attacker.example',
  ])('rejects %j', (name) => {
    expect(isAllowedHostname(name, configured)).toBe(false);
  });
});

describe('configuredHostnames', () => {
  it('collects the PUBLIC_APP_URL host and the ALLOWED_HOSTS entries, ignoring ports', () => {
    const names = configuredHostnames({
      PUBLIC_APP_URL: 'http://MyBox.lan:3000/',
      ALLOWED_HOSTS: ' deck.example.com , nas.local:8080,,',
    });
    expect([...names].sort()).toEqual(['deck.example.com', 'mybox.lan', 'nas.local']);
  });

  it('skips missing and malformed values instead of throwing', () => {
    expect(configuredHostnames({}).size).toBe(0);
    expect(configuredHostnames({ PUBLIC_APP_URL: 'not a url', ALLOWED_HOSTS: 'a/b, ok.lan' })).toEqual(
      new Set(['ok.lan']),
    );
  });
});

describe('invalidAllowedHosts', () => {
  it('lists the entries that are not host[:port] values', () => {
    expect(invalidAllowedHosts(undefined)).toEqual([]);
    expect(invalidAllowedHosts('nas.local, deck.example.com:443')).toEqual([]);
    expect(invalidAllowedHosts('nas.local, http://deck.example.com, a/b')).toEqual([
      'http://deck.example.com',
      'a/b',
    ]);
  });
});

describe('isAllowedRequestHost', () => {
  const configured = configuredHostnames({ PUBLIC_APP_URL: 'http://mybox.lan:3000' });

  it.each([
    'localhost:3000',
    'LOCALHOST:3000',
    'app.localhost:3000',
    '127.0.0.1:3000',
    '[::1]:3000',
    '192.168.1.20:3000',
    'mybox.lan:3000',
  ])('allows Host %j', (host) => {
    expect(isAllowedRequestHost(headers({ host }), configured)).toBe(true);
  });

  it.each([
    'rebind.attacker.example:3000',
    'localhost.attacker.example',
    '127.0.0.1.nip.io:3000',
    'evil@localhost:3000',
    'localhost:3000/x',
    '',
  ])('rejects Host %j', (host) => {
    expect(isAllowedRequestHost(headers({ host }), configured)).toBe(false);
  });

  it('rejects a request without a Host header', () => {
    expect(isAllowedRequestHost(headers({}), configured)).toBe(false);
  });

  it('requires every X-Forwarded-Host value to be allowed too', () => {
    const host = 'localhost:3000';
    expect(isAllowedRequestHost(headers({ host, 'x-forwarded-host': 'mybox.lan:3000' }), configured)).toBe(
      true,
    );
    expect(
      isAllowedRequestHost(headers({ host, 'x-forwarded-host': 'mybox.lan, 127.0.0.1:3000' }), configured),
    ).toBe(true);
    expect(
      isAllowedRequestHost(headers({ host, 'x-forwarded-host': 'rebind.attacker.example:3000' }), configured),
    ).toBe(false);
    expect(
      isAllowedRequestHost(
        headers({ host, 'x-forwarded-host': 'localhost, rebind.attacker.example' }),
        configured,
      ),
    ).toBe(false);
    expect(isAllowedRequestHost(headers({ host, 'x-forwarded-host': '' }), configured)).toBe(false);
  });
});

describe('firstHeaderValue', () => {
  it.each([
    ['a.example, b.example', 'a.example'],
    ['  a.example  ', 'a.example'],
    ['a.example', 'a.example'],
    [', b.example', null],
    ['', null],
    [null, null],
  ])('takes the first value of %j', (value, expected) => {
    expect(firstHeaderValue(value)).toBe(expected);
  });
});

describe('forwardedHost', () => {
  it('prefers the first X-Forwarded-Host value over Host', () => {
    expect(forwardedHost(headers({ host: 'inner:3000', 'x-forwarded-host': 'a.example, b.example' }))).toBe(
      'a.example',
    );
    expect(forwardedHost(headers({ host: 'inner:3000' }))).toBe('inner:3000');
    expect(forwardedHost(headers({ host: 'inner:3000', 'x-forwarded-host': ' ' }))).toBe('inner:3000');
    expect(forwardedHost(headers({}))).toBeNull();
  });
});

describe('splitList', () => {
  it('splits a comma-separated setting into its trimmed, non-empty entries', () => {
    expect(splitList(' a , b,,c ,')).toEqual(['a', 'b', 'c']);
    expect(splitList('')).toEqual([]);
    expect(splitList(undefined)).toEqual([]);
  });
});
