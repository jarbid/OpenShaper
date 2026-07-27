### Display units follow the editor's unit selector (no hardcoded units)

Internal geometry is always **centimetres**. Whenever a UI element shows or edits a
**length**, it MUST render in the editor's globally-selected length unit — the one set
by the toolbar dropdown (`mm / cm / in / ft·in`, persisted to `localStorage
'bs.lengthUnit'`). Switching the dropdown re-renders everything; no length is ever shown
in a fixed unit.

- The active unit is a `LengthUnit` (`apps/web/src/format.ts`), resolved in `App.tsx` as
  `units = lengthUnitByKey(unitKey)` and threaded as a `units: LengthUnit` prop to every
  consumer (`EditorPane`, `ControlPointInspector`, `ConstructionPanel`, spec readouts, …).
- Never write a literal `mm`/`cm`/`in` suffix or call `.toFixed()` on a raw cm value in
  JSX. Use the `format.ts` helpers: `fmtLen` (display), `cmToUnitNumber` + `unitDecimals`
  - `unitSuffix` (editable fields), `parseLen` (input → cm), `fmtDimsHeadline` (headline).
    File exports map via `exportUnitFor`.
- New components that display/edit a length take a `units: LengthUnit` prop — they do not
  read the unit themselves or assume a default. Dimensionless fields (counts, fractions)
  stay unitless.
- Exception by design: **volume** is always litres (`fmtVol`), matching legacy.
