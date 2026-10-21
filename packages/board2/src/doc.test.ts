// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Revive and canonical JSON (docs/design/board2.md §3.1, §13.1).
 *
 * The oracle for "revive rejects every malformed field with its code" is
 * exhaustive mutation of a known-good document: every leaf is replaced by a value
 * of the wrong type, every object key is removed, and an unknown key is added at
 * every object, and each must be refused with `doc-malformed` located at that
 * path (optional keys are the one exception: removing them must succeed). No
 * tolerance is involved; all checks are exact.
 */
import { checksum } from '@openshaper/geom/testing';
import { describe, expect, it } from 'vitest';
import { BOARD2_FORMAT, BOARD2_VERSION, boardDocToJson, reviveBoardDoc } from './doc';
import { sampleDoc } from './testing/sample-doc';
import type { Board2Issue } from './types';

type Seg = string | number;
type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const sampleJson = (): Json => JSON.parse(JSON.stringify(sampleDoc())) as Json;

function at(root: Json, segs: readonly Seg[]): Json {
  let v: Json = root;
  for (const s of segs) v = (v as Record<Seg, Json>)[s]!;
  return v;
}

function display(segs: readonly Seg[]): string {
  return segs.reduce<string>(
    (acc, s) => (typeof s === 'number' ? `${acc}[${s}]` : acc === '' ? s : `${acc}.${s}`),
    '',
  );
}

/** Every node of the document except the opaque fins subtree. */
function walk(
  v: Json,
  segs: Seg[] = [],
  out: { segs: Seg[]; value: Json }[] = [],
): { segs: Seg[]; value: Json }[] {
  if (segs[0] === 'passthrough' && segs[1] === 'fins') return out;
  out.push({ segs, value: v });
  if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...segs, i], out));
  else if (v !== null && typeof v === 'object') {
    for (const k of Object.keys(v)) walk(v[k]!, [...segs, k], out);
  }
  return out;
}

function mutate(edit: (root: Json) => void): ReturnType<typeof reviveBoardDoc> {
  const root = sampleJson();
  edit(root);
  return reviveBoardDoc(root);
}

const messages = (issues: readonly Board2Issue[]): string[] => issues.map((i) => i.message);
const OPTIONAL_KEYS = new Set(['author', 'comment', 'source', 'passthrough', 'in', 'out', 'fins']);

