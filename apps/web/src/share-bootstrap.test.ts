// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The privacy guarantee of the whole feature rests on this module: if the
 * fragment survives into the address bar, PostHog captures it in
 * `$current_url`, in replay and on error reports. So these tests care less
 * about the payload coming out than about the URL being clean afterwards —
 * and about unrelated parts of that URL being left alone.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { clearSharedPayload, extractSharedFragment, peekSharedPayload } from './share-bootstrap';

const at = (url: string) => window.history.replaceState(null, '', url);
const here = () => window.location.pathname + window.location.search + window.location.hash;

beforeEach(() => {
  clearSharedPayload();
  at('/app');
});

describe('extraction', () => {
  it('lifts the payload out and leaves a clean address', () => {
    at('/app#board=v1.AbCd-_09');
    extractSharedFragment();

    expect(peekSharedPayload()).toBe('v1.AbCd-_09');
    expect(here()).toBe('/app');
    expect(window.location.hash).toBe('');
  });

  it('preserves the query string', () => {
    at('/app?utm_source=swaylocks&x=1#board=v1.AAAA');
    extractSharedFragment();

    expect(peekSharedPayload()).toBe('v1.AAAA');
    expect(here()).toBe('/app?utm_source=swaylocks&x=1');
  });

  it('preserves unrelated fragment entries', () => {
    at('/app#tab=fins&board=v1.AAAA&zoom=2');
    extractSharedFragment();

    expect(peekSharedPayload()).toBe('v1.AAAA');
    // Byte-for-byte: the other entries were never ours to rewrite.
    expect(window.location.hash).toBe('#tab=fins&zoom=2');
  });

  it.each([
    ['no fragment', '/app'],
    ['an unrelated fragment', '/app#section-3'],
    ['a fragment that merely mentions board', '/app#keyboard=1'],
  ])('leaves %s untouched', (_label, url) => {
    at(url);
    const before = here();
    extractSharedFragment();

    expect(peekSharedPayload()).toBeNull();
    expect(here()).toBe(before);
  });

  it('does not treat a board= query parameter as a share link', () => {
    // Raw JSON in a query parameter is explicitly not supported — a query
    // string reaches the server and the analytics URL, which is the whole
    // reason the payload lives in the fragment.
    at('/app?board=v1.AAAA');
    extractSharedFragment();

    expect(peekSharedPayload()).toBeNull();
    expect(here()).toBe('/app?board=v1.AAAA');
  });
});

describe('consumption', () => {
  it('keeps the payload readable until the decision is made', () => {
    at('/app#board=v1.AAAA');
    extractSharedFragment();

    // Not a take-once read: the mount effect that consumes this runs twice
    // under StrictMode, and the first run is the one that gets cancelled.
    expect(peekSharedPayload()).toBe('v1.AAAA');
    expect(peekSharedPayload()).toBe('v1.AAAA');
  });

  it('forgets it once cleared', () => {
    at('/app#board=v1.AAAA');
    extractSharedFragment();
    clearSharedPayload();

    expect(peekSharedPayload()).toBeNull();
  });

  it('decodes a percent-encoded payload', () => {
    // Base64URL needs no escaping, but a forum or mail client may have encoded
    // the link on the way through.
    at('/app#board=v1.AA%2DBB');
    extractSharedFragment();

    expect(peekSharedPayload()).toBe('v1.AA-BB');
  });

  it('survives a malformed escape sequence without stopping the boot', () => {
    at('/app#board=v1.%E0%A4%A');
    expect(() => extractSharedFragment()).not.toThrow();
    expect(peekSharedPayload()).toBeNull();
  });

  it('still cleans the address bar when the payload fails to decode (P8)', () => {
    at('/app?x=1#board=v1.%E0%A4%A&keep=1');
    extractSharedFragment();
    expect(here()).toBe('/app?x=1#keep=1');
  });
});
