// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import '@/components/test-utils';
import { ERROR, PAYLOAD, READY } from '@/integrations/moxfield/capture-protocol';

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));

const SITE = 'https://moxfield.com';
const NONCE = '0123456789abcdef0123456789abcdef';
const KEY = `gmk_${'k'.repeat(43)}`;
const ENVELOPE = JSON.stringify({ kind: 'git-moxfield/capture', version: 2, source: 'moxfield', deck: {} });

/** The Moxfield tab that opened the capture page: a real window, so it can be a message source. */
let moxfieldTab: Window;
/** What the capture page posts back to the Moxfield tab. */
let postToMoxfield: Mock<(message: unknown, targetOrigin: unknown) => void>;
let fetchMock: ReturnType<typeof vi.fn>;

async function renderCaptureClient(signedIn: boolean) {
  // The capture page caches the hand-over (nonce and opener) per page load, i.e. per module.
  vi.resetModules();
  const { CaptureClient } = await import('./capture-client');
  return render(
    <CaptureClient
      allowedOrigins={[SITE]}
      apiBaseUrl="https://api2.moxfield.com"
      siteOrigin={SITE}
      initialMode="auto"
      formError={null}
      signedIn={signedIn}
    />,
  );
}

function sendFromMoxfield(data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data, origin: SITE, source: moxfieldTab }));
}

function untrackedResponse(): Response {
  return new Response(JSON.stringify({ status: 'untracked', name: 'Blue Farm', externalId: 'abc' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  if (frame.contentWindow === null) throw new Error('No frame window');
  moxfieldTab = frame.contentWindow;
  postToMoxfield = vi.fn();
  const record = (message: unknown, targetOrigin: unknown): void => {
    postToMoxfield(message, targetOrigin);
  };
  vi.spyOn(moxfieldTab, 'postMessage').mockImplementation(record as Window['postMessage']);
  Object.defineProperty(window, 'opener', { value: moxfieldTab, configurable: true });
  window.history.replaceState(null, '', `/capture#n=${NONCE}`);
  fetchMock = vi.fn().mockImplementation(() => Promise.resolve(untrackedResponse()));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(window, 'opener', { value: null, configurable: true });
  document.body.innerHTML = '';
});

function postedBodies(): unknown[] {
  return fetchMock.mock.calls.map((call) => {
    const body = (call[1] as RequestInit | undefined)?.body;
    if (typeof body !== 'string') throw new Error('No JSON body was sent');
    return JSON.parse(body) as unknown;
  });
}

describe('CaptureClient bookmarklet hand-over', () => {
  it('announces itself to the Moxfield tab and forwards the bookmarklet key with the deck', async () => {
    const user = userEvent.setup();
    await renderCaptureClient(false);
    expect(postToMoxfield).toHaveBeenCalledWith({ t: READY, n: NONCE }, SITE);
    // The nonce does not stay in the address bar.
    expect(window.location.hash).toBe('');

    sendFromMoxfield({ t: PAYLOAD, n: NONCE, json: ENVELOPE, key: KEY });
    expect(await screen.findByRole('heading', { name: 'Track “Blue Farm”?' })).toBeInTheDocument();
    expect(postedBodies()).toEqual([
      { payload: ENVELOPE, method: 'browser-capture', track: false, key: KEY },
    ]);

    // Tracking sends the deck again, with the same key.
    await user.click(screen.getByRole('button', { name: 'Track this deck' }));
    expect(postedBodies()[1]).toEqual({
      payload: ENVELOPE,
      method: 'browser-capture',
      track: true,
      key: KEY,
    });
  });

  it('ignores messages from other windows, origins or nonces', async () => {
    await renderCaptureClient(true);
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { t: PAYLOAD, n: NONCE, json: ENVELOPE, key: KEY },
        origin: SITE,
        source: window,
      }),
    );
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { t: PAYLOAD, n: NONCE, json: ENVELOPE, key: KEY },
        origin: 'https://evil.example',
        source: moxfieldTab,
      }),
    );
    sendFromMoxfield({ t: PAYLOAD, n: 'ffffffffffffffffffffffffffffffff', json: ENVELOPE, key: KEY });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('recognizes a bookmarklet made before accounts (no key) and tells both windows', async () => {
    await renderCaptureClient(false);
    sendFromMoxfield({ t: PAYLOAD, n: NONCE, json: ENVELOPE });

    expect(await screen.findByRole('alert')).toHaveTextContent('This bookmarklet is out of date');
    expect(screen.getByRole('link', { name: 'Make a new bookmarklet' })).toHaveAttribute('href', '/setup');
    expect(fetchMock).not.toHaveBeenCalled();
    const errors = postToMoxfield.mock.calls.filter(([message]) => (message as { t: string }).t === ERROR);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.[1]).toBe(SITE);
    expect((errors[0]?.[0] as { message: string }).message).toContain('out of date');
  });

  it('explains a revoked bookmarklet and offers a new one', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'This bookmarklet is no longer valid.', code: 'invalid-key' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await renderCaptureClient(false);
    sendFromMoxfield({ t: PAYLOAD, n: NONCE, json: ENVELOPE, key: KEY });

    expect(await screen.findByText('This bookmarklet no longer works')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Make a new bookmarklet' })).toHaveAttribute('href', '/setup');
    // Pasting needs a signed-in browser: not offered to a signed-out one.
    expect(screen.queryByRole('button', { name: 'Paste the deck instead' })).not.toBeInTheDocument();
  });
});

describe('CaptureClient without a hand-over', () => {
  it('asks a signed-out visitor to sign in before pasting', async () => {
    window.history.replaceState(null, '', '/capture');
    Object.defineProperty(window, 'opener', { value: null, configurable: true });
    await renderCaptureClient(false);
    expect(await screen.findByText('Sign in to paste a deck')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/signin?next=%2Fcapture%3Fmode%3Dpaste',
    );
  });

  it('offers the paste form to a signed-in visitor', async () => {
    window.history.replaceState(null, '', '/capture');
    Object.defineProperty(window, 'opener', { value: null, configurable: true });
    await renderCaptureClient(true);
    expect(await screen.findByRole('heading', { name: 'Paste a deck from Moxfield' })).toBeInTheDocument();
  });
});