describe('reviveBoardDoc: the good path', () => {
  it('revives the sample to an equal, deeply frozen, independent copy', () => {
    const json = sampleJson();
    const before = checksum(json);
    const r = reviveBoardDoc(json);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.issues).toEqual([]);
    expect(r.value).toEqual(sampleDoc());
    expect(checksum(json)).toBe(before); // the input is not touched
    const frozen = (v: unknown): boolean =>
      typeof v !== 'object' ||
      v === null ||
      (Object.isFrozen(v) && Object.values(v).every((x) => frozen(x)));
    expect(frozen(r.value)).toBe(true);
    // Independent: later edits of the input do not reach the revived document.
    (json as { meta: { name: string } }).meta.name = 'changed';
    (json as { plan: { knots: number[] } }).plan.knots[1] = 99;
    expect(r.value.meta.name).toBe('Sample');
    expect(r.value.plan.knots[1]).toBe(0.125);
  });

  it('accepts a document without its optional fields, and `undefined` as absent', () => {
    const r = mutate((root) => {
      const o = root as Record<string, Json>;
      delete o.passthrough;
      const meta = o.meta as Record<string, Json>;
      delete meta.author;
      delete meta.source;
      (meta as Record<string, unknown>).comment = undefined;
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect('passthrough' in r.value).toBe(false);
  });

  it('the constants are the format tag and version of the types', () => {
    expect(BOARD2_FORMAT).toBe('openshaper.board2');
    expect(BOARD2_VERSION).toBe(1);
  });
});

describe('reviveBoardDoc: refuses every malformed field with its code and path', () => {
  const nodes = walk(sampleJson());
  const leaves = nodes.filter(
    (n) =>
      (n.value === null || typeof n.value !== 'object') &&
      // Format and version have their own codes and are tested below.
      !(n.segs.length === 1 && (n.segs[0] === 'format' || n.segs[0] === 'version')),
  );
  const objects = nodes.filter(
    (n) => n.value !== null && typeof n.value === 'object' && !Array.isArray(n.value),
  );

  it('enumerates a meaningful set (the test cannot pass vacuously)', () => {
    expect(leaves.length).toBeGreaterThan(150);
    expect(objects.length).toBeGreaterThan(20);
  });

  it('a wrong-type value at every leaf is doc-malformed at that path', () => {
    for (const { segs, value } of leaves) {
      const wrong: Json = typeof value === 'number' ? 'x' : typeof value === 'string' ? 7 : 'x';
      const r = mutate((root) => {
        const parent = at(root, segs.slice(0, -1)) as Record<Seg, Json>;
        parent[segs[segs.length - 1]!] = wrong;
      });
      const path = display(segs);
      expect(r.ok, path).toBe(false);
      expect(
        r.issues.some((i) => i.code === 'doc-malformed' && i.message.startsWith(`${path}:`)),
        `${path}: ${messages(r.issues).join(' | ')}`,
      ).toBe(true);
    }
  });

  it('removing any key fails with "is required" unless the key is optional', () => {
    for (const { segs, value } of objects) {
      for (const key of Object.keys(value as object)) {
        const r = mutate((root) => {
          delete (at(root, segs) as Record<string, Json>)[key];
        });
        const path = segs.length === 0 ? 'document' : display(segs);
        if (OPTIONAL_KEYS.has(key)) {
          expect(r.ok, `${path}.${key}`).toBe(true);
        } else if (segs.length === 0 && (key === 'format' || key === 'version')) {
          expect(r.ok).toBe(false);
        } else {
          expect(r.ok, `${path}.${key}`).toBe(false);
          expect(messages(r.issues), `${path}.${key}`).toContain(`${path}.${key}: is required`);
        }
      }
    }
  });

  it('an unknown key at any object is refused (a later version bumps `version`)', () => {
    for (const { segs } of objects) {
      const r = mutate((root) => {
        (at(root, segs) as Record<string, Json>).zzz = 1;
      });
      const path = segs.length === 0 ? 'document' : display(segs);
      expect(r.ok, path).toBe(false);
      expect(messages(r.issues), path).toContain(`${path}.zzz: is not a known field`);
    }
  });

  it('non-finite numbers are refused wherever a number is expected (NaN, ±Infinity)', () => {
    for (const bad of [Number.NaN, Infinity, -Infinity]) {
      for (const path of [
        ['plan', 'points', 3],
        ['deck', 'z', 0],
        ['laws', 'apexHeight', 'keys', 0, 'value'],
        ['build', 'minInset'],
        ['features', 0, 'depth', 'keys', 1, 'in', 'ds'],
      ] as Seg[][]) {
        const r = mutate((root) => {
          (at(root, path.slice(0, -1)) as Record<Seg, unknown>)[path[path.length - 1]!] = bad;
        });
        expect(r.ok, display(path)).toBe(false);
        expect(r.issues[0]!.code).toBe('doc-malformed');
      }
    }
  });

  it('non-object documents are malformed', () => {
    for (const bad of [null, undefined, 3, 'doc', [], [sampleJson()]]) {
      const r = reviveBoardDoc(bad);
      expect(r.ok).toBe(false);
      expect(r.issues[0]!.code).toBe('doc-malformed');
    }
  });

  it('objects with a foreign prototype (class instances) are refused', () => {
    class Meta {
      name = 'x';
    }
    const r = mutate((root) => {
      (root as Record<string, unknown>).meta = new Meta();
    });
    expect(r.ok).toBe(false);
    expect(messages(r.issues)).toContain('meta: must be an object');
  });

  it('reports all problems at once, not just the first', () => {
    const r = mutate((root) => {
      const o = root as Record<string, Json>;
      (o.meta as Record<string, Json>).name = 5;
      (o.deck as Record<string, Json>).z = [1, 2];
      o.symmetry = 'diagonal';
      delete (o.build as Record<string, Json>).minInset;
    });
    expect(r.ok).toBe(false);
    const msgs = messages(r.issues);
    expect(msgs.some((m) => m.startsWith('meta.name:'))).toBe(true);
    expect(msgs.some((m) => m.startsWith('deck.z:'))).toBe(true);
    expect(msgs.some((m) => m.startsWith('symmetry:'))).toBe(true);
    expect(msgs.some((m) => m.startsWith('build.minInset:'))).toBe(true);
  });
});

describe('reviveBoardDoc: format, version and tail codes', () => {
  it('a wrong or missing format tag is doc-malformed; a wrong version number is doc-version', () => {
    for (const format of ['openshaper.board', 'x', 3]) {
      const r = mutate((root) => void ((root as Record<string, Json>).format = format));
      expect(r.issues.map((i) => i.code)).toEqual(['doc-malformed']);
    }
    for (const version of [0, 2, 99, -1, 1.5]) {
      const r = mutate((root) => void ((root as Record<string, Json>).version = version));
      expect(r.ok).toBe(false);
      expect(
        r.issues.map((i) => i.code),
        String(version),
      ).toEqual(['doc-version']);
      expect(r.issues[0]!.value).toBe(version);
    }
    const r = mutate((root) => void ((root as Record<string, Json>).version = '1'));
    expect(r.issues.map((i) => i.code)).toEqual(['doc-malformed']);
  });

  it('an unknown tail kind is tail-not-standard (a valid document of a later phase), not malformed', () => {
    const r = mutate((root) => void ((root as Record<string, Json>).tail = { kind: 'notched' }));
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.code)).toEqual(['tail-not-standard']);
    const r2 = mutate((root) => void ((root as Record<string, Json>).tail = { kind: 5 }));
    expect(r2.issues[0]!.code).toBe('doc-malformed');
  });

  it('symmetry "none" revives (it is a valid value); validateBoard refuses it', () => {
    const r = mutate((root) => void ((root as Record<string, Json>).symmetry = 'none'));
    expect(r.ok).toBe(true);
  });
});

