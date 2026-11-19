// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The workspace's controls for the 3D board: Look, and Show.
 *
 * Look is one button that says how the board is painted and opens a menu of every look in three
 * groups (`look.ts`). The light and the board colour sit in the Realistic group: they are settings
 * of their own, so choosing either leaves the look as it is. Show holds what is drawn over a look:
 * the guides, the wireframe, the normals, and the mesh quality (`show.ts`). When "Deviation from
 * ghost" is the look, its band control stands beside the button, as it does in the tabbed layout.
 *
 * The shell re-renders on every drag move, so what it hands `WorkspaceLooks` is made stable here: the
 * callback is read through a ref, and the two reasons (new objects on each render, the same
 * words) are kept while they say the same. The menus then render when a setting does, and not
 * otherwise.
 */
import { PATCH_COLORS, RAIL_ZONE_COLORS } from '@openshaper/render3d/patches';
import { memo, useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import type { LengthUnit } from './format';
import {
  LIGHTS,
  LOOK_GROUPS,
  lookBlock,
  lookHasBand,
  lookOf,
  lookPatch,
  type Look,
  type LookAvailability,
} from './look';
import { MenuButton, MenuGroup, MenuItemRow, MenuSeparator } from './menu-button';
import {
  modeAfterNormals,
  modeAfterWireframe,
  modeBlock,
  OVERLAYS,
  overlayPatch,
  showOf,
  WIREFRAME,
} from './show';
import { DeviationBandControl } from './view-toolkit';
import { QUALITY_3D, type AnalysisBlock, type View3DSettings } from './view3d-settings';

// --- swatches ----------------------------------------------------------------

/** Blue through grey to red, as the curvature and deviation maps are painted. */
const DIVERGING = 'linear-gradient(90deg, #184f95, #9ec5f4, #dcdcd8, #f4b3a6, #9b1c1f)';
/** Blue, cyan, green, yellow, red: the ramp of the normal-change and slope views. */
const SPECTRUM = 'linear-gradient(90deg, #0d26a6, #00bfd9, #26cc33, #f2e61a, #e61f1a)';
const SURFACE_SWATCH: Readonly<Record<string, string>> = {
  zebra: 'repeating-linear-gradient(135deg, #0b0b0b 0 3px, #f4f4f4 3px 6px)',
  'rail-radius': 'linear-gradient(90deg, #5c1d06, #eb6834, #fbe6d6)',
  curvature: SPECTRUM,
  slope: SPECTRUM,
};
const PATCHES_SWATCH = `linear-gradient(90deg, ${PATCH_COLORS.deck} 0 28%, ${RAIL_ZONE_COLORS[0]} 28% 46%, ${RAIL_ZONE_COLORS[1]} 46% 64%, ${RAIL_ZONE_COLORS[2]} 64% 82%, ${PATCH_COLORS.corner} 82%)`;

/** The CSS background that stands for `look`: the board colour for a realistic one, the look's own colours otherwise. */
export const swatchFor = (look: Look, boardColor: string): string =>
  look.group === 'realistic'
    ? boardColor
    : look.group === 'shaping'
      ? PATCHES_SWATCH
      : (SURFACE_SWATCH[look.id] ?? DIVERGING);

function Swatch({ background }: { background: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block size-3.5 shrink-0 rounded-sm border border-foreground/25"
      style={{ background }}
    />
  );
}

// --- Look --------------------------------------------------------------------

function LookMenu({
  settings,
  onChange,
  available,
}: {
  settings: View3DSettings;
  onChange: (patch: Partial<View3DSettings>) => void;
  available: LookAvailability;
}) {
  const look = lookOf(settings);
  const picker = useRef<HTMLInputElement>(null);
  // The board colour is the browser's own picker. It is opened from a row of the menu, and the input
  // it belongs to stays outside the menu, so closing the menu does not take the picker with it.
  const pickColor = () => {
    const input = picker.current;
    if (!input) return;
    try {
      input.showPicker();
    } catch {
      // no showPicker here (or not allowed now): a click opens it the same way
      input.click();
    }
  };
  return (
    <>
      <MenuButton
        label="Look"
        initialFocus="chosen"
        align="end"
        triggerLabel={`Look: ${look.label}`}
        tip="How the board is painted: Patches, an analysis of its surface, or a realistic finish."
        data={{ 'data-look': look.id }}
        trigger={
          <>
            <span className="text-muted-foreground">Look</span>
            <Swatch background={swatchFor(look, settings.color)} />
            <span>{look.label}</span>
          </>
        }
      >
        {LOOK_GROUPS.map((group) => (
          <MenuGroup key={group.id} label={group.label}>
            {group.looks.map((l) => (
              <MenuItemRow
                key={l.id}
                role="menuitemradio"
                checked={l === look}
                blocked={lookBlock(l, available)}
                hint={l.hint}
                leading={<Swatch background={swatchFor(l, settings.color)} />}
                onSelect={() => onChange(lookPatch(l))}
              >
                {l.label}
              </MenuItemRow>
            ))}
            {group.id === 'realistic' && (
              <>
                <MenuGroup label="Light" sub>
                  {LIGHTS.map((light) => (
                    <MenuItemRow
                      key={light.value}
                      role="menuitemradio"
                      checked={settings.lighting === light.value}
                      keepOpen
                      onSelect={() => onChange({ lighting: light.value })}
                    >
                      {light.label}
                    </MenuItemRow>
                  ))}
                </MenuGroup>
                <MenuItemRow
                  role="menuitem"
                  hint="Choose the colour of the board"
                  leading={<Swatch background={settings.color} />}
                  onSelect={pickColor}
                >
                  Board colour
                </MenuItemRow>
              </>
            )}
          </MenuGroup>
        ))}
      </MenuButton>
      <input
        ref={picker}
        type="color"
        value={settings.color}
        onChange={(e) => onChange({ color: e.target.value })}
        aria-label="Board colour"
        aria-hidden="true"
        tabIndex={-1}
        className="sr-only"
      />
    </>
  );
}

// --- Show --------------------------------------------------------------------

function ShowMenu({
  settings,
  onChange,
}: {
  settings: View3DSettings;
  onChange: (patch: Partial<View3DSettings>) => void;
}) {
  const shown = showOf(settings);
  // The wireframe and the normals are drawn on the realistic looks only (`show.ts`): under any other
  // they are listed, disabled, with the reason once in the group and in full on each.
  const blocked = modeBlock(lookOf(settings));
  return (
    <MenuButton
      label="Show"
      align="end"
      tip="What is drawn over the look: the guides, the wireframe, the normals, and the mesh quality."
      trigger={<span>Show</span>}
    >
      <MenuGroup label="Guides">
        {OVERLAYS.map((o) => (
          <MenuItemRow
            key={o.key}
            role="menuitemcheckbox"
            checked={settings[o.key]}
            hint={o.hint}
            keepOpen
            onSelect={() => onChange(overlayPatch(o.key, !settings[o.key]))}
          >
            {o.label}
          </MenuItemRow>
        ))}
      </MenuGroup>
      <MenuSeparator />
      <MenuGroup label="Wireframe and normals" note={blocked?.short}>
        <MenuGroup label="Wireframe" sub>
          {WIREFRAME.map((w) => (
            <MenuItemRow
              key={w.value}
              role="menuitemradio"
              checked={shown.wireframe === w.value}
              blocked={blocked}
              shortReason={false}
              keepOpen
              onSelect={() => onChange({ mode: modeAfterWireframe(w.value, settings.mode) })}
            >
              {w.label}
            </MenuItemRow>
          ))}
        </MenuGroup>
        <MenuItemRow
          role="menuitemcheckbox"
          checked={shown.normals}
          blocked={blocked}
          shortReason={false}
          hint="Colour the surface by which way it faces: a flipped part shows at once"
          keepOpen
          onSelect={() => onChange({ mode: modeAfterNormals(!shown.normals) })}
        >
          Normals
        </MenuItemRow>
      </MenuGroup>
      <MenuSeparator />
      <MenuGroup label="Mesh quality">
        {QUALITY_3D.map((q) => (
          <MenuItemRow
            key={q.value}
            role="menuitemradio"
            checked={settings.meshQuality === q.value}
            keepOpen
            onSelect={() => onChange({ meshQuality: q.value })}
          >
            {q.label}
          </MenuItemRow>
        ))}
      </MenuGroup>
    </MenuButton>
  );
}

// --- the pair, made stable ---------------------------------------------------

interface LooksProps {
  settings: View3DSettings;
  onChange: (patch: Partial<View3DSettings>) => void;
  units: LengthUnit;
  exact: AnalysisBlock | null;
  ghost: AnalysisBlock | null;
  patches: boolean;
}

const Looks = memo(function Looks({
  settings,
  onChange,
  units,
  exact,
  ghost,
  patches,
}: LooksProps) {
  const available = useMemo<LookAvailability>(
    () => ({ exact, ghost, patches }),
    [exact, ghost, patches],
  );
  const look = lookOf(settings);
  return (
    <div
      role="group"
      aria-label="3D view"
      data-testid="workspace-looks"
      className="flex flex-wrap items-center justify-end gap-1"
    >
      <LookMenu settings={settings} onChange={onChange} available={available} />
      {lookHasBand(look, available) && (
        <DeviationBandControl
          band={settings.deviationBand}
          onChange={(deviationBand) => onChange({ deviationBand })}
          units={units}
        />
      )}
      <ShowMenu settings={settings} onChange={onChange} />
    </div>
  );
});

/** The same block while it says the same words: the shell makes a new one on every render. */
function useSameBlock(block: AnalysisBlock | null): AnalysisBlock | null {
  const kept = useRef(block);
  const same =
    kept.current === block ||
    (kept.current !== null &&
      block !== null &&
      kept.current.reason === block.reason &&
      kept.current.short === block.short);
  if (!same) kept.current = block;
  return kept.current;
}

export interface WorkspaceLooksProps {
  /** The settings as shown (a saved choice the workspace does not offer already read as none). */
  settings: View3DSettings;
  onChange: (patch: Partial<View3DSettings>) => void;
  /** The display unit, for the deviation band's readout. */
  units: LengthUnit;
  /** Why the exact surface analyses cannot run on this board (a concave tail), or null. */
  exactUnavailable?: AnalysisBlock | null;
  /** Why "Deviation from ghost" cannot run (no ghost is loaded), or null. */
  ghostUnavailable?: AnalysisBlock | null;
  /** The surface has patches (the rails engine's): Patches can be chosen. */
  patches?: boolean;
}

/** Look and Show for the workspace's 3D pane. Renders again only when a setting or what a look needs changes. */
export function WorkspaceLooks({
  settings,
  onChange,
  units,
  exactUnavailable = null,
  ghostUnavailable = null,
  patches = false,
}: WorkspaceLooksProps) {
  const latest = useRef(onChange);
  useLayoutEffect(() => {
    latest.current = onChange;
  });
  const stable = useCallback((patch: Partial<View3DSettings>) => latest.current(patch), []);
  const exact = useSameBlock(exactUnavailable);
  const ghost = useSameBlock(ghostUnavailable);
  return (
    <Looks
      settings={settings}
      onChange={stable}
      units={units}
      exact={exact}
      ghost={ghost}
      patches={patches}
    />
  );
}
