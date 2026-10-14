// SPDX-License-Identifier: GPL-3.0-or-later
import { Link } from 'react-router-dom';
import { RAIL_PRESETS } from '@openshaper/kernel';
import { NUDGE, shortcutKeys } from '../../shortcuts';
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
        { id: 'analysis', label: 'Surface analysis in 3D' },
        { id: 'points', label: 'Control points & tangents' },
        { id: 'locks', label: 'Locking handle angles' },
        { id: 'keyboard', label: 'Nudging from the keyboard' },
        { id: 'sections', label: 'Cross-sections' },
        { id: 'blank', label: 'Cross-sections stay inside the blank' },
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
          The 3D view can draw reference lines directly on the surface. Three buttons in the 3D
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
          <Term name="Apex">
            A green line down each rail through the rail apex: the widest point of every section,
            where the rail stops facing down and starts facing up. It is the line that parts the
            deck from the bottom &mdash; where a CNC machine flips the blank to cut the other side.
            Where a rail has a truly vertical face, the line runs down the middle of it; inside a
            swallow or fish notch it follows the outer rail. The rocker view can show the same
            line&rsquo;s height (see <Link to="/docs/specs#overlays">Analysis overlays</Link>).
          </Term>
        </Terms>
        <p>
          The lines are computed from the same surface the mesh is built from, so they sit on the
          board rather than floating near it. All three toggles are remembered between sessions,
          along with the rest of the 3D appearance settings.
        </p>
      </Section>

      <Section id="analysis" title="Surface analysis in 3D">
        <p>
          The <strong>Surface analysis</strong> menu in the 3D controls repaints the hull to show
          its shape rather than its finish. Three modes are <em>exact</em>: they fit the hull with
          the same B-spline surface the <Link to="/docs/export">STEP export</Link> writes &mdash;
          within 0.15 mm of the 3D hull &mdash; and work out its curvature mathematically at every
          point, so what you see does not change with zoom or mesh quality. The rest are quick
          effects on the viewport mesh.
        </p>
        <Terms>
          <Term name="Zebra">
            Stripes, as if a striped room were reflected in a glossed board. Stripes that run on
            smoothly mean a smooth surface; a kink in them is a crease.
          </Term>
          <Term name="Mean curvature">
            How much the surface bends, averaged over its two directions, and which way: red is
            convex (a domed deck, a rail), blue is concave (a bottom concave, a dished deck), grey
            is flat. Use it to judge how evenly the deck and bottom flow. The rails are usually
            beyond the scale and show solid red &mdash; read them with Rail radius.
          </Term>
          <Term name="Gaussian curvature">
            The two bends multiplied: red where the surface curves the same way in every direction,
            like a dome; blue on a saddle, curving up one way and down the other &mdash; where a
            concave runs out into the rail, or rocker meets a vee; grey where it is flat or bent one
            way only, like a cylinder. A fair board has broad, calm areas; blotches show where the
            shape twists.
          </Term>
          <Term name="Rail radius">
            The tightest radius of curvature at each point &mdash; the smallest circle that fits the
            surface there. Dark is tight, a hard or tucked edge, fading to light where the board is
            flat. Follow a rail from tail to nose to see where the edge hardens and softens.
          </Term>
          <Term name="Normal change (approx.)">
            The quick view: how fast the mesh normal turns from one pixel to the next. Rails and
            nose light up, but the picture changes as you zoom and with mesh quality, and it cannot
            tell a smooth join from a break &mdash; hence &ldquo;approx.&rdquo; It is the curvature
            view that works on a concave tail.
          </Term>
          <Term name="Slope">
            How far the surface faces away from straight up: deck and bottom one colour, the rails
            another.
          </Term>
          <Term name="Deviation from ghost">
            With a reference board loaded, how far your board lies from it at every point: red for
            more foam, blue for less. See <Link to="/docs/specs#ghost">Comparing two boards</Link>.
          </Term>
        </Terms>
        <p>
          <strong>Reading the exact modes.</strong> A legend in the corner of the 3D view shows the
          colour scale. Curvature is labelled as a radius in your display unit &mdash; &ldquo;as
          curved as a ball of radius 3.3 cm&rdquo; &mdash; and the scale fits itself to the board:
          it ends at the curvature that only the most curved fifth of the surface (by area) goes
          beyond, so a needle-sharp nose tip cannot wash the rest out to grey. Rail radius runs from
          the tightest two percent of the board to its median.
        </p>
        <p>
          <strong>Expect a band at every cross-section.</strong> The hull is lofted from one station
          to the next with a straight-line blend, so it changes direction slightly at each station
          instead of flowing through it &mdash; a real crease, however small. The exact modes show
          every one of them as a crisp line across the board where the colour jumps. That is not a
          drawing artefact: it is the shape the exports describe, and it is where a smoother loft
          would make a difference.
        </p>
        <p>
          An exact mode takes about a second to compute, in the background, so editing never waits
          for it. When you pick one, and after each edit, the 3D view shows the board shaded as
          normal with <em>Computing curvature&hellip;</em> in the corner until the result is ready.
          During a drag it waits until you let go.
        </p>
        <p>
          The fitted surface does not yet model a{' '}
          <Link to="/docs/editing#tail">concave (swallow or fish) tail</Link> &mdash; the same limit
          as STEP export &mdash; so on such a board the three exact modes are listed but disabled,
          with the reason. If one was already chosen, the view says so and shows Normal change
          (approx.) instead.
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
          re-fits through the remaining points. A curve&apos;s two endpoints cannot be deleted, nor
          can a cross-section&apos;s widest point — see{' '}
          <Link to="/docs/editing#blank">Cross-sections stay inside the blank</Link>.
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
          its lock with it. <Link to="/docs/specs#resize">Resizing the board</Link> scales the locks
          with the shape.
        </p>
        <p>
          Locks are part of the board. Locking and unlocking undo like any other edit, and locks are
          saved in OpenShaper&apos;s own <code>.board.json</code> files and share links. A{' '}
          <code>.brd</code> export leaves them out — BoardCAD has no such setting — so the curve is
          unchanged but its points come back unlocked.
        </p>
      </Section>

      <Section id="keyboard" title="Nudging from the keyboard">
        <p>
          Select a point or a handle and press the arrow keys (<code>{shortcutKeys('nudge')}</code>)
          to move it one step at a time: 5 mm, 0.5 cm or 0.25 in, depending on the length unit. Hold
          Shift for {NUDGE.shiftFactor} steps at once. The arrows work in whichever view holds the
          selection, and in the pane header&apos;s own X, Y or Length field, where they step that
          value (Shift with Left or Right still selects text there); not in any other text field,
          nor while a dialog is open. Each press is one undo step.
        </p>
        <p>
          Two keys, held down, change what the arrows do. On their own they do nothing; let go and
          the arrows move the selection again.
        </p>
        <Terms>
          <Term name={`Hold ${NUDGE.rotateKey.toUpperCase()}: turn`}>
            <code>{shortcutKeys('nudge-rotate')}</code> turns the selected handle about its point,{' '}
            {NUDGE.turnDegrees}° per press, keeping its length: Left and Up counter-clockwise, Right
            and Down clockwise, as you see it — in every view, including a phone&apos;s nose-up one.
            With the point itself selected, both of its handles turn by the same angle. A smooth
            point&apos;s two handles always turn together, so it stays smooth. Shift turns{' '}
            {NUDGE.turnDegrees * NUDGE.shiftFactor}°.
          </Term>
          <Term name={`Hold ${NUDGE.lengthKey.toUpperCase()}: length`}>
            <code>{shortcutKeys('nudge-length')}</code> lengthens (Right, Up) or shortens (Left,
            Down) the selected handle by one step along the line it points, never past zero; with
            the point selected, both of its handles (at a curve&apos;s first or last point, the one
            handle the curve uses). A handle only shortens to nothing when it can grow back the way
            it pointed — along its lock, or opposite the other handle of a smooth point — so a point
            never loses its tangent; any other handle stops at its last step short of zero. Shift
            changes it {NUDGE.shiftFactor} steps at once.
          </Term>
        </Terms>
        <p>
          A lock fixes a handle&apos;s angle, so turning does nothing to a locked handle — and, on a
          smooth point, to either of its handles — while its length still changes. A turn that would
          fold a curve back on itself, such as an outline or rocker handle turned past square to the
          board&apos;s length, is not made at all rather than squashing the handle: the press does
          nothing, and smaller steps without Shift still take it closer. A ⌘ chord, such as{' '}
          <code>{shortcutKeys('undo')}</code> to take back a step, ends a held mode: press R or T
          again before the next arrow. Every chord is listed on the{' '}
          <Link to="/docs/shortcuts#nudging">shortcuts</Link> page.
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

      <Section id="blank" title="Cross-sections stay inside the blank">
        <p>
          The outline and the rocker — deck and bottom — define the blank, the way a shaper
          hot-wires the side profile and then cuts the outline. Cross-sections (slices) refine that
          blank and always sit inside it, so editing one never changes the outline, the deck or the
          bottom. Those change only in their own views.
        </p>
        <Terms>
          <Term name="Centre points">
            The two points on the stringer sit on the bottom and on the deck, so they do not move. A
            ring marks each, and the sidebar and the pane header show their position read-only.
            Their handles stay free. To make the board thicker or thinner there, edit the rocker.
          </Term>
          <Term name="Apex">
            The section&apos;s widest point holds it to the outline&apos;s width, so it moves only
            up and down — which is how you raise or lower the rail. Chevrons above and below it show
            the way it can go, its distance from the stringer shows read-only, and it cannot be
            deleted. Its handles can lengthen, shorten or lean in, but never out past it, which
            keeps a smooth apex&apos;s handles upright. To make the board wider or narrower there,
            edit the outline.
          </Term>
          <Term name="Every other point">
            Moves freely inside the apex, and stops on the line through it when dragged further out;
            so does every handle. Where two points sit level at the widest, as on a boxy rail,
            neither is singled out: either can move in while the other keeps the width.
          </Term>
        </Terms>
        <p>
          A drag the blank refuses outright, such as pulling on a centre point, leaves nothing on
          the undo stack. With <strong>Resize cross-sections to rocker/deck</strong> on in Settings
          (the default), editing the outline or the rocker resizes the cross-sections in that area
          to match; turned off, they keep their own size. Either way, editing a cross-section leaves
          the curves alone.
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
