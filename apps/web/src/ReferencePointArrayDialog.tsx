import type { MeasurementAxis } from './longitudinal';
import { useState } from 'react';
import { Button, Input, Panel, PanelBody, PanelHeader, PanelTitle, Select } from '@openshaper/ui';
import type { SplineTarget } from '@openshaper/store';
import { cmToUnitNumber, parseTypedLen, unitSuffix, type LengthUnit } from './format';
import { Modal } from './components/modal';
import { boardStore } from './store';

export interface ReferenceArrayRequest {
  target: SplineTarget;
  mirrorX: boolean;
  mirrorY: boolean;
}

export function ReferencePointArrayDialog({
  request,
  units,
  onClose,
  measurementAxis = 'x-axis',
}: {
  request: ReferenceArrayRequest;
  units: LengthUnit;
  measurementAxis?: MeasurementAxis;
  onClose: () => void;
}) {
  const [interval, setInterval] = useState(String(Number(cmToUnitNumber(10, units).toFixed(6))));
  const [error, setError] = useState('');
  const lengthwise = request.target.kind !== 'crossSection';
  const [spacingAxis, setSpacingAxis] = useState<MeasurementAxis>(
    lengthwise ? measurementAxis : 'x-axis',
  );
  const axis = request.target.kind === 'crossSection' ? 'Y' : 'X';
  const curve = request.target.kind === 'crossSection' ? 'cross-section' : request.target.kind;
  const create = () => {
    const cm = parseTypedLen(interval, units);
    if (cm === null || !Number.isFinite(cm) || cm <= 0) {
      setError('Enter a positive interval.');
      return;
    }
    try {
      boardStore
        .getState()
        .addReferencePointArray(
          request.target,
          cm,
          cmToUnitNumber(1, units),
          request.mirrorX,
          request.mirrorY,
          lengthwise ? spacingAxis : 'x-axis',
        );
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal
      name="reference-point-array"
      label="Reference Point Array"
      onClose={onClose}
      className="grid place-items-center p-4"
    >
      <Panel className="w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
        <PanelHeader>
          <PanelTitle>Reference Point Array</PanelTitle>
        </PanelHeader>
        <PanelBody>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              create();
            }}
          >
            <p className="text-sm text-muted-foreground">
              Points on the {curve} at multiples of the interval{' '}
              {lengthwise && spacingAxis === 'o-curve'
                ? 'measured over the bottom rocker'
                : `along ${axis}`}
              , starting at the first interval.
            </p>
            {lengthwise && (
              <label className="flex items-center gap-2 text-sm">
                <span>Measure along</span>
                <Select
                  aria-label="Array measurement axis"
                  value={spacingAxis}
                  onChange={(e) => {
                    setSpacingAxis(e.target.value as MeasurementAxis);
                    setError('');
                  }}
                >
                  <option value="x-axis">X-axis</option>
                  <option value="o-curve">Over curve</option>
                </Select>
              </label>
            )}
            <label className="flex items-center gap-2 text-sm">
              <span>Interval ({unitSuffix(units)})</span>
              <Input
                aria-label={`Interval (${unitSuffix(units)})`}
                autoFocus
                value={interval}
                onChange={(e) => {
                  setInterval(e.target.value);
                  setError('');
                }}
              />
            </label>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit">Add array</Button>
            </div>
          </form>
        </PanelBody>
      </Panel>
    </Modal>
  );
}
