/**
 * P19: a station marker's diamonds get the same 44px touch floor as control
 * points; the mouse keeps its 10px tolerance.
 */
import { SECTION_MARKER_HANDLE_OFFSET } from '@openshaper/render2d';
import { fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installLayoutStubs,
  MOUSE,
  mountEditor,
  removeLayoutStubs,
  TOUCH,
} from './test/spline-editor-harness';

beforeEach(installLayoutStubs);
afterEach(removeLayoutStubs);

describe('station marker touch target (P19)', () => {
  const setup = () => {
    const onPickSection = vi.fn();
    const rig = mountEditor({
      sectionMarkers: [{ pos: 50, index: 1, active: false }],
      onPickSection,
    });
    // 18px beside the top diamond: past the mouse's 10px, inside the touch 22px.
    const at = {
      clientX: rig.screenOf({ x: 50, y: 0 }).clientX + 18,
      clientY: SECTION_MARKER_HANDLE_OFFSET,
    };
    return { ...rig, onPickSection, at };
  };

  it('a fingertip near the diamond picks the station', () => {
    const { canvas, onPickSection, at } = setup();
    fireEvent.pointerDown(canvas, { ...TOUCH, ...at });
    expect(onPickSection).toHaveBeenCalledWith(1);
  });

  it('the mouse still needs to be on it', () => {
    const { canvas, onPickSection, at } = setup();
    fireEvent.pointerDown(canvas, { ...MOUSE, ...at });
    expect(onPickSection).not.toHaveBeenCalled();
  });
});
