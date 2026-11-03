// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The "Bottom features" sidebar section (NURBS engine only, docs/design/m2-editor.md §3): add a vee, a
 * single or double concave or channels, switch each on and off, and set its depth, its extent along the
 * board and its shape. Each edit is one undo step; a drag of a slider is one step in all. Lengths are in
 * the editor's display unit (`apps/web/CLAUDE.md`), fractions of the chord are percentages.
 *
 * Every field is held to the range the store reports (`featureLimits`), so a value inside it never makes the
 * model refuse the board.
 */
import type { BottomFeature } from '@openshaper/board2';
import { featureKindOf, featureRange, type FeatureRange } from '@openshaper/store/sections';
import { Button, Checkbox, Input } from '@openshaper/ui';
import { useEffect, useSyncExternalStore } from 'react';
import {
  BOTTOM_FEATURES,
  featureLabel,
  fieldText,
  fieldValue,
  fieldsFor,
  fromNoseToS,
  isEndKey,
  noseEndRange,
  endReadout,
  spanReadout,
  sToFromNose,
  parseField,
  sameShown,
  type FieldDef,
  type FieldKind,
} from './bottom-features';
import { fmtLen, unitSuffix, type LengthUnit } from './format';
import { sectionStore } from './store';
import { useSyncedText } from './use-numeric-field';

/** What the section's header shows when it is shut: how many features are on. */
export function bottomFeaturesSummary(): string | undefined {
  const features = sectionStore.getState().doc?.features;
  if (!features || features.length === 0) return undefined;
  const on = features.filter((f) => f.enabled).length;
  return on === features.length ? `${on} on` : `${on} of ${features.length} on`;
}

export function BottomFeaturesSection({
  units,
  segmentClass,
  sliderClass,
  extentClass,
}: {
  units: LengthUnit;
  /** Classes of one add button (`SIZING.segment` in `Sidebar.tsx`). */
  segmentClass: string;
  /** Classes of a range input (`SIZING.slider`). */
  sliderClass: string;
  /** Classes of the extent bar (`SIZING.extentBar`). */
  extentClass: string;
}) {
  const doc = useSyncExternalStore(sectionStore.subscribe, () => sectionStore.getState().doc);
  if (!doc) return null;
  const outline = doc.outline.plus.knots;
  const length = outline[outline.length - 1]!.p[0];

  return (
    <div className="space-y-3 text-sm">
      <div className="space-y-1">
        <div className="text-muted-foreground">Add</div>
        <div role="group" aria-label="Add a bottom feature" className="flex flex-wrap gap-1">
          {BOTTOM_FEATURES.map((k) => (
            <Button
              key={k.value}
              size="sm"
              variant="ghost"
              title={k.hint}
              className={segmentClass}
              onClick={() => sectionStore.getState().addFeature(k.value)}
            >
              {k.label}
            </Button>
          ))}
        </div>
      </div>

      {doc.features.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No bottom features. Add one above; it appears in the 3D view and as a strip in the rocker
          view.
        </p>
      )}

      {doc.features.map((f) => (
        <FeatureCard
          key={f.id}
          feature={f}
          units={units}
          sliderClass={sliderClass}
          extentClass={extentClass}
          length={length}
        />
      ))}
    </div>
  );
}

