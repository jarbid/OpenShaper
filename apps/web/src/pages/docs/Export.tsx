// SPDX-License-Identifier: GPL-3.0-or-later
import { EXPORT_FORMAT_LABELS } from '../../file-io';
import { DocsPage, Section, Term, Terms } from './DocsPage';

/**
 * Formats are listed from EXPORT_FORMAT_LABELS, so this page can't drift out of
 * sync with what the app actually exports.
 */
export default function DocsExport() {
  return (
    <DocsPage
      route="/docs/export"
      title="Exporting"
      lede="Every format the editor writes, what each is for, and how 1:1 printing works."
      toc={[
        { id: 'formats', label: 'Formats' },
        { id: 'pdf', label: '1:1 PDF printing' },
        { id: 'spec', label: 'Spec sheet' },
        { id: 'cnc', label: 'Getting it cut' },
      ]}
    >
      <Section id="formats" title="Formats">
        <Terms>
          {Object.entries(EXPORT_FORMAT_LABELS).map(([id, label]) => (
            <Term key={id} name={label}>
              {FORMAT_NOTES[id]}
            </Term>
          ))}
        </Terms>
        <p>
          Everything is generated on your device and downloaded directly — no file is uploaded
          anywhere, and exporting works offline.
        </p>
      </Section>

      <Section id="pdf" title="1:1 PDF printing">
        <p>
          A surfboard does not fit on a sheet of paper, so the 1:1 export tiles it across as many
          pages as needed, at true scale. You choose the paper size, and the pages carry overlap and
          alignment marks so they can be joined accurately.
        </p>
        <p>
          Print at 100% — any "fit to page" or "shrink to fit" setting silently destroys the scale,
          which is the one thing this export exists to preserve. Check the printed ruler mark before
          cutting anything.
        </p>
        <p>
          Parts can be exported together or as separate files, which is easier to handle when a
          longboard runs to a lot of pages.
        </p>
      </Section>

      <Section id="spec" title="Spec sheet">
        <p>
          A one-page summary of the board's numbers — dimensions at the standard stations, volume,
          and your board details — opened in a new tab ready to print. This is the sheet you hand to
          someone else, rather than a file for a machine.
        </p>
      </Section>

      <Section id="cnc" title="Getting it cut">
        <p>
          DXF is the format most cutting services and CAM tools accept. Use true curves when the
          receiving software handles splines, and polylines when it does not — polylines are more
          widely compatible, at the cost of approximating curves as many short segments.
        </p>
        <p>
          The editor does not yet generate machine G-code directly; you take the DXF or STL into
          your machine's own CAM software.
        </p>
      </Section>
    </DocsPage>
  );
}

const FORMAT_NOTES: Record<string, string> = {
  stl: 'The tessellated 3D surface. For 3D printing, rendering, or importing into other 3D software.',
  dxf: 'Outline, rocker and cross-section curves as polylines — approximated as short straight segments, which almost every CAD and CAM package reads.',
  'dxf-spline': 'The same curves as true splines. Smaller files and exact geometry, if your software supports them.',
  'pdf-1to1':
    'Full-scale printable templates, tiled across your paper size with overlap and cut marks.',
};
