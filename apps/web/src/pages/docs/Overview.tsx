// SPDX-License-Identifier: GPL-3.0-or-later
import { Link } from 'react-router-dom';
import { shortcutKeys } from '../../shortcuts';
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
        { id: 'help', label: 'Finding a tool' },
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
            shows all four at once, and the split view (<code>6</code>, desktop only) stacks any two
            of them full width; keys <code>1</code>–<code>6</code> switch between them. On phones
            the quad view is not offered — four panes in a phone's width leaves none of them usable
            — so the editor opens on the outline and keys <code>2</code>–<code>5</code> switch.
          </Term>
          <Term name="The sidebar">
            Four tabs down its edge — Specs, Shape, Build and Reference — so the tool list is always
            readable and never pushed off-screen by whatever you have open. Specs is the live
            readout; Shape holds resize, the control-point inspector and the overlay toggles; Build
            holds board details, fins and the weight estimate; Reference holds trace images, history
            and the ghost comparison. Inside a tab each tool is a section you open by clicking its
            header, and a shut section still shows a summary, so you can read a tab without opening
            anything.
          </Term>
          <Term name="Pinning a tab">
            The pin in a panel&apos;s header keeps that panel on screen while you work in another
            tab — Specs pinned above Shape, say, so the numbers stay visible while you edit. One tab
            can be pinned at a time. The double-chevron beside it opens or shuts every section in
            the panel at once, and the chevron after that folds the panel away entirely, leaving the
            tab strip and the headline dimensions. Clicking any tab brings it back.
          </Term>
          <Term name="Tools that follow the view">
            Changing view opens the sections that view is for and shuts the ones it is not — trace
            controls in the outline and rocker, fins in 3D. It never switches tabs and never hides a
            tool: once you open or close a section yourself, it stays as you left it. On narrow
            screens the sidebar becomes a bottom sheet with the tabs laid out as a row.
          </Term>
          <Term name="The menu bar">
            File, Export, Edit, View, Board and Help. On phones this collapses into a single button
            that opens the command palette.
          </Term>
        </Terms>
      </Section>

      <Section id="help" title="Finding a tool">
        <Terms>
          <Term name="Searching commands">
            The command palette (<code>{shortcutKeys('command-palette')}</code>, or the menu button
            on a phone) searches every menu command. It matches the command&apos;s name, the words a
            shaper might use for it and what it does, so <code>scale</code> finds{' '}
            <strong>Resize…</strong>, <code>litres</code> finds the volume tools and{' '}
            <code>slice</code> finds the cross-section exports. Results are grouped by the menu they
            live in, each with a line on what it does; the best match is listed first, and Enter
            runs it. The link under the list opens the documentation for the highlighted command.
            Commands added in the last 60 days carry a <strong>New</strong> badge.
          </Term>
          <Term name="Tips">
            Hovering or tabbing to a toolbar button shows its name and, under it, a line on what it
            does. Once you know the buttons, turn the second line off with{' '}
            <strong>Edit ▸ Settings… ▸ Show tips</strong>; the names keep showing, since an icon
            button has no other label you can see. Tips are for a mouse or trackpad and keyboard
            focus — a touch screen does not show them.
          </Term>
          <Term name="The ? on a section">
            Each sidebar section has a small <strong>?</strong> beside its header that opens the
            part of these docs that explains it. Your board is kept while you read; going back to
            the app brings it back as you left it.
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
        <p>
          The outline and the rocker define the blank. Cross-sections shape the rails inside it and
          never change it — see{' '}
          <Link to="/docs/editing#blank">cross-sections stay inside the blank</Link>.
        </p>
      </Section>

      <Section id="where" title="Where things live">
        <Terms>
          <Term name={<Link to="/docs/editing">Editing a board</Link>}>
            Control points, tangents, the views, undo.
          </Term>
          <Term name={<Link to="/docs/specs">Specs &amp; measurements</Link>}>
            Volume, dimensions, resizing, weight, the readouts and overlays.
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
