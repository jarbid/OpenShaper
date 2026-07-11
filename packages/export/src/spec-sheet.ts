/**
 * Printable board spec-sheet as a standalone HTML document.
 *
 * A pure `doc -> string` transform (no DOM, no window) so it is unit-testable and
 * lives alongside the other exporters. The caller formats values into the active
 * units, hands over a headline + grouped sections + a technical drawing, then opens
 * the returned HTML in a window. All interpolated *text* is HTML-escaped; the
 * `diagramSvg` is trusted markup produced by {@link boardDiagramSvg}.
 *
 * Aesthetic: a shaper's blueprint. On screen it wears the "Deep Ocean Tech" identity
 * (navy ground, cyan line-work, mono draughting labels) with the plan/rocker/section
 * drawing as the centrepiece — the same content as the vector PDF (`pdf.ts`) so the
 * two read as one family. `@media print` flips to a clean white draughting sheet with
 * black line-work, so it prints like the PDF and saves ink.
 */
export interface SpecSection {
  /** Group heading (e.g. "Nose", "Center", "Tail", "Overall"). */
  title: string;
  /** Dimension rows (label, pre-formatted value). */
  rows: readonly (readonly [string, string])[];
}

export interface SpecSheetDoc {
  /** Document title and heading (e.g. the board model, or "Surfboard"). */
  title: string;
  /** Optional designer credit, shown under the heading. */
  designer?: string;
  /** Optional date string (e.g. ISO `2026-06-18`), shown in the header block. */
  date?: string;
  /** Hero dimension line, e.g. `6'2" × 19¼" × 2½" · 28.4 L`. */
  headline?: string;
  /** Free-form board info chips (Surfer / Fins / Notes …). */
  info: readonly (readonly [string, string])[];
  /** Grouped dimension sections, rendered as cards. */
  sections: readonly SpecSection[];
  /** Optional plan/rocker/section `<svg>` drawing (trusted markup). */
  diagramSvg?: string;
  /**
   * Optional per-fin placement breakdown, rendered as a full-width panel below the
   * data cards. Each entry is `[sideName, summary]` (e.g. `['Center', '30.5 cm from
   * tail · base …']`). Pre-formatted by the caller in the active units.
   */
  finPlacement?: readonly (readonly [string, string])[];
}

const esc = (s: unknown): string =>
  String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c);

const STYLE = `
:root{
  --bg:#0A1424;--panel:#0F1C30;--ink:#E6EDF5;--muted:#8A9BB3;--accent:#22D3EE;
  --border:#1E3149;--grid:rgba(34,211,238,.05);
  --sans:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;
  --mono:ui-monospace,'SF Mono','JetBrains Mono','Cascadia Code',Menlo,Consolas,'Liberation Mono',monospace;
}
*{box-sizing:border-box}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;font-family:var(--sans);font-size:14px;line-height:1.5;color:var(--ink);
  background-color:var(--bg);
  background-image:linear-gradient(var(--grid) 1px,transparent 1px),linear-gradient(90deg,var(--grid) 1px,transparent 1px);
  background-size:30px 30px}
.wrap{max-width:940px;margin:0 auto;padding:40px 24px}
.sheet{border:1px solid var(--border);border-top:2px solid var(--accent);border-radius:14px;
  padding:30px 32px;background:rgba(15,28,48,.72);box-shadow:0 26px 70px -34px rgba(0,0,0,.75)}
header{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;
  padding-bottom:16px;border-bottom:1px solid var(--border)}
h1{margin:0;font:650 27px/1.05 var(--sans);letter-spacing:-.02em}
.sub{margin-top:4px;color:var(--muted);font-size:13px}
.meta{text-align:right;font:600 10.5px/1.95 var(--mono);letter-spacing:.14em;text-transform:uppercase}
.meta .brand{color:var(--accent)}
.meta .m{color:var(--muted)}
.headline{margin:16px 0 2px;font:600 22px var(--mono);letter-spacing:-.01em;color:var(--accent)}
.drawing{margin-top:18px;border:1px solid var(--border);border-radius:10px;overflow:hidden;background:rgba(10,20,36,.5)}
.bar{display:flex;justify-content:space-between;align-items:center;padding:7px 13px;
  border-bottom:1px solid var(--border);font:700 9.5px var(--mono);letter-spacing:.16em;
  text-transform:uppercase;color:var(--muted)}
.bar .a{color:var(--accent)}
.draw-body{padding:14px 16px}
.board-diagram{width:100%;height:auto;display:block}
.board-diagram .outline{fill:var(--accent);fill-opacity:.06;stroke:var(--accent);stroke-width:1.5}
.board-diagram .profile{fill:none;stroke:var(--accent);stroke-width:1.4}
.board-diagram .center{fill:none;stroke:var(--muted);stroke-width:.8;stroke-dasharray:7 5}
.board-diagram .tick{stroke:var(--muted);stroke-width:.8;stroke-dasharray:3 3}
.board-diagram .fin{fill:none;stroke:var(--accent);stroke-width:1;opacity:.65}
.board-diagram .dim{fill:var(--ink);font:600 10px var(--mono);letter-spacing:.02em}
.board-diagram .tag{fill:var(--accent);font:700 9.5px var(--mono);letter-spacing:.14em}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(195px,1fr));gap:14px;margin-top:22px}
.card{border:1px solid var(--border);border-radius:10px;padding:14px 16px;background:rgba(34,211,238,.02)}
.card h2{margin:0 0 9px;font:700 10px var(--mono);letter-spacing:.16em;text-transform:uppercase;color:var(--accent)}
.row{display:flex;justify-content:space-between;gap:14px;padding:4.5px 0;font-size:13px}
.row+.row{border-top:1px solid var(--border)}
.row .l{color:var(--muted)}
.row .v{font-family:var(--mono);font-size:12.5px;color:var(--ink)}
.info{display:flex;flex-wrap:wrap;gap:8px;margin-top:20px}
.chip{border:1px solid var(--border);border-radius:6px;padding:5px 11px;font-size:12px;color:var(--muted);background:rgba(34,211,238,.02)}
.chip b{margin-right:6px;color:var(--ink);font:600 11px var(--mono);letter-spacing:.04em;text-transform:uppercase}
.fins{margin-top:22px;border:1px solid var(--border);border-radius:10px;overflow:hidden;background:rgba(10,20,36,.5)}
.fins-body{padding:4px 16px}
.fins .row .v{white-space:normal;text-align:right}
footer{margin-top:24px;display:flex;justify-content:space-between;align-items:center;gap:16px;padding-top:14px;border-top:1px solid var(--border)}
.note{font:500 10.5px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
button{background:var(--accent);color:#061018;border:0;border-radius:8px;padding:9px 18px;font:600 13px var(--sans);cursor:pointer}
button:hover{filter:brightness(1.08)}
@media print{
  /* Fit the whole sheet on one page: clean ink palette + a compacted layout. */
  @page{margin:12mm}
  :root{--bg:#fff;--panel:#fff;--ink:#0b0b0b;--muted:#555;--accent:#111;--border:#c4c4c4;--grid:transparent}
  body{background:#fff}
  .wrap{padding:0;max-width:none}
  .sheet{background:#fff;border:1px solid #9a9a9a;border-top:2px solid #111;border-radius:0;box-shadow:none;padding:0 2px}
  header{padding-bottom:10px}
  h1{font-size:21px}
  .sub{margin-top:2px;font-size:11px}
  .meta{font-size:9px;line-height:1.7}
  .headline{font-size:17px;margin:9px 0 0}
  .headline,.drawing,.grid,.info,footer{color:#111}
  .drawing{background:#fff;margin-top:10px}
  .bar{padding:5px 10px;font-size:8.5px}
  .draw-body{padding:6px 10px}
  /* Cap the drawing so it never crowds out the data panels. */
  .board-diagram{width:auto;max-width:100%;max-height:300px;margin:0 auto}
  .info{margin-top:10px;gap:6px}
  .chip{padding:3px 8px;font-size:10px;background:#fff}
  /* Keep all four data panels on one row so none spills to page 2. */
  .grid{grid-template-columns:repeat(4,1fr);gap:8px;margin-top:10px}
  .card{background:#fff;padding:9px 10px}
  .card h2{margin-bottom:5px;font-size:9px}
  .row{padding:2.5px 0;font-size:10.5px}
  .row .v{font-size:10px}
  .drawing,.card,.grid,.fins{break-inside:avoid}
  .fins{background:#fff;margin-top:10px}
  .fins-body{padding:1px 10px}
  .board-diagram .outline{fill-opacity:0}
  .board-diagram .accent,.bar .a{color:#111}
  footer{margin-top:12px;padding-top:8px;border-top:1px solid #c4c4c4}
  button{display:none}
}
`.trim();

