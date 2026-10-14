// SPDX-License-Identifier: GPL-3.0-or-later
import { shortcutKeys } from '../../shortcuts';
import { DocsPage, Section, Term, Terms } from './DocsPage';

export default function DocsSpecs() {
  return (
    <DocsPage
      route="/docs/specs"
      title="Specs & measurements"
      lede="Volume, dimensions, weight and the analysis overlays — what each number means and how it is worked out."
      toc={[
        { id: 'readout', label: 'The spec readout' },
        { id: 'resize', label: 'Resizing a board' },
        { id: 'volume', label: 'Volume' },
        { id: 'units', label: 'Units' },
        { id: 'weight', label: 'Weight estimate' },
        { id: 'overlays', label: 'Analysis overlays' },
        { id: 'ghost', label: 'Comparing two boards' },
      ]}
    >
      <Section id="readout" title="The spec readout">
        <p>
          The sidebar shows length, width and thickness continuously as you edit, along with nose
          and tail measurements at the standard stations (12″ and 24″ from each end) and the wide
          point. Clicking the headline dimensions copies them to the clipboard.
        </p>
        <p>
          These are computed in a background worker, so dragging a control point never stutters
          while the numbers catch up.
        </p>
        <p>
          The readout is written in four bands — Nose, Center, Tail and Overall — and each one
          collapses. Overall starts open; the other three start shut, with the number that band is
          usually consulted for on its header, so the whole readout fits a laptop screen without
          scrolling. Open as many as you want; the choice is remembered.
        </p>
        <p>
          Specs has its own tab, so it is always one click away, and the headline dimensions and
          volume stay on the tab strip even when the panel is folded away — the numbers you check
          most are never more than a glance from wherever you are working.
        </p>
      </Section>

      <Section id="resize" title="Resizing a board">
        <p>
          To scale a finished design to new dimensions, choose <strong>Board ▸ Resize…</strong>, or
          open the command palette (<code>{shortcutKeys('command-palette')}</code>, or the menu
          button on a phone) and type <code>resize</code>. It opens the Resize section of the
          sidebar&apos;s Shape tab, with the cursor in the first field.
        </p>
        <Terms>
          <Term name="Length, Width, Thickness">
            The size you want, typed in the current display unit. The board&apos;s present size
            shows greyed out in each field as a reminder. These are the readout&apos;s Length, Width
            and Thickness: the straight tip-to-tail length (not Length o/curve, whichever
            measurement axis is selected), the widest point and the thickest point.
          </Term>
          <Term name="A blank field">
            Keeps that dimension as it is. Fill in only length to make the board longer without
            making it any wider or thicker.
          </Term>
          <Term name="Apply">
            Scales the whole board by one factor along each filled-in axis, so it reaches the target
            without changing its lines in that direction: a board made 5% wider is 5% wider at the
            nose, the tail and every station between. Length stretches the outline, rocker and deck
            and moves the cross-sections and fins along with them; width scales the outline and
            every cross-section&apos;s width; thickness scales the rocker, deck and cross-section
            heights. Fins and locked handle angles scale with the board too.
          </Term>
        </Terms>
        <p>
          Resizing is one step in the undo history (<em>Resize board</em>), so a result you do not
          like is one undo away. The fields clear once it is applied.
        </p>
      </Section>

      <Section id="volume" title="Volume">
        <p>
          Volume is integrated from the actual surface rather than estimated from a formula, and it
          accounts for a concave tail if the outline has one. It is always shown in litres, to one
          decimal place (27.4L) — which is how boards are specified everywhere, regardless of
          whether you work in inches or millimetres.
        </p>
        <p>
          The integration refines adaptively until the result stops changing, instead of using a
          fixed number of slices — so a longboard and a fish are both accurate, rather than one
          being accurate and the other approximate.
        </p>
      </Section>

      <Section id="units" title="Units">
        <p>
          The unit selector in the toolbar switches every length in the interface at once —
          millimetres, centimetres, inches, or feet and inches with fractions. Nothing is shown in a
          fixed unit, and exports follow the same selection.
        </p>
        <p>
          Beside it, <strong>x-axis / o/curve</strong> chooses how positions along the board are
          measured: straight from the tail, or over the bottom curve, the way a tape laid along the
          stringer reads. On <strong>o/curve</strong> the cursor position, cross-section positions
          (typed and dragged), the wide point and the centre of mass are measured over the curve and
          marked <code>o/c</code>. The 12&quot; and 24&quot; stations, control points and fins stay
          straight-line, and the board itself never moves.
        </p>
        <p>Volume is the deliberate exception: always litres.</p>
      </Section>

      <Section id="weight" title="Weight estimate">
        <p>
          An estimate of the finished board's weight from its volume, the foam type and the glassing
          schedule you pick. It is a planning figure — useful for comparing two designs, not a
          promise about the board that comes out of the glassing bay.
        </p>
      </Section>

      <Section id="overlays" title="Analysis overlays">
        <Terms>
          <Term name="Grid & guides">Scale reference and station lines.</Term>
          <Term name="Curvature comb">
            Quills drawn normal to every edited curve in the outline, rocker and cross-section
            views, longer where the curve bends tighter. This is the fastest way to find a flat spot
            in a rail that looks fine to the eye. How to read it: a smooth envelope along the quill
            tips means the curvature flows smoothly; a step in the envelope at a control point is a
            sudden change in curvature there; quills shrinking to the curve are a flat spot. Each
            comb stays outside the board — deck quills above the deck, bottom quills below the
            bottom, outline quills away from the stringer — so it never cuts through the foam. Where
            a curve turns from convex to concave (a deck flowing into a kicked nose, a concave
            running into the rail) a small ring on the curve marks the inflection. Curves in one
            view share a scale (deck and bottom quills compare directly); the tightest spots, such
            as a pinched nose tip, are capped so they do not shrink the rest of the comb.
          </Term>
          <Term name="Volume distribution">
            How volume is spread along the length — where the board carries its float.
          </Term>
          <Term name="Apex line">
            A dashed green line in the rocker view at the height of the rail apex — the widest point
            of each section, measured off the 3D surface. It is the rail point that parts the deck
            from the bottom: the line a CNC machine flips the blank on. Read against the deck and
            bottom curves, it shows where along the board the rail sits high or low. It updates when
            you let go of a drag. The 3D view draws the same line on the hull, and the DXF export
            carries it on its own layer.
          </Term>
        </Terms>
      </Section>

      <Section id="ghost" title="Comparing two boards">
        <p>
          Load a second board as a reference with <strong>Board ▸ Open ghost…</strong> and it is
          drawn dashed underneath the one you are editing, in every view, with its specs shown
          alongside yours. The cross-section ghost is interpolated to whatever station you are
          looking at, so the comparison is like-for-like. <strong>Board ▸ Clear ghost</strong> puts
          it away.
        </p>
        <p>
          This is the practical way to answer "what did I actually change from the one that worked".
        </p>
        <Terms>
          <Term name="Deviation from ghost">
            A mode in the 3D view&rsquo;s <strong>Surface analysis</strong> menu that paints the
            whole hull by how far it lies from the ghost: red where your board has more foam, blue
            where it has less, the pale middle of the scale where the two agree. It is measured
            across the board, in each station&rsquo;s own plane: a point a given distance from the
            tail is compared with the ghost&rsquo;s cross-section at the same distance from{' '}
            <em>its</em> tail, and the number is the shortest way from the point to that section. On
            the deck, bottom and rails that is simply how much foam was added or taken off there.
          </Term>
        </Terms>
        <p>
          <strong>The band.</strong> A slider beside the menu sets how big a difference gets full
          colour: anything beyond it, either way, is painted at full strength. It runs from 1 mm to
          2 cm and starts at 5 mm. Narrow it to see sanding-sized differences, widen it to see the
          shape of a deliberate change. The legend in the corner of the 3D view gives the band and
          the biggest differences found, in your display unit.
        </p>
        <p>
          <strong>No alignment.</strong> Both boards keep their tail at the same place, so nothing
          is slid or rotated to make them match. A board that is longer or shorter shows the change
          where it happens: past the end of a shorter ghost there is nothing to compare with, and
          that part is striped grey &mdash; <em>no data</em>. So is the very end of the board
          itself, a pointed tip or the middle of a square tail&rsquo;s end face, where there is no
          edge of a section to measure from. Near the nose and tail the surface turns to face along
          the board, so there a difference in length shows up as a difference across it.
        </p>
        <p>
          The mode is listed but disabled until a ghost is loaded. It works on a swallow or fish
          tail too, either board&rsquo;s. It is worked out in the background and follows your edits
          whenever you pause; during a drag the coloured hull stays a step behind.
        </p>
      </Section>
    </DocsPage>
  );
}
