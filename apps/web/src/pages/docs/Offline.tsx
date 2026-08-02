// SPDX-License-Identifier: GPL-3.0-or-later
import { Link } from 'react-router-dom';
import { DocsPage, Section, Term, Terms } from './DocsPage';

export default function DocsOffline() {
  return (
    <DocsPage
      route="/docs/offline"
      title="Offline & installing"
      lede="The editor works without a connection, and can be installed like an app. What that covers, and what it doesn't."
      toc={[
        { id: 'offline', label: 'Working offline' },
        { id: 'install', label: 'Installing' },
        { id: 'scope', label: 'What works offline' },
        { id: 'updates', label: 'Updates' },
      ]}
    >
      <Section id="offline" title="Working offline">
        <p>
          The first time you open the editor with a connection, it stores a copy of itself on your
          device. After that it opens and runs with no network at all — which is the point, since
          workshops are not known for their wi-fi.
        </p>
        <p>
          There is nothing to switch on. It happens on the first visit, and there is no setting to
          find.
        </p>
      </Section>

      <Section id="install" title="Installing">
        <p>
          You can also install OpenShaper as an app: it gets an icon, opens in its own window with
          no browser chrome, and starts straight in the editor. Use your browser's own install
          option — "Install app" in Chrome and Edge, "Add to Home Screen" on iOS.
        </p>
        <p>
          Installing is optional and changes only how it is presented. Offline works either way.
        </p>
      </Section>

      <Section id="scope" title="What works offline">
        <Terms>
          <Term name="The editor">
            Fully. Draw, edit, compute volume, switch views, and restore your last board.
          </Term>
          <Term name="Exports">
            All of them. Files are generated on your device, so STL, DXF, PDF and the spec sheet all
            work with no connection.
          </Term>
          <Term name="These docs">
            Yes — the documentation is stored alongside the app so it is readable in the workshop.
          </Term>
          <Term name="The rest of the site">
            No. The landing page and the long-form guides need a connection; you'll get a short
            offline notice instead.
          </Term>
        </Terms>
      </Section>

      <Section id="updates" title="Updates">
        <p>
          New versions download quietly in the background. When one is ready you'll see a small
          "new version is available" prompt with a Reload button — nothing reloads on its own, so a
          half-finished board is never interrupted. The prompt also waits until you have stopped
          editing before it appears.
        </p>
        <p>
          Your board survives the reload regardless; it is saved continuously (see{' '}
          <Link to="/docs/files">files</Link>).
        </p>
      </Section>
    </DocsPage>
  );
}