describe('reviveBoardDoc: spline bases are checked through geom', () => {
  const planOf = (root: Json): Record<string, Json> =>
    (root as Record<string, Json>).plan as Record<string, Json>;

  it('plan: degree must be 3; knots sorted and inside one period; one point per knot', () => {
    expect(mutate((r) => void (planOf(r).degree = 2)).issues[0]!.message).toMatch(
      /^plan\.degree: must be 3/,
    );
    const dec = mutate((r) => void (planOf(r).knots = [0, 0.3, 0.2, 0.4, 0.5, 0.6, 0.7, 0.8]));
    expect(dec.ok).toBe(false);
    expect(dec.issues[0]).toMatchObject({
      code: 'doc-malformed',
      cause: { code: 'knots-decreasing' },
    });
    const wide = mutate((r) => void (planOf(r).knots = [0, 0.2, 0.4, 0.6, 0.8, 1, 1.2, 1.4]));
    expect(wide.issues[0]!.cause?.code).toBe('knots-decreasing');
    const few = mutate((r) => {
      planOf(r).knots = [0, 0.5];
      planOf(r).points = [0, 0, 1, 1];
    });
    expect(few.issues[0]!.cause?.code).toBe('knot-count');
    const mismatch = mutate((r) => void (planOf(r).points = [0, 0, 1, 1]));
    expect(messages(mismatch.issues).some((m) => m.startsWith('plan.points:'))).toBe(true);
    const tooMany = mutate((r) => void (planOf(r).knots = [0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5]));
    expect(tooMany.issues[0]!.cause?.code).toBe('knot-multiplicity');
  });

  it("plan: the basis is judged under the document's own tolerances", () => {
    // Knots 1e-9 apart are accepted only with a smaller knotRel (geom: no knots closer than knotRel × period).
    const close = (root: Json): void => {
      planOf(root).knots = [0, 0.125, 0.125 + 1e-9, 0.375, 0.5, 0.625, 0.75, 0.875];
    };
    expect(mutate(close).ok).toBe(true);
    const strict = mutate((root) => {
      close(root);
      ((root as Record<string, Json>).build as Record<string, Json>).tolerances = { knotRel: 1e-6 };
    });
    expect(strict.ok).toBe(false);
    expect(strict.issues[0]!.cause?.code).toBe('knots-near-coincident');
  });

  it('an unusable build.tolerances is reported once, on build.tolerances', () => {
    const r = mutate((root) => {
      ((root as Record<string, Json>).build as Record<string, Json>).tolerances = { fit: -1 };
    });
    expect(r.ok).toBe(false);
    expect(r.issues.filter((i) => i.message.startsWith('build.tolerances')).length).toBe(1);
  });

  it('height fields: clamped knots on exactly [0, 1], sized net, increasing extents', () => {
    const deck = (root: Json): Record<string, Json> =>
      (root as Record<string, Json>).deck as Record<string, Json>;
    const cases: [string, (d: Record<string, Json>) => void, string][] = [
      [
        'unclamped knots',
        (d) => void (d.knotsU = [0, 0.1, 0.2, 0.3, 0.7, 0.8, 0.9, 1]),
        'deck.knotsU:',
      ],
      ['domain [0, 2]', (d) => void (d.knotsV = [0, 0, 0, 0, 2, 2, 2, 2]), 'deck.knotsV:'],
      ['too few control points', (d) => void (d.knotsU = [0, 0, 0, 1, 1, 1]), 'deck.knotsU:'],
      ['z length', (d) => void (d.z = (d.z as number[]).slice(1)), 'deck.z:'],
      ['reversed x', (d) => void (d.x = [5, -5]), 'deck.x:'],
      ['empty y', (d) => void (d.y = [3, 3]), 'deck.y:'],
      ['three-element x', (d) => void (d.x = [0, 1, 2]), 'deck.x:'],
      ['degree 0', (d) => void (d.degreeV = 0), 'deck.degreeV:'],
    ];
    for (const [name, edit, prefix] of cases) {
      const r = mutate((root) => edit(deck(root)));
      expect(r.ok, name).toBe(false);
      expect(
        messages(r.issues).some((m) => m.startsWith(prefix)),
        `${name}: ${messages(r.issues)}`,
      ).toBe(true);
    }
    // A bottom is checked the same way, under its own name.
    const r = mutate((root) => {
      ((root as Record<string, Json>).bottom as Record<string, Json>).z = [1];
    });
    expect(messages(r.issues).some((m) => m.startsWith('bottom.z:'))).toBe(true);
  });
});

