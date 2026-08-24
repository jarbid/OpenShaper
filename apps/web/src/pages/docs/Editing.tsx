// SPDX-License-Identifier: GPL-3.0-or-later
import { Link } from 'react-router-dom';
import { RAIL_PRESETS } from '@openshaper/kernel';
import { shortcutKeys } from '../../shortcuts';
import { DocsPage, Section, Term, Terms } from './DocsPage';

export default function DocsEditing() {
  return (
    <DocsPage
      route="/docs/editing"
      title="Editing a board"
      lede="Control points, tangent handles, the four views, and how cross-sections interpolate."
      toc={[
        { id: 'views', label: 'The four views' },
        { id: 'guides', label: 'Guides in 3D' },
        { id: 'points', label: 'Control points & tangents' },
        { id: 'sections', label: 'Cross-sections' },
        { id: 'rails', label: 'Rail presets' },
        { id: 'tail', label: 'Concave tails' },
        { id: 'undo', label: 'Undo & history' },
      ]}
    >
      <Section id="views" title="The four views">
        <Terms>
          <Term name="Outline">
            The plan shape, seen from above. Mirrored about the stringer, so you edit one half and
            both update.
          </Term>
          <Term name="Rocker">
            The profile from the side: two curves, deck and bottom. The gap between them is the
            thickness flow.
          </Term>
          <Term name="Cross-section">
            One station across the board, rail to rail. Use{' '}
            <code>{shortcutKeys('cross-section-prev')}</code> and{' '}
            <code>{shortcutKeys('cross-section-next')}</code> to page through stations.
          </Term>
          <Term name="3D">
            The tessellated surface. Useful for spotting a bump you cannot see in a single profile.
          </Term>
        </Terms>
        <p>
          The quad view shows all four at once. Number keys switch views — see{' '}
          <Link to="/docs/shortcuts">shortcuts</Link>.
        </p>
      </Section>

      <Section id="guides" title="Guides in 3D">
        <p>
          The 3D view can draw reference lines directly on the surface. Two buttons in the 3D
          controls toggle them independently.
        </p>
        <Terms>
          <Term name="Stringer">
            An amber line tracing the centreline: down the deck from nose to tail, and back along
            the bottom. Together they outline the stringer plane, so you read the rocker and the
            deck crown at the same time.
          </Term>
          <Term name="Sections">
            A red ring around the board at every cross-section, with the station you are currently
            editing drawn in cyan. Useful for judging whether your stations are spaced sensibly, and
            for seeing which one a change belongs to.
          </Term>
        </Terms>
        <p>
          The lines are computed from the same surface the mesh is built from, so they sit on the
          board rather than floating near it. Both toggles are remembered between sessions, along
          with the rest of the 3D appearance settings.
        </p>
      </Section>

      <Section id="points" title="Control points & tangents">
        <p>
          Drag a point to move it. Selecting one reveals its tangent handles: drag those to change
          how the curve leaves the point. Longer handles make a fuller curve; shorter ones tighten
          it.
        </p>
        <p>
          The control-point inspector in the sidebar shows the selected point's exact position and
          lets you type a value, which is the reliable way to hit a dimension precisely.
        </p>
        <p>
          Press <code>{shortcutKeys('delete-point')}</code> to remove the selected point. The curve
          re-fits through the remaining points.
        </p>
      </Section>

      <Section id="sections" title="Cross-sections">
        <p>
          You define cross-sections at particular stations; the surface between them is
          interpolated, so you do not need many. Add one where the shape needs to change character —
          through the hips, or where a concave starts — rather than at regular intervals.
        </p>
        <p>
          Sections can be copied and pasted, which is the quickest way to hold a rail shape constant
          through a stretch of the board and then vary it deliberately.
        </p>
        <p>
          Every station shows as a dashed vertical line in the outline and rocker views, with a
          diamond handle at each end. Click a handle to select the station — it turns orange — then
          drag it along the board to reposition it. The position appears beside the handle as you
          drag, in your chosen units, and a station can never pass its neighbours, so the order
          never changes under you. The whole drag is a single undo step. Press{' '}
          <code>{shortcutKeys('cross-section-blur')}</code> to release the handle.
        </p>
        <p>
          Right-clicking a handle offers to add a station either side of it, or to delete it. For an
          exact position, type into the field beside the station counter in the cross-section pane
          header, or use its steppers — they nudge by a sensible amount for the current unit.
        </p>
        <p>
          Moving a station carries its profile with it, so the surface between the neighbouring
          stations changes shape. That is deliberate: you are sliding a control station, not
          re-sampling the existing surface.
        </p>
      </Section>

      <Section id="rails" title="Rail presets">
        <p>
          Right-click in the cross-section view and pick a shape under <em>Rail preset</em> to
          restyle the station you are on. It applies to that one section — build a rail that changes
          along the board by stepping through stations and choosing as you go, which is what a
          shaper does anyway: soft through the nose, tucked through the middle, hard off the tail.
        </p>
        <p>
          Only the rail band is re-cut. Like marking bands in from the rail and planing just those,
          a preset works between two blend points — one in from the rail on the deck, a narrower one
          on the bottom — and joins smoothly to what is already there. Your deck crown, your vee,
          your concave: all untouched. The station&rsquo;s width and thickness do not move either,
          so the outline and rocker stay put.
        </p>
        <p>
          It lands as one undo step, and what you get back is an ordinary profile — drag the points
          afterwards, or leave it.
        </p>
        <p>
          The ratio in a name is where the rail&rsquo;s apex — its widest point — sits between those
          two marks. A 50/50 puts it halfway up the rail; an 80/20 puts it near the bottom, where it
          makes an edge for water to leave from.
        </p>
        <p>
          It is the midpoint of the <em>rail</em>, not of the deck and bottom planes. On a board
          with a flat bottom and a domed deck the rail blends into that dome up top and into the
          flat underneath, so even a 50/50 apex measures below mid-thickness — a third of the way up
          is normal on a shortboard. Dome the bottom too, as a longboard or a hull does, and the
          apex climbs back toward the middle on its own.
        </p>
        <Terms>
          {RAIL_PRESETS.map((preset) => (
            <Term key={preset.id} name={preset.label}>
              {preset.summary}
            </Term>
          ))}
        </Terms>
      </Section>

      <Section id="tail" title="Concave tails">
        <p>
          The outline can fold back into the tail to make a swallow or a wing. Volume, planshape
          area, the 3D mesh and every export understand the cutout, so the numbers stay honest.
        </p>
        <p>
          One shape is not supported: a single notch only, so batwing tails with two cutouts cannot
          be described.
        </p>
      </Section>

      <Section id="undo" title="Undo & history">
        <p>
          Every edit lands on a labelled undo stack — <code>{shortcutKeys('undo')}</code> and{' '}
          <code>{shortcutKeys('redo')}</code>. A drag is one step, not one step per pixel, so undo
          moves in the units you actually think in.
        </p>
        <p>
          Your working board is saved to this device continuously, so closing the tab and coming
          back restores it, along with the view you were in and the camera position.
        </p>
      </Section>
    </DocsPage>
  );
}
