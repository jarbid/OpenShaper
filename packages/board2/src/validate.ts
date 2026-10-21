// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `validateBoard`: the model invariants of a {@link BoardDoc} that do not need the
 * geometry (docs/design/board2.md §3.7, §3.8, §5.1, §5.2, §6.2), returning every
 * issue rather than the first.
 *
 * This is the structural and range part (step S1): the format tag and version,
 * symmetry and tail rules, the build parameters' ranges, the rail laws (keys,
 * tips, handles, symmetric domain, per-lane range certificate) and the bottom
 * features' parameters. The plan-loop invariants (standard-tail certificate,
 * radius, pairing) arrive with the plan geometry in step S2, and the checks that
 * need a built board (insets, rail height, profiles) with the band in S3.
 *
 * It is pure and total: it never throws on a typed document, including one that
 * has not been through `reviveBoardDoc` (non-finite numbers are reported, not
 * evaluated).
 */
import { BOARD2_FORMAT, BOARD2_VERSION } from './doc';
import { makeIssue } from './issues';
import { certifyLawRange, checkLawKeys } from './law';
import { laneRange, RAIL_LANES, validateBuildParams } from './params';
import type { Board2Issue, BoardDoc, BottomFeature, KeyedCurve } from './types';

const finite = (x: number): boolean => Number.isFinite(x);

function featureIssue(f: BottomFeature, message: string, value?: number): Board2Issue {
  return makeIssue('feature-invalid', `feature '${f.id}': ${message}`, {
    at: { feature: f.id },
    ...(value === undefined ? {} : { value }),
  });
}

function checkFeature(f: BottomFeature, out: Board2Issue[]): void {
  const curve: KeyedCurve = f.depth;
  // The depth keys are over x in cm; reuse the key checks and re-code them.
  for (const i of checkLawKeys(curve)) {
    out.push(
      makeIssue('feature-invalid', `feature '${f.id}': depth: ${i.message}`, {
        at: { feature: f.id, ...(i.at?.key === undefined ? {} : { key: i.at.key }) },
        ...(i.value === undefined ? {} : { value: i.value }),
      }),
    );
  }
  const frac = (name: string, x: number, lo: number, hi: number, loOpen: boolean): void => {
    if (!(finite(x) && (loOpen ? x > lo : x >= lo) && x <= hi)) {
      out.push(
        featureIssue(f, `${name} must be in ${loOpen ? '(' : '['}${lo}, ${hi}]; got ${x}`, x),
      );
    }
  };
  switch (f.kind) {
    case 'vee':
      // A blend half-width as a fraction of the tuck half-width h_t (§6.2).
      frac('stringerRadius', f.stringerRadius, 0, 1, true);
      break;
    case 'concave':
      frac('width', f.width, 0, 1, true);
      if (f.layout === 'single') {
        if (f.centre !== 0)
          out.push(
            featureIssue(
              f,
              `a single concave is centred; centre must be 0, got ${f.centre}`,
              f.centre,
            ),
          );
      } else {
        // Two bumps at ±centre: separate from each other and inside the tuck (η = ±1).
        frac('centre', f.centre, 0, 1, true);
        if (
          finite(f.centre) &&
          finite(f.width) &&
          !(f.centre >= f.width && f.centre + f.width <= 1)
        ) {
          out.push(
            featureIssue(
              f,
              `a double concave's bumps must not overlap (centre >= width) or reach the tuck (centre + width <= 1); centre ${f.centre}, width ${f.width}`,
            ),
          );
        }
      }
      break;
    case 'channels':
      if (!(Number.isInteger(f.count) && f.count >= 1)) {
        out.push(featureIssue(f, `count must be an integer >= 1; got ${f.count}`, f.count));
      }
      for (const name of ['width', 'pitch'] as const) {
        if (!(finite(f[name]) && f[name] > 0))
          out.push(featureIssue(f, `${name} must be > 0; got ${f[name]}`, f[name]));
      }
      if (!(finite(f.railInset) && f.railInset >= 0)) {
        out.push(featureIssue(f, `railInset must be >= 0; got ${f.railInset}`, f.railInset));
      }
      // Channels of width w at pitch p must not run into each other.
      if (finite(f.width) && finite(f.pitch) && f.pitch < f.width) {
        out.push(
          featureIssue(
            f,
            `pitch (${f.pitch}) must be at least the channel width (${f.width})`,
            f.pitch,
          ),
        );
      }
      break;
  }
}

/** The model invariants that need no geometry. Empty for a valid document. */
export function validateBoard(doc: BoardDoc): readonly Board2Issue[] {
  const out: Board2Issue[] = [];
  if (doc.format !== BOARD2_FORMAT) {
    out.push(
      makeIssue('doc-malformed', `format must be '${BOARD2_FORMAT}'; got '${String(doc.format)}'`),
    );
  }
  if (doc.version !== BOARD2_VERSION) {
    out.push(
      makeIssue('doc-version', `unsupported version ${String(doc.version)}`, {
        value: Number(doc.version),
      }),
    );
  }
  // §3.7: 'none' is Phase 6; no half-tested path ships.
  if (doc.symmetry !== 'mirror-y') {
    out.push(
      makeIssue(
        'asymmetric-unsupported',
        `symmetry '${String(doc.symmetry)}' is not supported yet; use 'mirror-y'`,
      ),
    );
  }
  if (doc.tail.kind !== 'standard') {
    out.push(
      makeIssue(
        'tail-not-standard',
        `tail.kind '${String(doc.tail.kind)}' is not supported yet; use 'standard'`,
      ),
    );
  }
  out.push(...validateBuildParams(doc.build));

  for (const lane of RAIL_LANES) {
    const law = doc.laws[lane];
    const ctx = { lane };
    if (doc.symmetry === 'mirror-y' && law.domain !== 'half') {
      out.push(
        makeIssue(
          'symmetry-broken',
          `lane '${lane}': a symmetric board needs a half-domain law; this one is '${law.domain}'`,
          {
            at: { lane },
          },
        ),
      );
    }
    const keyIssues = checkLawKeys(law, ctx, doc.build.tolerances);
    out.push(...keyIssues);
    // The range certificate needs usable keys, and a lane range that is itself valid.
    if (keyIssues.length === 0) {
      const [lo, hi] = laneRange(lane, doc.build);
      if (finite(lo) && lo <= hi) out.push(...certifyLawRange(law, lo, hi, ctx));
    }
  }

  const ids = new Set<string>();
  for (const f of doc.features) {
    if (ids.has(f.id)) out.push(featureIssue(f, 'id is used by more than one feature'));
    ids.add(f.id);
    checkFeature(f, out);
  }
  return out;
}