describe('reviveBoardDoc: offsets, features, build and passthrough', () => {
  const off = (root: Json): Record<string, Json> =>
    (root as Record<string, Json>).offsets as Record<string, Json>;
  const feat = (root: Json): Record<string, Json> =>
    ((root as Record<string, Json>).features as Json[])[0] as Record<string, Json>;
  const bld = (root: Json): Record<string, Json> =>
    (root as Record<string, Json>).build as Record<string, Json>;

  it('offsets: the apex has no offset; rows are unique; value counts follow the row rule', () => {
    const apex = mutate(
      (r) => void ((off(r).rows as Json[])[0] = { row: 'apex', values: [0, 0, 0, 0] }),
    );
    expect(messages(apex.issues).some((m) => m.startsWith('offsets.rows[0].row:'))).toBe(true);
    const dup = mutate(
      (r) =>
        void (off(r).rows = [
          { row: 'deckEdge', values: [0, 0, 0, 0] },
          { row: 'deckEdge', values: [0, 0, 0, 0] },
        ]),
    );
    expect(messages(dup.issues)).toContain("offsets.rows[1].row: 'deckEdge' appears twice");
    // tuckHandle carries n and z: 4 functions need 8 values; the sample's 8 are right, 4 are not.
    const short = mutate((r) => void (off(r).rows = [{ row: 'tuckHandle', values: [0, 0, 0, 0] }]));
    expect(messages(short.issues).some((m) => m.includes('needs 4 × 2 = 8 values'))).toBe(true);
    const empty = mutate((r) => void (off(r).basis = null));
    expect(messages(empty.issues)).toContain('offsets.rows: must be empty when basis is null');
    const none = mutate((r) => {
      off(r).basis = null;
      off(r).rows = [];
    });
    expect(none.ok).toBe(true);
  });

  it('offsets: the basis goes through geom (periodic, period 1)', () => {
    const r = mutate((root) => void (off(root).basis = { degree: 3, knots: [0, 0.5, 0.4, 0.9] }));
    expect(r.issues.find((i) => i.cause !== undefined)?.cause?.code).toBe('knots-decreasing');
  });

  it('features: kind is one of the three; each kind has exactly its own fields', () => {
    const unknown = mutate((r) => void (feat(r).kind = 'ridge'));
    expect(messages(unknown.issues).some((m) => m.startsWith('features[0].kind:'))).toBe(true);
    const mixed = mutate((r) => void (feat(r).stringerRadius = 0.1));
    expect(messages(mixed.issues)).toContain('features[0].stringerRadius: is not a known field');
    const veeOk = mutate((r) => {
      const f = feat(r);
      f.kind = 'vee';
      delete f.layout;
      delete f.centre;
      delete f.width;
      f.stringerRadius = 0.1;
    });
    expect(veeOk.ok).toBe(true);
    const channelsOk = mutate((r) => {
      const f = feat(r);
      f.kind = 'channels';
      delete f.layout;
      delete f.centre;
      f.count = 4;
      f.width = 0.3;
      f.pitch = 1;
      f.railInset = 2;
    });
    expect(channelsOk.ok).toBe(true);
    const frac = mutate((r) => {
      const f = feat(r);
      f.kind = 'channels';
      delete f.layout;
      delete f.centre;
      f.count = 2.5;
      f.pitch = 1;
      f.railInset = 2;
    });
    expect(messages(frac.issues).some((m) => m.startsWith('features[0].count:'))).toBe(true);
  });

  it('build: tolerances and edgeFit take only known keys; every build field is required', () => {
    const t = mutate((r) => void (bld(r).tolerances = { fit: 1e-5, bogus: 1 }));
    expect(messages(t.issues)).toContain('build.tolerances.bogus: is not a known field');
    const e = mutate((r) => void (bld(r).edgeFit = { degree: 3, maxPasses: 4 }));
    expect(e.ok).toBe(true);
    const e2 = mutate((r) => void (bld(r).edgeFit = { nope: 3 }));
    expect(messages(e2.issues)).toContain('build.edgeFit.nope: is not a known field');
    const lt = mutate((r) => {
      delete (bld(r).lawTolerance as Record<string, Json>).edgeHardness;
    });
    expect(messages(lt.issues)).toContain('build.lawTolerance.edgeHardness: is required');
  });

  it('passthrough.fins is opaque JSON: any JSON is kept, non-JSON is refused', () => {
    const fins = (root: Json, v: unknown): void => {
      ((root as Record<string, Json>).passthrough as Record<string, unknown>).fins = v;
    };
    for (const ok of [null, 3, 'x', [1, [2, { a: null }]], { deep: { er: [true, false] } }]) {
      const r = mutate((root) => fins(root, ok));
      expect(r.ok, JSON.stringify(ok)).toBe(true);
      if (r.ok) expect(r.value.passthrough?.fins).toEqual(ok);
    }
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    for (const bad of [Number.NaN, Infinity, () => 1, new Date(0), cyc, 5n]) {
      const r = mutate((root) => fins(root, [bad]));
      expect(r.ok, String(bad)).toBe(false);
      expect(r.issues[0]!.message.startsWith('passthrough.fins[0]')).toBe(true);
    }
    const proto = mutate((root) => fins(root, JSON.parse('{"__proto__": {"x": 1}}')));
    expect(proto.ok).toBe(false);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    const extra = mutate((root) => {
      ((root as Record<string, Json>).passthrough as Record<string, Json>).other = 1;
    });
    expect(messages(extra.issues)).toContain('passthrough.other: is not a known field');
  });
});

