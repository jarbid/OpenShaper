// SPDX-License-Identifier: GPL-3.0-or-later
import { DocsPage, Section, Term, Terms } from './DocsPage';

export default function DocsSpecs() {
  return (
    <DocsPage
      route="/docs/specs"
      title="Specs & measurements"
      lede="Volume, dimensions, weight and the analysis overlays — what each number means and how it is worked out."
      toc={[
        { id: 'readout', label: 'The spec readout' },
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
      </Section>

      <Section id="volume" title="Volume">
        <p>
          Volume is integrated from the actual surface rather than estimated from a formula, and it
          accounts for a concave tail if the outline has one. It is always shown in litres, which is
          how boards are specified everywhere regardless of whether you work in inches or
          millimetres.
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
            Quills drawn normal to a curve, scaled by curvature. A fair curve gives a smooth comb;
            a kink shows as a spike or a sudden flip. This is the fastest way to find a flat spot
            in a rail that looks fine to the eye.
          </Term>
          <Term name="Volume distribution">
            How volume is spread along the length — where the board carries its float.
          </Term>
        </Terms>
      </Section>

      <Section id="ghost" title="Comparing two boards">
        <p>
          Load a second board as a reference and it is drawn dashed underneath the one you are
          editing, in every view, with its specs shown alongside yours. The cross-section ghost is
          interpolated to whatever station you are looking at, so the comparison is like-for-like.
        </p>
        <p>
          This is the practical way to answer "what did I actually change from the one that worked".
        </p>
      </Section>
    </DocsPage>
  );
}
