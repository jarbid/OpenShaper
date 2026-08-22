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
        { id: 'rail-bands', label: 'Rail bands' },
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

      <Section id="rail-bands" title="Rail bands">
        <p>
          Shaping a rail by hand does not mean cutting a curve. You plane a short sequence of flat
          facets — bands — into the squared blank and blend them away, and the numbers you work from
          are where to pencil each line. Most shapers take those off a generic reference chart. This
          export works them out from your board.
        </p>
        <p>
          Each band is the plane that touches your rail exactly where the section's own slope
          reaches that band's angle. That tangent is the point: it is guaranteed to sit outside the
          finished shape everywhere, so a band can never cut away foam the rail needed. A straight
          line drawn from the apex to the deck would not be — on a domed deck it bites into the
          shape.
        </p>
        <p>
          Where those bands sit is worked out for your board, station by station, rather than read
          off a ladder. It matters more than it sounds: the foam a band leaves grows with the{' '}
          <em>cube</em> of the angle it spans, so the traditional 45 / 22.5 / 11.25 leaves 87% of
          everything it misses in the one gap between the rail and the first band — and each extra
          band you cut goes on halving the gap that was already smallest.
        </p>
        <Terms>
          <Term name="Least foam">
            The default. Every band is solved from your own cross-section at that station, so the
            angles change down the length of the board. On the boards this was measured against it
            takes out about 95% of the foam standing proud, against 84% for the ladder. It opens
            the first band wider than tradition does, which leaves the rail corner about twice as
            proud &mdash; use manual mode if you want that corner held.
          </Term>
          <Term name="Halving ladder">
            45&deg;, then halving. The angles printed on every reference card, if you would rather
            work from numbers you already know.
          </Term>
          <Term name="Manual">
            Your own numbers, either as angles or as the marks you would pencil on the blank. The
            sheet still checks them against the board and flags any band that would cut into the
            finished rail.
          </Term>
        </Terms>
        <p>
          Manual marks are the ones the trade already uses: a <strong>rail mark</strong> up from
          the bottom corner, and a <strong>deck mark</strong> in from the top corner for each band.
          The first band joins those two; every band after it starts at the{' '}
          <strong>midpoint of the band before</strong>, which is why one new number per band is
          enough. The tuck takes two marks of its own, up from and in from the bottom corner.
        </p>
        <p>
          The rail mark is set as a <strong>percentage of thickness</strong> rather than a length,
          so it holds as the board thins — the thickness multiplier a shaper applies by eye at the
          nose and tail. Measured against the fitted mode on real boards it holds well: 45&ndash;56%
          from tail to nose. Deck marks and the tuck are entered at the widepoint and scale with
          thickness alongside it.
        </p>
        <p>
          They do not hold as well, and the sheet does not pretend otherwise: a rail hardens toward
          the tips rather than just getting smaller, so one set of marks run down a whole board sits
          proud in places and cuts in in others — which is what a shaper corrects by eye. Set the
          rail percentage and the mark scale at the ends to steer it, and use{' '}
          <strong>Start from the fitted marks</strong> to begin from numbers already true of your
          board rather than a chart written for someone else&rsquo;s.
        </p>
        <p>
          That percentage is the <em>mark</em>, not the rail. Naming a rail
          &ldquo;60/40&rdquo; describes where the finished apex sits along the rail curve counted
          from the deck — 60% of the curve above it, 40% below — and the apex ends up below the
          mark you cut to. The station pages dimension the apex so you can see where it actually
          landed.
        </p>
        <p>
          The dialog reports what each band count would remove before you export, so you can see
          where another pass stops being worth cutting. Add a single band on the bottom — the tuck —
          at whatever your plane is set to.
        </p>
        <Terms>
          <Term name="Band 1 is measured off the blank">
            One mark up from the bottom corner, one in from the deck corner. Those two corners are
            all that exists when you make the first cut.
          </Term>
          <Term name="Later bands are measured on the last cut">
            Band 2's mark sits on the face of band 1, measured back from its deck edge. By the time
            you mark it, the corner band 1 referred to is on the floor — so measuring from it would
            be measuring from nothing.
          </Term>
          <Term name="Cut in the printed order">
            Deck bands from the rail inward, then the tuck last. The tuck destroys the bottom corner
            that every rail mark is measured up from.
          </Term>
        </Terms>
        <p>
          The first page maps the stations along the board — plan and rocker on one scale, with a
          centreline through both — and traces each band's mark down the length as a dash-dot line,
          which is the pencil line you actually draw before planing anything. It tabulates every
          number in the set. That page is a diagram, and stamped as such. Each station then gets its
          own page with the real cross-section at 1:1, the facets drawn on it, the blank's thickness
          dimensioned, and the finished rail ghosted behind so you can see how much is left to
          blend.
        </p>
        <p>
          Colour tracks the band, not the kind of dimension: band 1 blue, band 2 green, band 3 red,
          the tuck magenta. That is what lets you follow one band from the line on the plan view, to
          its row in the table, to the facet on the 1:1 page.
        </p>
        <p>
          The shaded area on each 1:1 page is the foam the cuts do not reach — what is left between
          the last facet and the finished rail, which is what you blend away. The footer says how
          much of the proud foam these passes take out and how deep the worst remaining spot is. A
          red area is the opposite and only appears on hand-marked bands: foam those marks would
          take <em>out</em> of the finished rail. The numbers are left exactly as you entered them
          — a mark you did not choose has no business on the sheet — and the overcut is measured
          instead.
        </p>
        <p>
          Each station page also dimensions the <strong>rail apex</strong> — the widest point of
          the rail — as a height up from the bottom corner. The vertical face left between the rail
          mark and the tuck is what tells you how much rail there is.
        </p>
        <p>
          Because the angles are fitted to each station, they change gradually down the board; the
          sheet quotes the widepoint's and says so. You are following the pencil lines anyway, and
          the marks either side of a station are what a batten springs through.
        </p>
        <p>
          The 1:1 pages are never scaled to fit. If everything will not fit your paper, the
          explanatory notes are dropped first and the page grows only as a last resort — a sheet
          slightly over A4 tempts you into &ldquo;fit to page&rdquo;, which destroys the scale that
          is the whole point.
        </p>
        <p>
          Detail pages are never scaled down. If a mark lands further in than the sheet can show at
          full size, its dimension line is drawn to a break and still carries the true number
          &mdash; that one is a tape measurement off the deck corner, not a line you trace.
        </p>
        <p>
          Station spacing is a target, not an exact interval &mdash; 12 inches by default. The
          spacing is adjusted so stations land exactly on both ends of the length you are banding
          and on the widepoint, rather than leaving a random leftover gap at each tip. The dialog
          tells you the spacing it settled on.
        </p>
        <p>
          &ldquo;Leave each end&rdquo; is where the bandable rail stops, for the stretch into nose
          and tail that is all blend. If that margin lands somewhere there is no rail left to band
          &mdash; a few centimetres from a pointed nose, say &mdash; the end is pulled in to the
          first point that can be banded, so the stations still reach it.
        </p>
        <p>
          A bottom edge that is genuinely hard or near-flat, rather than rounded, is reported as
          such instead of being given a radius &mdash; a radius is only printed when one was
          actually measured off your curve.
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
          STEP opens a small dialog first. <strong>Units</strong> only changes the numbers written
          into the file — it states its own unit, so the board lands at the right size either way.
          <strong> Accuracy</strong> is how closely the exported surfaces track your design; even
          the draft setting is finer than a blank cutter&rsquo;s finishing pass, so there is rarely
          a reason to leave Standard.
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
  'rail-bands':
    'The flat facets to plane into a squared blank when shaping the rail by hand, worked out from this board’s own cross-sections: where to pencil each line, and what angle to cut it at.',
};