function FeatureCard({
  feature: f,
  units,
  sliderClass,
  extentClass,
  length,
}: {
  feature: BottomFeature;
  units: LengthUnit;
  sliderClass: string;
  extentClass: string;
  length: number;
}) {
  const kind = featureKindOf(f);
  const limits = sectionStore.getState().featureLimits(f.id);
  const color = BOTTOM_FEATURES.find((k) => k.value === kind)!.color;
  const keys = f.depth.keys;
  const st = () => sectionStore.getState();
  return (
    <fieldset
      className={`space-y-2 rounded-md border border-border p-2 ${f.enabled ? '' : 'opacity-60'}`}
      aria-label={`${featureLabel(kind)} ${f.id}`}
    >
      <div className="flex items-center justify-between gap-2">
        <label className="flex min-w-0 items-center gap-2 pointer-coarse:min-h-11">
          <Checkbox
            checked={f.enabled}
            aria-label={`${featureLabel(kind)} on`}
            onChange={(e) => st().setFeatureEnabled(f.id, e.target.checked)}
          />
          <span className="truncate font-medium" style={{ color }}>
            {featureLabel(kind)}
            {/-(\d+)$/.exec(f.id)?.[1] ? ` ${/-(\d+)$/.exec(f.id)![1]}` : ''}
          </span>
        </label>
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Remove ${featureLabel(kind)}`}
          onClick={() => st().removeFeature(f.id)}
        >
          Remove
        </Button>
      </div>

      {f.enabled && (
        <ExtentBar
          className={extentClass}
          color={color}
          length={length}
          from={keys[0]!.s}
          to={keys[keys.length - 1]!.s}
        />
      )}

      {f.enabled &&
        limits &&
        fieldsFor(kind).map((def) => {
          const range = limits[def.key];
          if (!range) return null;
          return (
            <FeatureField
              key={def.key}
              def={def}
              feature={f}
              range={range}
              units={units}
              sliderClass={sliderClass}
              length={length}
              roomMin={featureRange(sectionStore.getState().doc!).min}
            />
          );
        })}

      {f.enabled && keys.length > 2 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground pointer-coarse:min-h-11">
            Depth keys ({keys.length})
          </summary>
          <div className="mt-1 space-y-1">
            {keys.map((k, i) =>
              i === 0 || i === keys.length - 1 ? null : (
                <div key={i} className="flex items-end gap-1">
                  <NumberBox
                    label={`Point ${i} — from tail`}
                    kind="length"
                    value={k.s}
                    range={{ min: keys[i - 1]!.s, max: keys[i + 1]!.s }}
                    units={units}
                    onCommit={(s) => st().setFeatureKey(f.id, i, { s })}
                  />
                  <NumberBox
                    label={`Point ${i} — depth`}
                    kind="length"
                    value={k.value}
                    range={limits?.depth ?? { min: 0, max: 1 }}
                    units={units}
                    onCommit={(value) => st().setFeatureKey(f.id, i, { value })}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={keys.length <= 3}
                    aria-label={`Remove key ${i}`}
                    onClick={() => st().removeFeatureKey(f.id, i)}
                  >
                    ×
                  </Button>
                </div>
              ),
            )}
            <Button size="sm" variant="ghost" onClick={() => st().addFeatureKey(f.id)}>
              Add key
            </Button>
          </div>
        </details>
      )}
    </fieldset>
  );
}

function FeatureField({
  def,
  feature: f,
  range,
  units,
  sliderClass,
  length,
  roomMin,
}: {
  def: FieldDef;
  feature: BottomFeature;
  range: FeatureRange;
  units: LengthUnit;
  sliderClass: string;
  length: number;
  roomMin: number;
}) {
  const stored = fieldValue(f, def.key);
  const isEnd = isEndKey(def.key);
  // the nose end is typed from the nose; the slider keeps the stored x, so right is toward the nose
  const nose = def.key === 'to';
  const value = nose ? sToFromNose(stored, length) : stored;
  const boxRange = nose ? noseEndRange(range, length) : range;
  const last = f.depth.keys.length - 1;
  const apply = (v: number) => {
    const st = sectionStore.getState();
    if (def.key === 'depth') st.setFeatureDepth(f.id, v);
    else if (def.key === 'from') st.setFeatureKey(f.id, 0, { s: v });
    else if (def.key === 'to') st.setFeatureKey(f.id, last, { s: v });
    else st.setFeatureParams(f.id, { [def.key]: v });
  };
  const readout = isEnd ? (
    <div className="text-xs text-muted-foreground">
      {endReadout(
        def.key as 'from' | 'to',
        stored,
        length,
        def.key === 'from' && stored <= roomMin + 0.05,
        units,
      )}
      {def.key === 'to' && ` · ${spanReadout(f.depth.keys[0]!.s, stored, units)}`}
    </div>
  ) : null;
  return (
    <div className="space-y-1">
      <NumberBox
        label={def.label}
        hint={def.hint}
        kind={def.kind}
        value={value}
        range={boxRange}
        units={units}
        onCommit={nose ? (d) => apply(fromNoseToS(d, length)) : apply}
        inline={!isEnd}
      />
      {readout}
      {range.max > range.min && (
        <Slider
          label={def.label}
          min={range.min}
          max={range.max}
          value={Math.min(range.max, Math.max(range.min, stored))}
          step={def.kind === 'count' ? 1 : (range.max - range.min) / 200}
          valueText={fieldText(value, def.kind, units)}
          className={sliderClass}
          onChange={apply}
        />
      )}
    </div>
  );
}

/**
 * A read-only strip of the board, tail on the left and nose on the right as the outline and rocker views
 * draw it, with the span of the feature shaded in its colour.
 */
function ExtentBar({
  className,
  color,
  length,
  from,
  to,
}: {
  className: string;
  color: string;
  length: number;
  from: number;
  to: number;
}) {
  const pct = (s: number) => Math.min(100, Math.max(0, (s / length) * 100));
  return (
    <div className="text-[10px] leading-none text-muted-foreground" aria-hidden="true">
      <div className={`relative rounded-sm bg-muted ${className}`}>
        <div
          className="absolute inset-y-0 rounded-sm opacity-80"
          style={{ left: `${pct(from)}%`, width: `${pct(to) - pct(from)}%`, background: color }}
        />
      </div>
      <div className="mt-0.5 flex justify-between">
        <span>Tail</span>
        <span>Nose</span>
      </div>
    </div>
  );
}

/** A range input whose whole drag is one undo step. */
function Slider({
  label,
  min,
  max,
  value,
  step,
  valueText,
  className,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  value: number;
  step: number;
  valueText: string;
  className: string;
  onChange: (v: number) => void;
}) {
  const begin = () => sectionStore.getState().beginEdit();
  const end = () => sectionStore.getState().endEdit();
  // a slider unmounted mid-drag (the feature was removed, the tab changed) must not leave the edit open
  useEffect(() => end, []);
  return (
    <input
      type="range"
      aria-label={`${label} slider`}
      aria-valuetext={valueText}
      min={min}
      max={max}
      step={step}
      value={value}
      className={className}
      onPointerDown={begin}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={(e) => {
        if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') begin();
      }}
      onKeyUp={end}
      onBlur={end}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}

/** A labelled number that commits when it is left or on Enter, one undo step, and only if it changed. */
function NumberBox({
  label,
  hint,
  kind,
  value,
  range,
  units,
  onCommit,
  inline = false,
}: {
  label: string;
  hint?: string;
  kind: FieldKind;
  value: number;
  range: FeatureRange;
  units: LengthUnit;
  onCommit: (v: number) => void;
  inline?: boolean;
}) {
  const shown = fieldText(value, kind, units);
  const [text, setText] = useSyncedText(shown, `${shown}|${value}|${units.key}`);
  const commit = () => {
    const v = parseField(text, kind, units);
    if (v === null) {
      setText(shown);
      return;
    }
    const held = Math.min(range.max, Math.max(range.min, v));
    // the text of a value the field shows the same is no edit (a blur must not push an undo step)
    if (sameShown(held, value, kind, units)) setText(shown);
    else onCommit(held);
  };
  const suffix = kind === 'length' ? unitSuffix(units) : kind === 'percent' ? '%' : '';
  return (
    <label className={inline ? 'flex items-center gap-2' : 'block min-w-0 flex-1 space-y-0.5'}>
      <span
        className={inline ? 'w-24 shrink-0 text-muted-foreground' : 'block text-muted-foreground'}
        title={
          hint
            ? `${hint} ${fmtRange(range, kind, units)}`
            : `${label}. ${fmtRange(range, kind, units)}`
        }
      >
        {inline ? label : label.replace(/^Point \d+ — /, '')}
      </span>
      <span className="flex min-w-0 items-center gap-1">
        <Input
          value={text}
          inputMode="decimal"
          enterKeyHint="done"
          aria-label={label}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
        />
        <span className="w-6 shrink-0 text-xs text-muted-foreground">{suffix}</span>
      </span>
    </label>
  );
}

const fmtRange = (r: FeatureRange, kind: FieldKind, units: LengthUnit): string =>
  kind === 'length'
    ? `${fmtLen(r.min, units)} to ${fmtLen(r.max, units)}`
    : kind === 'percent'
      ? `${Math.round(r.min * 100)}% to ${Math.round(r.max * 100)}%`
      : `${Math.round(r.min)} to ${Math.round(r.max)}`;
