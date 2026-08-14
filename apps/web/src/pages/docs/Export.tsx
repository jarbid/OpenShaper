// SPDX-License-Identifier: GPL-3.0-or-later
import { EXPORT_FORMAT_LABELS, EXPORT_FORMATS, type ExportFormat } from '../../file-io';
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
          {/* Keyed off EXPORT_FORMATS rather than Object.entries so `id` stays an
              ExportFormat: that is what makes a missing FORMAT_NOTES entry a
              compile error instead of a blank row. */}
          {EXPORT_FORMATS.map((id) => (
            <Term key={id} name={EXPORT_FORMAT_LABELS[id]}>
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
          For 3D work, prefer STEP over STL. STL is a mesh: your CAD system sees thousands of flat
          triangles, not a surface, so it cannot offset it for a hot-wire allowance, shell it for a
          hollow build, or run a clean finishing toolpath over it. STEP carries the real curved
          surfaces as one solid body, which every major package — Fusion, Rhino, SolidWorks, FreeCAD
          — can machine directly.
        </p>
        <p>
          Two things to know about the STEP file. It is the bare blank surface: fin boxes and plug
          footprints are not cut into it, and live instead on the DXF's fin layer at true scale and
          position. And boards with a concave tail — a swallow or fish — cannot be exported yet,
          because the notch needs surfaces of its own; the menu item is disabled for those, and STL
          or DXF still work.
        </p>
        <p>
          The editor does not yet generate machine G-code directly; you take the STEP, DXF or STL
          into your machine's own CAM software.
        </p>
      </Section>
    </DocsPage>
  );
}

/**
 * Typed as a full `Record<ExportFormat, string>` so a new format without a note
 * here is a compile error rather than an empty row on the page — the same trick
 * `EXPORT_FORMAT_LABELS` uses one file over. The coverage test can only prove an
 * entry exists, never that it says anything.
 */
const FORMAT_NOTES: Record<ExportFormat, string> = {
  stl: 'The tessellated 3D surface. For 3D printing, rendering, or importing into other 3D software.',
  step: 'The hull as true B-spline surfaces, as one solid body. This is the one to use for CAD and CAM: it can be offset, shelled and machined, and the file is around fifty times smaller than the equivalent STL. Fin boxes are not included.',
  dxf: 'Outline, rocker and cross-section curves as polylines — approximated as short straight segments, which almost every CAD and CAM package reads.',
  'dxf-spline':
    'The same curves as true splines. Smaller files and exact geometry, if your software supports them.',
  'pdf-1to1':
    'Full-scale printable templates, tiled across your paper size with overlap and cut marks.',
};
