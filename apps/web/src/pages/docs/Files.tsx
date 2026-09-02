// SPDX-License-Identifier: GPL-3.0-or-later
import { BOARD_TEMPLATES } from '../../templates';
import { DocsPage, Section, Term, Terms } from './DocsPage';

/** Starter templates are listed from BOARD_TEMPLATES so the list can't go stale. */
export default function DocsFiles() {
  return (
    <DocsPage
      route="/docs/files"
      title="Files & templates"
      lede="Starter templates, saving and opening, importing from Shape3d and BoardCAD, and where your work is kept."
      toc={[
        { id: 'templates', label: 'Starter templates' },
        { id: 'saving', label: 'Saving & opening' },
        { id: 'import', label: 'Importing from other tools' },
        { id: 'warnings', label: 'Import warnings' },
        { id: 'storage', label: 'Where your work is kept' },
        { id: 'trace', label: 'Tracing from an image' },
      ]}
    >
      <Section id="templates" title="Starter templates">
        <p>
          Three boards to start from, each real geometry rather than an approximation — inherited
          from BoardCAD, which OpenShaper descends from.
        </p>
        <Terms>
          {BOARD_TEMPLATES.map((t) => (
            <Term key={t.name} name={t.name}>
              {TEMPLATE_NOTES[t.name] ?? 'Starter board.'}
            </Term>
          ))}
        </Terms>
      </Section>

      <Section id="saving" title="Saving & opening">
        <Terms>
          <Term name=".board.json">
            OpenShaper's own format. Plain JSON, so it stays readable and diffable, and it round-trips
            everything the app knows about a board.
          </Term>
          <Term name=".brd">
            The legacy BoardCAD format. Written for compatibility with the older tool, though some
            OpenShaper-specific detail has nowhere to live in it.
          </Term>
        </Terms>
        <p>
          Saving downloads a file through the browser. Recently opened boards are listed so you can
          get back to them without hunting through a downloads folder.
        </p>
      </Section>

      <Section id="import" title="Importing from other tools">
        <p>
          The editor reads Shape3d files (<code>.s3dx</code> and the older <code>.s3d</code>) and
          BoardCAD <code>.brd</code> files, including the weakly-encrypted variant. The intent is
          that a design you already own is not stranded in software you have stopped using.
        </p>
        <p>
          Real-world files vary, so imported geometry is repaired where it is safe to do so — for
          example reconciling a deck curve stored as thickness rather than an absolute height, which
          would otherwise produce a visible bulge in the rocker.
        </p>
      </Section>

      <Section id="warnings" title="Import warnings">
        <p>
          When a file contains something that cannot be represented exactly, you are told rather
          than left to notice later. Two levels: a notice when the file was repaired non-destructively,
          and a confirmation you have to accept when detail will actually be dropped.
        </p>
      </Section>

      <Section id="storage" title="Where your work is kept">
        <p>
          On your device. The board you are working on is saved continuously to browser storage, so
          closing the tab and returning restores it — along with your view, camera position, trace
          images and settings.
        </p>
        <p>
          Boards are saved in your browser, not to an account. That also means clearing your
          browser's site data clears your working board, so export anything you want to keep.
        </p>
      </Section>

      <Section id="trace" title="Tracing from an image">
        <p>
          You can load a photo or scan behind the outline or rocker view and shape to it. Calibrate
          by clicking four known points and entering a real dimension, then move, rotate and flip the
          image to line it up. Trace images are stored per view on your device and are not part of
          the board file.
        </p>
      </Section>
    </DocsPage>
  );
}

const TEMPLATE_NOTES: Record<string, string> = {
  Shortboard: 'A performance shortboard — the default board the editor opens with.',
  Funboard: 'A mid-length, between a shortboard and a longboard.',
  Longboard: 'A traditional longboard outline and rocker.',
};
