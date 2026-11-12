// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The "Rails engine (experimental)" setting: off by default, remembered, one checkbox in the settings
 * dialog's Experimental group, and carried to the worker with each request as `JobOptions.engine`.
 */
import type { BezierBoard } from '@openshaper/kernel';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NurbsAnswer, NurbsClient } from './nurbs-client';
import { createNurbsViewer, VIEWER_INPUT_OFF } from './nurbs-viewer';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from './settings';
import { SettingsDialog } from './SettingsDialog';
import type { JobOptions } from './workers/nurbs-protocol';

beforeEach(() => localStorage.clear());

const renderDialog = (onSave = vi.fn()) => {
  render(
    <MemoryRouter>
      <SettingsDialog settings={DEFAULT_SETTINGS} onSave={onSave} onClose={vi.fn()} />
    </MemoryRouter>,
  );
  return onSave;
};

describe('the setting', () => {
  it('is the sections engine by default, and when storage holds older settings', () => {
    expect(DEFAULT_SETTINGS.surfaceEngine).toBe('sections');
    expect(loadSettings().surfaceEngine).toBe('sections');
    localStorage.setItem('bs.settings', JSON.stringify({ version: 2, nurbsEngine: true }));
    expect(loadSettings().surfaceEngine).toBe('sections');
  });

  it('is remembered', () => {
    saveSettings({ ...DEFAULT_SETTINGS, surfaceEngine: 'rails' });
    expect(loadSettings().surfaceEngine).toBe('rails');
  });
});

describe('the control', () => {
  it('is labelled, described, and off until it is turned on', () => {
    renderDialog();
    const box = screen.getByLabelText('Rails engine (experimental)') as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(
      screen.getByText(
        'Builds the 3D model with the new trim-and-blend engine. STEP export still uses the current engine.',
      ),
    ).toBeTruthy();
  });

  it('saves the rails engine when turned on, and the sections engine when turned off again', () => {
    const onSave = renderDialog();
    const box = screen.getByLabelText('Rails engine (experimental)');
    fireEvent.click(box);
    fireEvent.click(screen.getByText(/apply/i));
    expect(onSave.mock.calls[0]![0].surfaceEngine).toBe('rails');
    fireEvent.click(box);
    fireEvent.click(screen.getByText(/apply/i));
    expect(onSave.mock.calls[1]![0].surfaceEngine).toBe('sections');
  });
});

describe('the engine reaches the worker with each request', () => {
  const harness = () => {
    const seen: JobOptions[] = [];
    const never = () => new Promise<never>(() => {});
    const client: NurbsClient = {
      classic: (_board, options) => (seen.push(options), never() as Promise<NurbsAnswer>),
      test: never,
      doc: never,
      probe: never,
      convert: never,
      measure: never,
      cancel: () => {},
      dispose: () => {},
    };
    const viewer = createNurbsViewer({ client });
    return { seen, viewer };
  };
  const board = { outline: {}, bottom: {}, deck: {}, crossSections: [] } as unknown as BezierBoard;

  it('adds none for the sections engine', () => {
    const { seen, viewer } = harness();
    viewer.setInput({ ...VIEWER_INPUT_OFF, enabled: true, board });
    expect(seen).toHaveLength(1);
    expect('engine' in seen[0]!).toBe(false);
  });

  it('asks again when the engine changes, and says which', () => {
    const { seen, viewer } = harness();
    viewer.setInput({ ...VIEWER_INPUT_OFF, enabled: true, board });
    viewer.setInput({ ...VIEWER_INPUT_OFF, enabled: true, board, engine: 'rails' });
    expect(seen).toHaveLength(2);
    expect(seen[1]!.engine).toBe('rails');
    viewer.setInput({ ...VIEWER_INPUT_OFF, enabled: true, board, engine: 'rails' });
    expect(seen).toHaveLength(2);
    viewer.setInput({ ...VIEWER_INPUT_OFF, enabled: true, board, engine: 'sections' });
    expect(seen).toHaveLength(3);
    expect('engine' in seen[2]!).toBe(false);
  });
});
