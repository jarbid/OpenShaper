import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  flushSessionSummary,
  installSessionSummary,
  markExport,
  markImport,
  markSave,
  markTemplate,
  markView,
  resetSessionMetrics,
} from './session-metrics';
import * as analytics from './analytics';

/**
 * `session_summary` is the only per-session depth signal that exists — the
 * anonymous baseline gives one "person" per page load, so nothing else can say
 * how far a visitor got. A double-fire would silently inflate every count.
 */
describe('session metrics', () => {
  beforeEach(() => {
    resetSessionMetrics();
    vi.restoreAllMocks();
  });

  it('summarises what happened in the session', () => {
    const track = vi.spyOn(analytics, 'track').mockImplementation(() => {});
    markView('outline');
    markView('rocker');
    markView('outline'); // repeat views collapse
    markTemplate();
    markExport();

    flushSessionSummary(() => 7);

    expect(track).toHaveBeenCalledTimes(1);
    const [event, props] = track.mock.calls[0]!;
    expect(event).toBe('session_summary');
    expect(props).toMatchObject({
      edits: 7,
      views_used: ['outline', 'rocker'],
      view_count: 2,
      exported: true,
      saved: false,
      imported: false,
      template_used: true,
    });
  });

  it('sends nothing but zeros and falses for an untouched session', () => {
    const track = vi.spyOn(analytics, 'track').mockImplementation(() => {});
    flushSessionSummary(() => 0);
    expect(track.mock.calls[0]![1]).toMatchObject({
      edits: 0,
      views_used: [],
      view_count: 0,
      exported: false,
      saved: false,
      imported: false,
      template_used: false,
    });
  });

  it('only fires once, even if pagehide repeats via bfcache', () => {
    const track = vi.spyOn(analytics, 'track').mockImplementation(() => {});
    flushSessionSummary(() => 1);
    flushSessionSummary(() => 99);
    expect(track).toHaveBeenCalledTimes(1);
    expect(track.mock.calls[0]![1]).toMatchObject({ edits: 1 });
  });

  it('flushes on pagehide once installed, and stops after cleanup', () => {
    const track = vi.spyOn(analytics, 'track').mockImplementation(() => {});
    const cleanup = installSessionSummary(() => 3);
    markSave();
    markImport();

    window.dispatchEvent(new Event('pagehide'));
    expect(track).toHaveBeenCalledTimes(1);
    expect(track.mock.calls[0]![1]).toMatchObject({ edits: 3, saved: true, imported: true });

    cleanup();
    resetSessionMetrics();
    window.dispatchEvent(new Event('pagehide'));
    expect(track).toHaveBeenCalledTimes(1);
  });

  it('reports a duration once the session clock has started', () => {
    const track = vi.spyOn(analytics, 'track').mockImplementation(() => {});
    vi.spyOn(Date, 'now').mockReturnValueOnce(1_000_000).mockReturnValueOnce(1_012_000);
    installSessionSummary(() => 0);
    flushSessionSummary(() => 0);
    expect(track.mock.calls[0]![1]).toMatchObject({ duration_s: 12 });
  });
});
