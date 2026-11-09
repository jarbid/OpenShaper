// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Importing vector drawings (owner request): which way a drawing faces, asked once it is
 * opened, and the ghost's button at the top left of the profile and foil views.
 */
import type { Vec2 } from '@openshaper/kernel';
import { Button, Panel, PanelBody, PanelHeader, PanelTitle, Tooltip } from '@openshaper/ui';
import { useMemo, useRef, useState } from 'react';
import { Modal } from '../components/modal';
import { fmtLen, type LengthUnit } from '../format';
import { moveGhost, type Ghost } from './ghost';
import { parseVector, type VectorFacing, type VectorPath } from './vector-import';

export const VECTOR_ACCEPT = '.svg,.eps,image/svg+xml,application/postscript';

/** The paths in a chosen file. Throws, with a reason to show, if there are none. */
export const readVectorFile = async (file: File): Promise<VectorPath[]> =>
  parseVector(file.name, await file.text());

/**
 * Asks which way the drawing faces; a right-facing one is flipped. With `size`, also how
 * big it comes in. A reason returned from `onChoose` is shown here, so the scale can be
 * changed and tried again.
 */
export function FacingDialog({
  title,
  what,
  size,
  units,
  onChoose,
  onCancel,
}: {
  title: string;
  /** What is being imported, as the question names it: "vector outline". */
  what: string;
  /** The drawing's size at 100% (cm), to offer a scale: none, no scale. */
  size?: { depth: number; base: number } | null;
  units?: LengthUnit;
  onChoose: (facing: VectorFacing, scale: number) => string | void;
  onCancel: () => void;
}) {
  const [percent, setPercent] = useState('100');
  const [problem, setProblem] = useState<string | null>(null);
  const scale = Number(percent) / 100;
  const ok = Number.isFinite(scale) && scale > 0;
  const choose = (facing: VectorFacing) => {
    setProblem(onChoose(facing, scale) || null);
  };
  return (
    <Modal
      name="fin-vector-facing"
      label={title}
      onClose={onCancel}
      className="grid place-items-center p-4"
    >
      <Panel className="flex w-full max-w-sm flex-col" onClick={(e) => e.stopPropagation()}>
        <PanelHeader>
          <PanelTitle>{title}</PanelTitle>
        </PanelHeader>
        <PanelBody className="space-y-4 text-sm">
          <p>Does the {what} face left or right?</p>
          {size && units && (
            <div className="space-y-1">
              <label className="flex items-center gap-2">
                <span className="flex-1">Scale</span>
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={percent}
                  aria-label="Scale"
                  className="h-8 w-24 rounded-md border border-input bg-background px-2 text-right"
                  onChange={(e) => {
                    setPercent(e.target.value);
                    setProblem(null);
                  }}
                />
                <span>%</span>
              </label>
              <p className="text-right text-xs tabular-nums text-muted-foreground">
                {ok
                  ? `Depth ${fmtLen(size.depth * scale, units)} · Base ${fmtLen(size.base * scale, units)}`
                  : 'Enter a scale above 0'}
              </p>
            </div>
          )}
          {problem && (
            <p role="alert" className="text-xs text-destructive">
              {problem}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button size="sm" variant="outline" disabled={!ok} onClick={() => choose('left')}>
              Left
            </Button>
            <Button size="sm" variant="outline" disabled={!ok} onClick={() => choose('right')}>
              Right
            </Button>
          </div>
        </PanelBody>
      </Panel>
    </Modal>
  );
}

/** A right-button drag in a view moving its ghost: handlers for FinCurveEditor, if there's one. */
export const useGhostRightDrag = (
  ghost: Ghost | null | undefined,
  onGhost: ((g: Ghost | null) => void) | undefined,
  yDiv = 1,
) => {
  const start = useRef<Ghost | null>(null);
  const current = useRef(ghost);
  current.current = ghost;
  const has = !!ghost && !!onGhost;
  return useMemo(
    () =>
      has
        ? {
            onRightDragStart: () => {
              start.current = current.current ?? null;
            },
            onRightDrag: (by: Vec2) => {
              if (start.current) onGhost!(moveGhost(start.current, by, yDiv));
            },
          }
        : {},
    [has, onGhost, yDiv],
  );
};

/** The owner's ghost, in white. */
function GhostIcon() {
  return (
    <svg viewBox="93.5 98.6 35.4 39.2" className="h-5 w-5" aria-hidden="true">
      <path
        fill="#ffffff"
        stroke="#ffffff"
        strokeWidth="0.577"
        fillRule="evenodd"
        d="m 117.7401,99.196012 c -7.50595,0.294348 -9.89707,6.623328 -9.62112,11.406538 0.27596,4.7832 3.66098,9.78687 2.11564,13.31908 -3.89516,8.90326 -30.465696,15.89477 -5.74022,12.36256 24.72547,-3.53221 23.84247,-20.75166 23.84247,-25.90281 0,-4.79168 -2.35495,-11.185368 -10.59677,-11.185368 z m 3.22978,6.905008 a 1.6925173,2.5755699 0 0 1 1.6924,2.57555 1.6925173,2.5755699 0 0 1 -1.6924,2.57555 1.6925173,2.5755699 0 0 1 -1.69241,-2.57555 1.6925173,2.5755699 0 0 1 1.69241,-2.57555 z m -5.65806,0.0124 a 1.6925173,2.5755699 0 0 1 1.69241,2.57555 1.6925173,2.5755699 0 0 1 -1.69241,2.57556 1.6925173,2.5755699 0 0 1 -1.6924,-2.57556 1.6925173,2.5755699 0 0 1 1.6924,-2.57555 z"
      />
    </svg>
  );
}

/**
 * The ghost's button at a view's top left: choose a drawing, say which way it faces, and
 * it appears behind the view's curves. With one showing, a × beside it takes it away.
 */
export function GhostControl({
  what,
  ghost,
  make,
  onGhost,
}: {
  /** What the question calls it: "vector outline". */
  what: string;
  ghost: Ghost | null;
  /** The ghost of these paths, placed for this view. */
  make: (paths: readonly VectorPath[], facing: VectorFacing) => Ghost;
  onGhost: (g: Ghost | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [paths, setPaths] = useState<VectorPath[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const open = async (file: File | undefined) => {
    if (!file) return;
    try {
      setPaths(await readVectorFile(file));
      setProblem(null);
    } catch (e) {
      setProblem((e as Error).message);
    }
  };
  return (
    <div className="absolute left-2 top-2 z-10 flex items-center gap-1 text-xs">
      <Tooltip label="Import ghost: a drawing to trace over (SVG, EPS). Right-drag to move it">
        <button
          type="button"
          aria-label="Import ghost"
          className="grid h-8 w-8 place-items-center rounded-md opacity-50 hover:opacity-80"
          onClick={() => input.current?.click()}
        >
          <GhostIcon />
        </button>
      </Tooltip>
      {ghost && (
        <button
          type="button"
          aria-label="Remove ghost"
          className="grid h-8 w-8 place-items-center rounded-md text-muted-foreground hover:text-foreground"
          onClick={() => onGhost(null)}
        >
          ×
        </button>
      )}
      {problem && (
        <span role="alert" className="rounded bg-background/80 px-1.5 py-1 text-destructive">
          {problem}
        </span>
      )}
      <input
        ref={input}
        type="file"
        accept={VECTOR_ACCEPT}
        className="hidden"
        aria-label={`Open a ghost ${what}`}
        onChange={(e) => {
          void open(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      {paths && (
        <FacingDialog
          title="Import ghost"
          what={what}
          onCancel={() => setPaths(null)}
          onChoose={(facing) => {
            onGhost(make(paths, facing));
            setPaths(null);
          }}
        />
      )}
    </div>
  );
}