describe('boardDocToJson: canonical text and round trip', () => {
  it('round trips: text → parse → revive → text is the same bytes', () => {
    const doc = sampleDoc();
    const text = boardDocToJson(doc);
    const r = reviveBoardDoc(JSON.parse(text));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual(doc);
    expect(boardDocToJson(r.value)).toBe(text);
    // The plain JSON.stringify round trip is lossless as well (decision 1).
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
  });

  it('the bytes do not depend on key insertion order (keys sorted at every level)', () => {
    const doc = sampleDoc();
    const shuffle = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(shuffle);
      if (v !== null && typeof v === 'object') {
        return Object.fromEntries(
          Object.entries(v)
            .reverse()
            .map(([k, x]) => [k, shuffle(x)]),
        );
      }
      return v;
    };
    expect(boardDocToJson(shuffle(doc) as typeof doc)).toBe(boardDocToJson(doc));
    const text = boardDocToJson(doc);
    expect(text.indexOf('"bottom"')).toBeLessThan(text.indexOf('"build"'));
    expect(text.indexOf('"build"')).toBeLessThan(text.indexOf('"deck"'));
    expect(text.startsWith('{"bottom"')).toBe(true);
  });

  it('indent is passed through and does not change the content', () => {
    const doc = sampleDoc();
    const pretty = boardDocToJson(doc, 2);
    expect(pretty).toContain('\n  "bottom"');
    expect(JSON.parse(pretty)).toEqual(JSON.parse(boardDocToJson(doc)));
  });

  it('serialising does not mutate the document', () => {
    const doc = sampleDoc();
    const before = checksum(doc);
    boardDocToJson(doc);
    expect(checksum(doc)).toBe(before);
  });

  it('numbers keep full precision through the text (shortest round-trip form)', () => {
    const base = sampleDoc();
    const doc = {
      ...base,
      plan: { ...base.plan, points: base.plan.points.map((p, i) => (i === 2 ? 0.1 + 0.2 : p)) },
      build: { ...base.build, maxFrameTurn: (5 * Math.PI) / 180 },
    };
    const r = reviveBoardDoc(JSON.parse(boardDocToJson(doc)));
    expect(r.ok && r.value.plan.points[2]).toBe(0.1 + 0.2);
    expect(r.ok && r.value.build.maxFrameTurn).toBe((5 * Math.PI) / 180);
  });
});
