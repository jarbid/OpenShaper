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
      lede="Control points, tangent handles, the views, and how cross-sections interpolate."
      toc={[
        { id: 'views', label: 'The views' },
        { id: 'guides', label: 'Guides in 3D' },
        { id: 'points', label: 'Control points & tangents' },
        { id: 'locks', label: 'Locking handle angles' },
        { id: 'sections', label: 'Cross-sections' },
        { id: 'rails', label: 'Rail presets' },
        { id: 'tail', label: 'Concave tails' },
        { id: 'undo', label: 'Undo & history' },
      ]}
    >
      <Section id="views" title="The views">
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
          <Link to="/docs/shortcuts">shortcuts</Link>. Phones do not get the quad view: four panes
          in that width leaves none of them usable, so a phone opens on the outline and switches
          between the single views instead.
        </p>
        <p>
          <strong>Split view</strong> is the middle ground: two full-width panes, one above the
          other, each with a picker where its title would be — so you can put the outline over the
          rocker, or the outline over a cross-section, and read both at full window width. Picking
          the pane the other half is already showing swaps the two rather than doubling it up. The
          pairing is remembered between sessions. Split is a desktop layout only: halving the height
          of a tablet or phone window leaves two panes too short to work in, so the tab and its
          number key are not offered below 1024px wide.
        </p>
        <p>
          With a mouse there is a shortcut that skips the tabs:{' '}
          <strong>double-click a pane title</strong> in the quad view to blow that pane up to the
          full viewport, and double-click the title again to drop back to quad. The controls in the
          title bar are unaffected — only the title itself switches views.
        </p>
        <p>
          On a touch screen, outline and rocker are drawn <strong>nose-up</strong> whenever the pane
          is taller than it is wide — which on a phone held upright it is. A board is about four
          times longer than it is wide, so lying it across a narrow pane wastes most of the height;
          standing it up trades that for about half as much again in size. Turn the phone sideways
          and the board lies down again, because a wide pane already fits it the better way round.
          Nothing to set, and it never applies to the cross-section view, which is already the shape
          of its pane.
        </p>
        <p>
          Right-click clear space in any 2D view and choose <strong>Set reference curve</strong>
          to capture its current curves. A faint copy stays underneath as you edit, revealing the
          original shape wherever the live curves move away. Choose the option again to replace the
          reference, or choose <strong>Clear reference curve</strong> to remove it. References are
          temporary: one lasts while its view stays open, is cleared when you move to another
          cross-section, and is never saved with the board.
        </p>
        <p>
          Turn on <strong>Tunni controls</strong> from the <strong>View</strong> menu, or
          right-click a 2D view and check <strong>Show Tunni controls</strong>, to adjust both
          handles of a curve segment together. Drag the amber dashed line to scale the handles
          together, or drag its diamond to adjust their balance and strength. The curve endpoints
          and tangent directions stay fixed. Double-click the diamond to balance the handles.
          Controls are hidden for degenerate geometry, and a drag holds its last valid shape while a
          handle would cross its endpoint. The setting applies to every 2D view and stays on as you
          switch views and cross-sections; each drag is one undo step. Controls appear only on the
          editable half of mirrored views.
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
          Hovering a point or tangent enlarges it; selecting it turns it orange. Its exact X/Y
          position then appears in that pane's header, where you can type a value or use the number
          field arrows for unit-aware increments (5 mm, 0.5 cm, or 0.25 in). Corner points stay
          green and square so they remain distinct from smooth points.
        </p>
        <p>
          Press <code>{shortcutKeys('cross-section-blur')}</code> to clear a selected point or
          tangent handle. On a touch screen, tapping empty canvas does the same — it also releases a
          focused station.
        </p>
        <p>
          Right-click a control point to fair its local curve, switch between smooth and corner,
          select either tangent, or delete it. On the outline and rocker the two tangents are named
          for the end of the board they point at — tail and nose — so the labels still read true
          when a phone draws the board nose-up. A cross-section has neither end nearer the nose, so
          its handles stay left and right. Right-click a tangent to collapse it to zero length; a
          selected collapsed tangent can be right-clicked again and extended so it is easy to grab.
          On a touch screen, press and hold in place for the same menu — holding still is what
          distinguishes it from a drag, so it will not interrupt one you have started.
        </p>
        <p>
          Press <code>{shortcutKeys('delete-point')}</code> to remove the selected point. The curve
          re-fits through the remaining points.
        </p>
      </Section>

      <Section id="locks" title="Locking handle angles">
        <p>
          Lock a point to keep the direction of its tangent handles while you work on their length.
          Select the point or one of its handles and click the padlock in the pane&apos;s header,
          press <code>{shortcutKeys('toggle-lock')}</code>, or right-click the point or a handle and
          choose Lock handle angles. A locked point shows a short bar across each locked
          handle&apos;s line.
        </p>
        <p>
          A locked handle slides along its line: drag it anywhere and it only gets longer or
          shorter, so tuning how full a curve is can no longer tip its angle by accident. Drag it
          back through the point and it collapses to zero length rather than flipping round; drag it
          out again and it comes back the same way. On a smooth point the other handle keeps its own
          length and direction. With a locked handle selected, the pane header shows its length
          instead of X and Y: type a value, or use the arrow keys to step it. The sidebar Control
          point section shows its X and Y read-only, with the length below them.
        </p>
        <p>
          The lock holds through the other point tools too. Fair curve sets new lengths along the
          locked directions, Extend handle grows a collapsed handle along its lock, and moving the
          point carries its handles with it. To lock handles level or upright, use the horizontal or
          vertical align buttons in the sidebar Control point section: aligning a locked point turns
          its lock with it. Resizing the board scales the locks with the shape.
        </p>
        <p>
          Locks are part of the board. Locking and unlocking undo like any other edit, and locks are
          saved in OpenShaper&apos;s own <code>.board.json</code> files and share links. A{' '}
          <code>.brd</code> export leaves them out — BoardCAD has no such setting — so the curve is
          unchanged but its points come back unlocked.
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
          back restores it, along with the view you were in and the camera position. The one
          exception is the quad view on a phone, which is not offered there — a board last left in
          it opens on the outline, and the stored preference is kept for the next time you open the
          editor on a bigger screen.
        </p>
      </Section>
    </DocsPage>
  );
}
