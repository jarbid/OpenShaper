/**
 * The small form controls shared by the export dialogs.
 *
 * These grew up inside `ExportPdf1to1Dialog`, with `SelectRow` separately re-declared
 * inside `ExportStepDialog`. Adding a third dialog was the point to lift them out —
 * three copies of a length field is three places for the units rule (apps/web/CLAUDE.md)
 * to drift, and it is exactly the rule that must not.
 */
import { cmToUnitNumber, parseLen, unitDecimals, unitSuffix, type LengthUnit } from './format';

export function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </legend>
      {children}
    </fieldset>
  );
}

export function CheckRow({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={`flex items-center justify-between gap-3 ${disabled ? 'opacity-40' : ''}`}>
      <span className="text-sm text-muted-foreground">{label}</span>
      <input
        type="checkbox"
        checked={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 cursor-pointer accent-[var(--primary)]"
      />
    </label>
  );
}

/** A length field shown/edited in the editor's unit, reporting back internal centimetres. */
export function LenField({
  label,
  cm,
  units,
  onChange,
  disabled,
}: {
  label: string;
  cm: number;
  units: LengthUnit;
  onChange: (cm: number) => void;
  disabled?: boolean;
}) {
  const decimals = unitDecimals(units);
  const display = Math.round(cmToUnitNumber(cm, units) * 10 ** decimals) / 10 ** decimals;
  return (
    <label className={`flex items-center justify-between gap-3 ${disabled ? 'opacity-40' : ''}`}>
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="flex items-center gap-1">
        <input
          type="number"
          value={display}
          disabled={disabled}
          step={units.key === 'in' ? 0.0625 : units.key === 'mm' ? 0.5 : 0.1}
          onChange={(e) => {
            if (e.target.value === '') return;
            const next = parseLen(e.target.value, units);
            if (Number.isFinite(next)) onChange(next);
          }}
          className="h-8 w-20 rounded border border-border bg-background px-2 text-right text-sm"
        />
        <span className="w-6 text-xs text-muted-foreground">{unitSuffix(units)}</span>
      </span>
    </label>
  );
}

/** A whole-number field. Dimensionless by design — no unit suffix. */
export function IntField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={1}
        onChange={(e) => {
          const n = Math.round(parseFloat(e.target.value));
          if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)));
        }}
        className="h-8 w-20 rounded border border-border bg-background px-2 text-right text-sm"
      />
    </label>
  );
}

export function SelectRow({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className={`flex items-center justify-between gap-3 ${disabled ? 'opacity-40' : ''}`}>
      <span className="text-sm text-muted-foreground">{label}</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 rounded border border-border bg-background px-2 text-sm"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
