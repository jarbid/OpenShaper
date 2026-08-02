// SPDX-License-Identifier: GPL-3.0-or-later
import { Link } from 'react-router-dom';
import { DocsPage, Section, Term, Terms } from './DocsPage';

export default function DocsConstruction() {
  return (
    <DocsPage
      route="/docs/construction"
      title="Construction templates"
      lede="Hollow wood strip templates: rail bands, frames, cutting lists and sheet nesting, ready for a laser or a router."
      toc={[
        { id: 'what', label: 'What it produces' },
        { id: 'params', label: 'Parameters' },
        { id: 'kerf', label: 'Kerf & tolerances' },
        { id: 'nesting', label: 'Nesting & cutting lists' },
        { id: 'output', label: 'Output formats' },
      ]}
    >
      <Section id="what" title="What it produces">
        <p>
          A hollow wooden surfboard is built from an internal frame skinned with rail bands. The
          construction panel derives that frame from the board you have designed: the profile spine,
          the cross-frames, and the rail bands unrolled flat so they can be cut from sheet stock.
        </p>
        <p>
          The rail bands are offset from the outline and developed flat, rather than approximated —
          when they curve back onto the board they meet the frame where they should.
        </p>
      </Section>

      <Section id="params" title="Parameters">
        <Terms>
          <Term name="Skin thickness">
            How much the frame is inset so the finished skin lands on your designed surface.
          </Term>
          <Term name="Frame spacing">Distance between cross-frames along the length.</Term>
          <Term name="Nose & tail blocks">
            Solid blocks at each end where a frame would be impractical.
          </Term>
        </Terms>
      </Section>

      <Section id="kerf" title="Kerf & tolerances">
        <p>
          A cutting tool removes material as it cuts. The kerf setting compensates for that width so
          parts come out at the size you asked for rather than consistently undersized.
        </p>
        <p>
          If a part would come out too small or too fragile to cut sensibly, the panel warns rather
          than silently producing something unusable.
        </p>
      </Section>

      <Section id="nesting" title="Nesting & cutting lists">
        <p>
          Parts can be packed onto sheets of a size you specify, so you can see how much stock a
          build needs before buying it. The cutting list enumerates every part with its dimensions.
        </p>
      </Section>

      <Section id="output" title="Output formats">
        <Terms>
          <Term name="DXF">For a laser or CNC router.</Term>
          <Term name="SVG">For plotters and general vector tooling.</Term>
          <Term name="PDF">
            Tiled across paper at 1:1 with overlap and cut marks, for tracing by hand. See{' '}
            <Link to="/docs/export">exporting</Link> for how tiling works.
          </Term>
        </Terms>
      </Section>
    </DocsPage>
  );
}
