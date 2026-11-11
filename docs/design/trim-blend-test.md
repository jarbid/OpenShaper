# Trim and blend: does it describe real boards?

Status: **study**, read-only on the engine. Prototype in `packages/board2/src/railproto/`
(`forward.ts`, `panel.ts` and three `*.measure.test.ts` files; nothing in the engine imports
them). It follows `docs/design/rail-laws-test.md` and reuses its boards, its dense set and
its yardstick. Frame as everywhere: cm, **tail at x = 0**, nose toward +x.

## Verdict

**The rail model passes. The first conversion built on it does not, and the reason is known.**

- **Rails.** A blend built forward from a band edge to the apex, allowed to leave its panel
  at an angle, describes **every one of 574 stations** on fourteen boards. Worst 0.26 mm,
  median 0.05 mm. The 23 stations the rail-law study left outside its model are all inside
  this one.
- **Conversion.** With the deck and bottom fitted as smooth height fields and the rails
  taken per station, **94.9%** of stations assemble to within 0.5 mm of the original, median
  0.15 mm. Twelve of fourteen boards have every station within 1 mm (worst 0.62 mm). Two do
  not: the 5.10 MLC (three stations, 1.72 mm) and the synthetic asymmetric board (eighteen
  stations, 2.35 mm). Every one of those misses is in the fitted bottom panel.

Two decisions taken after these numbers change what the misses mean; see
"What was decided afterwards".

## The model under test

One half of a section, stringer to apex, is a **panel** and then a **blend**.

- The panel is taken from the section, as in the rail-law study.
- The blend is a conic from a **band edge** on the panel to the apex, vertical at the apex.
  Its shoulder point sits on the outline wall, and how high is free. At the height where the
  panel's own direction meets the wall, the blend leaves tangent and there is no crease.
  Above that it leaves at an angle: an **edge**. At the apex itself it is a straight bevel.
- Where the band edge _is_ the apex there is no blend. The panel runs to the wall and the
  rail is a hard edge. That is a legal state.

The honesty rule of the rail-law study is kept: at the band edge the panel may have turned
at most 20 degrees, so the blend, with its edge, carries at least 70 of the 90.

## Stage 1: rails

Fourteen boards, 41 dense stations each, both halves. Two fits per half: leaving tangent
only, and with an edge allowed. An edge is only kept where it beats the tangent blend by
0.05 mm.

|                                      | Stations with no description | Worst       | Median      | Within 0.5 mm    |
| ------------------------------------ | ---------------------------- | ----------- | ----------- | ---------------- |
| Rail-law study, 70 degree convention | 23                           | 0.40 mm     | 0.04 mm     | 100% of the rest |
| Forward, tangent only                | 2                            | 0.32 mm     | 0.05 mm     | 100% of the rest |
| **Forward, edge allowed**            | **0**                        | **0.26 mm** | **0.05 mm** | **100%**         |

An edge was kept on 45 bottom halves and 9 deck halves, the deck ones all on the Diamond
Twin. Worst station per board with an edge allowed, in mm: MLC 0.26, 5.8 Trusther 0.12,
Master Trusther 0.12, Diamond Twin 0.24, Go fish 0.18, gremilin56 0.10, hyptocrypto 0.17,
long classico 0.11, shortboard 0.09, funboard 0.15, longboard 0.13, swallow 0.16, fish 0.11,
asymmetric 0.10.

### What the 23 missing stations were

| Board        | Stations             | What they are                                                                                                                                                     | Now                    |
| ------------ | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 5.8 Trusther | 18, x/L 0.11 to 0.32 | **Tucked-under edges.** At x/L 0.21 the bottom runs flat to a corner 2.5 mm inside the outline, and the rail leaves it at 33 degrees and climbs 11 mm to the apex | 0.12 mm worst          |
| Go fish      | 3, x/L 0.10 to 0.14  | Ordinary tucks. A tangent blend exists once the panel's direction is read properly                                                                                | 0.18 mm                |
| 5.10 MLC     | 2, x/L 0.05 to 0.07  | Hard edge at the apex: no tuck at all                                                                                                                             | Exact, by construction |

The rail-law study called these "outside the model". They were outside its _measurement_.
At a crease the sampled section doubles back on itself by about 0.1 mm, and a tangent read
there points nowhere, so no conic could be tangent to it. The study's finding was right
about its own method and wrong about the rail.

### Two things I got wrong on the way

- **I predicted the Trusther's hard edge sat at the apex**, with nothing to fit. It sits
  2.5 mm inboard with an 11 mm rail above it. I only saw it by printing the section.
- **My first forward fit made the same mistake as the study**: it read the panel's direction
  from the same kink and offered only a straight bevel, which missed by 2.45 mm. The fix is
  in `panelDirection` (read the direction off the panel side, over 2.5 mm of arc, wherever
  the local tangent disagrees with it) and `creaseIndex` (offer the sharpest corner as a
  band edge in its own right).

## Stage 2: the whole section