/** Build a self-contained, printable spec-sheet HTML document. */
export function specSheetHtml(doc: SpecSheetDoc): string {
  const heading = doc.title || 'Surfboard';
  const sub = doc.designer ? `by ${doc.designer}` : '';
  const meta = [
    '<span class="brand">OpenShaper</span>',
    '<span class="m">Spec Sheet</span>',
    doc.date ? `<span class="m">${esc(doc.date)}</span>` : '',
  ]
    .filter(Boolean)
    .join('<br>');
  const headline = doc.headline ? `<div class="headline">${esc(doc.headline)}</div>` : '';
  const drawing = doc.diagramSvg
    ? `<div class="drawing"><div class="bar"><span class="a">Plan · Rocker · Sections</span><span>Scale: NTS</span></div><div class="draw-body">${doc.diagramSvg}</div></div>`
    : '';
  const chips = doc.info
    .map(([k, v]) => `<span class="chip"><b>${esc(k)}</b>${esc(v)}</span>`)
    .join('');
  const cards = doc.sections
    .map((sec) => {
      const rows = sec.rows
        .map(
          ([k, v]) =>
            `<div class="row"><span class="l">${esc(k)}</span><span class="v">${esc(v)}</span></div>`,
        )
        .join('');
      return `<section class="card"><h2>${esc(sec.title)}</h2>${rows}</section>`;
    })
    .join('');
  const fins =
    doc.finPlacement && doc.finPlacement.length > 0
      ? `<div class="fins"><div class="bar"><span class="a">Fin placement</span></div><div class="fins-body">${doc.finPlacement
          .map(
            ([k, v]) =>
              `<div class="row"><span class="l">${esc(k)}</span><span class="v">${esc(v)}</span></div>`,
          )
          .join('')}</div></div>`
      : '';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(heading)} — Spec Sheet</title>
<style>${STYLE}</style></head>
<body><div class="wrap"><div class="sheet">
<header><div><h1>${esc(heading)}</h1><div class="sub">${esc(sub)}</div>${headline}</div>
<div class="meta">${meta}</div></header>
${drawing}${chips ? `<div class="info">${chips}</div>` : ''}
<div class="grid">${cards}</div>
${fins}
<footer><span class="note">OpenShaper · open-source surfboard CAD · openshaper.com</span><button onclick="print()">Print / Save as PDF</button></footer>
</div></div></body></html>`;
}
