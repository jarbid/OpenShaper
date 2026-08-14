// SPDX-License-Identifier: GPL-3.0-or-later
import { Link } from 'react-router-dom';
import { DocsPage, Section, Term, Terms } from './DocsPage';

export default function DocsOverview() {
  return (
    <DocsPage
      route="/docs"
      title="OpenShaper documentation"
      lede="What each part of the editor does, and how to get from an idea to a file you can cut."
      toc={[
        { id: 'start', label: 'Getting started' },
        { id: 'layout', label: 'How the editor is laid out' },
        { id: 'model', label: 'How a board is described' },
        { id: 'where', label: 'Where things live' },
      ]}
    >
      <Section id="start" title="Getting started">
        <p>
          Open <Link to="/app">the app</Link>. It starts with a board already loaded, so there is
          nothing to set up — drag a control point and the shape changes. Nothing is uploaded
          anywhere: the board lives on your device, and the app keeps working without a connection.
        </p>
        <p>
          The fastest route to something real: pick a starter template, adjust the outline and
          rocker, check the volume, then export a 1:1 PDF or a DXF.
        </p>
      </Section>

      <Section id="layout" title="How the editor is laid out">
        <Terms>
          <Term name="The panes">
            Four views of the same board — outline, rocker, cross-section and 3D. The quad view
            shows all four at once; keys <code>1</code>–<code>5</code> switch between them.
          </Term>
          <Term name="The sidebar">
            Live specs, resize, board details, fins, weight estimate, trace images and the overlay
            toggles. On narrow screens it becomes a bottom sheet.
          </Term>
          <Term name="The menu bar">
            File, Export, Edit, View, Board and Help. On phones this collapses into a single button
            that opens the command palette.
          </Term>
        </Terms>
      </Section>

      <Section id="model" title="How a board is described">
        <p>
          A board is three families of curves: the <strong>outline</strong> (plan shape), the{' '}
          <strong>rocker</strong> (deck and bottom profiles), and a series of{' '}
          <strong>cross-sections</strong> down its length. Everything else — volume, area, the 3D
          mesh, every export — is computed from those.
        </p>
        <p>
          Each curve is a Bézier spline you edit by dragging control points and their tangent
          handles. Cross-sections between the ones you have defined are interpolated, so the surface
          stays continuous.
        </p>
      </Section>

      <Section id="where" title="Where things live">
        <Terms>
          <Term name={<Link to="/docs/editing">Editing a board</Link>}>
            Control points, tangents, the four views, undo.
          </Term>
          <Term name={<Link to="/docs/specs">Specs &amp; measurements</Link>}>
            Volume, dimensions, weight, the readouts and overlays.
          </Term>
          <Term name={<Link to="/docs/fins">Fins</Link>}>Setups, systems, profiles.</Term>
          <Term name={<Link to="/docs/construction">Construction templates</Link>}>
            Hollow wood strip, cutting lists, nesting.
          </Term>
          <Term name={<Link to="/docs/export">Exporting</Link>}>
            STEP, STL, DXF, 1:1 PDF, spec sheet.
          </Term>
          <Term name={<Link to="/docs/files">Files &amp; templates</Link>}>
            Saving, opening, importing from other tools.
          </Term>
          <Term name={<Link to="/docs/offline">Offline &amp; installing</Link>}>
            Working without a connection.
          </Term>
          <Term name={<Link to="/docs/shortcuts">Keyboard shortcuts</Link>}>
            Every key binding.
          </Term>
        </Terms>
      </Section>
    </DocsPage>
  );
}
