import { describe, expect, it } from 'vitest';

import { declaredTooLarge, readBodyLimited, readFormBody, readJsonBody } from './request-body';

function streamedRequest(chunks: number[]): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const size of chunks) controller.enqueue(new Uint8Array(size));
      controller.close();
    },
  });
  return new Request('http://localhost/', { method: 'POST', body, duplex: 'half' } as RequestInit);
}

describe('readBodyLimited', () => {
  it('reads a body up to the limit', async () => {
    const result = await readBodyLimited(streamedRequest([3, 4]), 7);
    expect(result).toEqual({ ok: true, bytes: new Uint8Array(7) });
  });

  it('gives up as soon as the body exceeds the limit', async () => {
    expect(await readBodyLimited(streamedRequest([4, 4]), 7)).toEqual({ ok: false, reason: 'too-large' });
  });

  it('still reports a too-large body when cancelling its stream fails', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(4));
      },
      cancel() {
        return Promise.reject(new Error('The connection is gone.'));
      },
    });
    const request = new Request('http://localhost/', { method: 'POST', body, duplex: 'half' } as RequestInit);
    expect(await readBodyLimited(request, 7)).toEqual({ ok: false, reason: 'too-large' });
  });

  it('reports a body that fails while it is read as unreadable', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2));
        controller.error(new Error('The connection broke.'));
      },
    });
    const request = new Request('http://localhost/', { method: 'POST', body, duplex: 'half' } as RequestInit);
    expect(await readBodyLimited(request, 7)).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('reads an empty request as no bytes', async () => {
    expect(await readBodyLimited(new Request('http://localhost/'), 7)).toEqual({
      ok: true,
      bytes: new Uint8Array(),
    });
  });
});

describe('declaredTooLarge', () => {
  it.each([
    [null, false],
    ['7', false],
    ['8', true],
    ['nonsense', false],
  ])('Content-Length %j → %j', (length, expected) => {
    const headers = new Headers(length === null ? {} : { 'content-length': length });
    expect(declaredTooLarge(headers, 7)).toBe(expected);
  });
});

function post(body: BodyInit, contentType: string): Request {
  return new Request('http://localhost/', { method: 'POST', body, headers: { 'content-type': contentType } });
}

describe('readFormBody', () => {
  it('parses urlencoded and multipart forms', async () => {
    const urlencoded = await readFormBody(post('a=1&b=two', 'application/x-www-form-urlencoded'), 100);
    expect(urlencoded.ok && Object.fromEntries(urlencoded.form)).toEqual({ a: '1', b: 'two' });
    const data = new FormData();
    data.set('a', '1');
    const multipart = await readFormBody(
      new Request('http://localhost/', { method: 'POST', body: data }),
      10_000,
    );
    expect(multipart.ok && multipart.form.get('a')).toBe('1');
  });

  it('refuses another media type before reading', async () => {
    expect(await readFormBody(post('a=1', 'text/plain'), 100)).toEqual({
      ok: false,
      reason: 'unsupported-type',
    });
    expect(
      await readFormBody(new Request('http://localhost/', { method: 'POST', body: 'a=1' }), 100),
    ).toEqual({
      ok: false,
      reason: 'unsupported-type',
    });
  });

  it('reports a body over the limit, announced or not', async () => {
    const big = 'a=' + 'x'.repeat(200);
    expect(await readFormBody(post(big, 'application/x-www-form-urlencoded'), 100)).toEqual({
      ok: false,
      reason: 'too-large',
    });
    const request = streamedRequest([60, 60]);
    request.headers.set('content-type', 'application/x-www-form-urlencoded');
    expect(await readFormBody(request, 100)).toEqual({ ok: false, reason: 'too-large' });
  });

  it('reports a multipart body that does not parse as malformed', async () => {
    expect(await readFormBody(post('not multipart', 'multipart/form-data; boundary=x'), 100)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});

describe('readJsonBody', () => {
  it('parses a JSON document, with or without parameters on the media type', async () => {
    expect(await readJsonBody(post('{"a":1}', 'application/json'), 100)).toEqual({
      ok: true,
      json: { a: 1 },
    });
    expect(await readJsonBody(post('[1]', 'application/json; charset=utf-8'), 100)).toEqual({
      ok: true,
      json: [1],
    });
  });

  it('refuses another media type, an oversized body and invalid JSON', async () => {
    expect(await readJsonBody(post('{}', 'text/plain'), 100)).toEqual({
      ok: false,
      reason: 'unsupported-type',
    });
    expect(await readJsonBody(post(`"${'x'.repeat(200)}"`, 'application/json'), 100)).toEqual({
      ok: false,
      reason: 'too-large',
    });
    expect(await readJsonBody(post('{nope', 'application/json'), 100)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});
