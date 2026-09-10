import { beforeEach, describe, expect, it } from 'vitest';
import { getConsent, setConsent, subscribeConsent } from './consent';

const clearCookie = () => {
  document.cookie = 'bs.consent=; path=/; max-age=0';
};

describe('consent persistence', () => {
  beforeEach(() => {
    localStorage.clear();
    clearCookie();
  });

  it('is undecided until a choice is made', () => {
    expect(getConsent()).toBeNull();
  });

  it('round-trips a choice', () => {
    setConsent('accepted');
    expect(getConsent()).toBe('accepted');
  });

  /**
   * The reason the cookie exists. Safari's tracking prevention evicts
   * script-written storage after roughly a week of not visiting, and a visitor
   * whose choice evaporates is asked for consent again on a device where they
   * already answered — the complaint that started this.
   */
  it('survives localStorage being wiped', () => {
    setConsent('accepted');
    localStorage.clear();
    expect(getConsent()).toBe('accepted');
  });

  it('survives cookies being wiped', () => {
    setConsent('rejected');
    clearCookie();
    expect(getConsent()).toBe('rejected');
  });

  it('clears both stores when the choice is reset', () => {
    setConsent('accepted');
    setConsent(null);
    expect(getConsent()).toBeNull();
    expect(document.cookie).not.toContain('bs.consent=accepted');
  });

  // The banner and /privacy's controls are mounted independently and both read
  // through useSyncExternalStore, so a choice made in one has to wake the other.
  it('notifies subscribers so banner and /privacy stay in sync', () => {
    let calls = 0;
    const unsubscribe = subscribeConsent(() => {
      calls += 1;
    });
    setConsent('accepted');
    expect(calls).toBe(1);
    unsubscribe();
    setConsent('rejected');
    expect(calls).toBe(1);
  });
});