Each board's deck and bottom are fitted as tensor-product cubic B-spline height fields,
`nx` control points along the board by `ny` across, over the section inboard of the band edge
and that panel's own tangent carried on to the wall. The section is then assembled from the
fitted panel and stage 1's blend and measured against the original, both halves, stringer to
stringer.

| Band rule                         | 12 x 6 | 16 x 8    | 24 x 10   |
| --------------------------------- | ------ | --------- | --------- |
| Narrowest blend that fits best    | 49.7%  | 78.4%     | 93.0%     |
| Widest blend still within 0.2 mm  | 92.2%  | 94.3%     | 94.8%     |
| **Bottom widest, deck narrowest** | 90.9%  | **94.9%** | **96.5%** |

Share of 574 stations within 0.5 mm. Median for the last row at 16 x 8: 0.15 mm.

### What the band rule showed

**The bottom and the deck are different problems.** Between the 70 degree point and the 88
degree point, the bottom of a shortboard runs 5 mm and climbs 0.7 mm; on a longboard, 14 mm
and 2.4 mm. That is a shoulder, and no smooth panel follows it, so a narrow bottom band
leaves the fit 0.5 to 1 mm out however many control points it has. The deck does the
opposite: the same two points are 16 to 20 cm apart, because a deck turns across its whole
dome. So the bottom's band edge is a real place, where the bottom stops being flat, and the
deck's is a choice.

### A fault in the yardstick, found here

The rail-law study's `nearest` scans every eighth segment and then refines. It is pinned
against the exact scan only for curves sampled evenly by arc length. An assembled section is
coarse on the panel and fine on the rail, and on it the fast scan over-reads by up to ten
times: on the Trusther it reported 1.19 mm where the exact scan gives 0.13 mm. It can only
over-read, so the rail-law study's numbers, and stage 1's, stand as upper bounds. Stage 2
uses the exact scan (`exactDeviation` in `panel.ts`).

### What still misses

Boards with any station over 0.5 mm, bottom widest and deck narrowest, 16 x 8:

| Board                  | Stations over | Worst   |
| ---------------------- | ------------- | ------- |
| asymmetric (synthetic) | 18            | 2.35 mm |
| 6.11 Diamond Twin      | 5             | 0.53 mm |
| 5.10 MLC               | 3             | 1.72 mm |
| hyptocrypto            | 2             | 0.62 mm |
| funboard               | 1             | 0.51 mm |

All of it is the fitted bottom panel. On the asymmetric board the miss sits 4.6 cm inside
the rail, nowhere near the band edge, and does not shrink with more control points
(2.36 mm at 16 x 8, 2.17 mm at 24 x 10). **I did not find what the panel is failing to
follow there.**

### Laws

With the band width, edge and shape each smoothed to a 7- or 9-point law along the board
and the edge and shape refitted at the law's width, 87.1% and 88.9% of stations are within
0.5 mm. That is the pessimistic form of the question, a law fitted through per-station
values, and it was not pursued, because of the decision below.

## What was decided afterwards

Three decisions by the project owner, 2026-11-11, on seeing these results:

1. **Rails only.** A section is edited through its rail, not drawn free-form.
2. **1 mm, except the tips**, is the bar for a converted board. The tips differ on purpose:
   the new model rounds them.
3. **Deck and bottom are still drawn as curves at stations.**

The third removes stage 2's problem rather than solving it. If a station keeps its own deck
and bottom curves, converting an old board needs no fitted surface: each stored section is
split at the band edge, its two panel curves are kept exactly, and one rail is fitted to
what is left. At the stations the conversion error is then stage 1's, 0.26 mm at worst.
**That path is not measured here.** It is the first gate of
`docs/design/trim-blend-plan.md`.

## What I did not measure

- **The conversion that was chosen.** Panels kept as station curves, rails as keys at the
  stations, and the surface between stations interpolated from both.
- **Between stations.** The dense set is the current engine's own blend of 3 to 6 stored
  sections, so everything here is measured against that blend, not against independent data.
- **The tips, and the outline-normal frame.** Every fit is in a station plane. A blend
  carried round a nose or a pin is built in the sketch and never compared with a real board.
- **Three dimensions.** Deviation is per station, in the plane of the station.
- **Volume and area.**
- **The asymmetric board's bottom**, as said above.
- **A rail with fewer keys than stations.** How few keys describe a board's rails is not
  known.

## Reproducing it

```sh
export TRIM_STUDY=1 TRIM_OUT=/some/dir/outside/the/repo
pnpm --filter @openshaper/board2 exec vitest run src/railproto/forward.measure.test.ts   # stage 1, ~8 min
pnpm --filter @openshaper/board2 exec vitest run src/railproto/convert.measure.test.ts   # stage 2, ~3 min
TRIM_LAWS=1 pnpm --filter @openshaper/board2 exec vitest run src/railproto/convert.measure.test.ts   # + laws, ~1 h
```

The results are written to `TRIM_OUT` as `forward-fits.json`, `convert.txt` and
`convert-laws.txt`. The eight Shape3D boards are third-party and not in the repository; the
study skips them when `Sample board imports/carlos/` is absent.
