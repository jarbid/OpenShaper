# Rail laws: can four numbers reproduce a real rail?

Status: **study**, read-only on the engine. Prototype in `packages/board2/src/railproto/`
(scratch; nothing in the engine imports it). Frame as everywhere: cm, **tail at x = 0**,
nose toward +x.

## Verdict

PLACEHOLDER_VERDICT

## The model under test

A section half, from the stringer out to the apex and back in to the deck centre, in the
section editor's own physical frame — `y` the distance from the stringer along the chord,
`z` the height above the rocker — is four pieces:

1. **Bottom panel**, stringer to a tangent point. Taken from the section itself; not fitted.
2. **Tuck blend**, a conic from that tangent point to the apex, tangent to the panel at one
   end and **vertical at the apex**.
3. **Rail blend**, a conic from the apex to a deck tangent point, vertical at the apex and
   tangent to the deck panel at the other end.
4. **Deck panel**, that tangent point in to the stringer. Taken from the section; not fitted.

Both blends are tangent to the vertical outline wall at the apex, so the section is G1
through it and the apex stays the widest point. The apex is read from the data, never
fitted. Free per station: the two tangent-point positions and a conic rho for each blend —
**four numbers**.

A conic here is a rational quadratic Bézier with shoulder control point P₁ (the meeting of
the two end tangents) and shape factor ρ = w / (1 + w): the curve passes through
(1 − ρ)·(P₀ + P₂)/2 + ρ·P₁, so ρ = ½ is a parabola, below it an ellipse, above a hyperbola.

## Method

### The boards

Fourteen boards, 65 stored stations: the eight Shape3D boards of
`Sample board imports/carlos/` (third-party and gitignored — the study skips them when the
folder is absent), the three golden `.brd` boards, and the package's swallow, fish and
asymmetric test boards. All are read through `@openshaper/io` and converted with
`convertClassic`, so what is measured is the section the designer drew.

Stations whose thickness is under 6 mm or whose half-width is under 25 mm are dropped: at
the tips a board is a lens, not a rail. That is 17 of 82.

### Two ground truths

**Stored stations** are the designers' own data and carry the fit-quality answer. There are
only 3 to 6 of them per board, which is why they cannot carry the law answer: a law with
five degrees of freedom fits five points exactly, so the question would be vacuous.

**The dense set** is the as-built section at 41 evenly spaced stations per board, read from
the surface with `probeSection`. It is what the law question needs. Its caveat, stated here
and again where it matters: between stations this is board2's own C2 blend of the stored
sections, not independent designer data, so it is **smoother than reality** and bounds law
smoothness from the optimistic side. It is a faithful continuation at the stations
themselves — the as-built section matches the stored one to 0.07–0.5 mm, and the apex lands
on the widest point to 0 mm.

### The tangent point needs a floor, or the measurement is worthless

The panels are taken from the section itself. So a blend free to shrink towards the apex is
fitted against less and less data: its error goes to zero while the panel quietly carries
the tuck. Any "fit" measured that way says nothing.

The study's answer is to give the tangent point a coordinate that says what the blend has to
do — the **turn angle**, the angle between the section's tangent there and the vertical apex
tangent, which runs 0 at the apex to 90° at either centre — and then to require a blend to
carry at least **70°** of that 90°. The free fit searches the turn angle in [70°, 88°]. The
pinned ladder removes the freedom altogether: the tangent point is fixed at a given turn
angle and ρ is the only parameter left. Both are reported, and the pinned ladder is the one
to read, because it cannot cheat.

### How deviation is measured

Each section half is sampled at 600 points; each fitted conic at 250, spaced evenly **by arc
length**. Deviation is two-sided: every section sample's distance to the model, and every
model sample's distance back to that stretch of section, so a conic that bulges off the end
of the data is caught too. Distances are point-to-segment, exact.

Two bugs in this yardstick were found and fixed during the study, both of which inflated the
numbers; `packages/board2/src/railproto/rail-geom.test.ts` now pins it, and is the one part
of the prototype that runs in the package suite.

- The nearest-point search marched from the previous sample's answer, which is the natural
  thing to do when two ordered arcs nearly coincide. It is wrong on a section with a hard
  rail edge: the distance along the curve has several local minima there and a hill climb
  stops at the first. On one dense station of the diamond twin it read **15.40 mm** where the
  true distance is **0.23 mm**.
- The conic was sampled evenly in its rational parameter. A conic's speed varies by about the
  square of its weight, so at ρ = 0.95 the chords differ hundreds-fold end to end and the
  distance to that polyline reads the chord's sagitta as deviation — a 0.2 mm sawtooth on a
  rail the model follows to a hundredth of that.

### Fitting

The two halves are independent given the apex, so the fit splits into two two-parameter
problems: a grid over the turn angle, each rung's ρ by golden section on the half's worst
deviation, then the best rung bisected.

Law curves are least squares with `k` degrees of freedom — k = 3 a quadratic, k = 4 one
cubic span, k = 5 a clamped cubic B-spline with five control points — against position along
the board normalised to [0, 1]. They are reported two ways: fitted **through the per-station
parameters**, and fitted **against the sections themselves** by coordinate descent on the law
coefficients. The second is the one that answers the question, for the reason the law
section gives.

## Result

### Four free parameters against the stored stations

The designers' own data. 64 of the 65 usable stations fit; the one exception is noted below.

| board | n | max mm | RMS mm | ≤0.5 mm | blend span mm (bottom / deck) | ρ (bottom / deck) |
| --- | --- | --- | --- | --- | --- | --- |
| 5.10 × 19.8 × 2.6 MLC | 4 | 0.04 | 0.01 | 100% | 10.6 / 28.5 | 0.45 / 0.51 |
| 5.8 × 20 × 2.6 Trusther White Tiger | 3 | 0.03 | 0.01 | 100% | 10.0 / 21.2 | 0.78 / 0.52 |
| 6.0 × 22 × 2.75 Master Trusther 3 | 5 | 0.11 | 0.02 | 100% | 11.8 / 29.4 | 0.53 / 0.50 |
| 6.11 × 21.3 × 2.8 Diamond Twin | 3 | 0.15 | 0.05 | 100% | 11.6 / 21.0 | 0.33 / 0.53 |
| Go fish | 6 | 0.20 | 0.04 | 100% | 15.1 / 31.6 | 0.53 / 0.54 |
| gremilin56 | 4 | 0.23 | 0.05 | 100% | 12.1 / 28.2 | 0.56 / 0.52 |
| hyptocrypto | 3 | 0.22 | 0.06 | 100% | 15.9 / 32.6 | 0.46 / 0.52 |
| long classico 9'6" | 5 | 0.08 | 0.02 | 100% | 12.3 / 19.8 | 0.49 / 0.50 |
| shortboard (golden) | 4 | 0.02 | 0.01 | 100% | 12.6 / 17.3 | 0.46 / 0.52 |
| funboard (golden) | 5 | 0.12 | 0.02 | 100% | 11.2 / 17.9 | 0.58 / 0.53 |
| longboard (golden) | 5 | 0.13 | 0.02 | 100% | 10.9 / 18.7 | 0.61 / 0.52 |
| swallow | 6 | 0.10 | 0.04 | 100% | 15.0 / 20.8 | 0.54 / 0.52 |
| fish | 6 | 0.11 | 0.04 | 100% | 14.5 / 19.8 | 0.54 / 0.52 |
| asymmetric | 5 | 0.10 | 0.04 | 100% | 13.0 / 18.5 | 0.55 / 0.53 |

**Overall, n = 64: median 0.02 mm, p90 0.11 mm, max 0.23 mm. Every station within 0.5 mm;
every station within a quarter of it.**

The worst stations are worth naming because they have one thing in common.

| board | x cm | x/L | max mm | half | turn° | ρ | span mm | W cm | T cm |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gremilin56 | 29.0 | 0.18 | 0.23 | bottom | 70.0 | 0.286 | 12.0 | 19.9 | 4.41 |
| hyptocrypto | 32.1 | 0.18 | 0.22 | bottom | 70.0 | 0.393 | 13.4 | 20.1 | 5.29 |
| Go fish | 29.3 | 0.17 | 0.20 | bottom | 70.0 | 0.340 | 13.6 | 20.4 | 5.53 |
| 6.11 Diamond Twin | 0.5 | 0.00 | 0.15 | deck | 70.0 | 0.510 | 11.5 | 3.5 | 2.09 |
| longboard | 1.0 | 0.00 | 0.13 | deck | 70.0 | 0.649 | 11.8 | 6.4 | 1.59 |
| funboard | 1.0 | 0.00 | 0.12 | deck | 70.0 | 0.697 | 8.9 | 3.9 | 1.37 |

Two families. The top three are the **bottom tuck at x/L ≈ 0.18**, a fifth of the way up
from the tail, where the rail is going hard and the tuck is both tight and low-ρ (0.29–0.39,
a flat ellipse). The rest are the **last station before the tip**, where the board is 14 to
21 mm thick and the "rail" is most of the section. Both are under a quarter of a millimetre.

Every one of these sits at turn = 70.0°, the floor. That is the fit telling us something,
and the pinned ladder below says what.

**The one station with no blend** is the 5.10 MLC at x = 8.4 cm (x/L = 0.05), and it fails on
the **bottom**. The board is 24 mm thick and 103 mm wide there, and the apex sits 2.2 mm off
the bottom — 9% of the thickness. The whole bottom half is 2 mm tall, so the tangent point at
70° of turn is 0.02 mm from the apex, and over that distance the near-horizontal panel tangent
and the vertical apex tangent **diverge** rather than meet: no conic is tangent to both. This
is not a shape the model fits badly; it is a shape the model does not describe. A law engine
would have to carry such a station by convention — fall back to the panel alone — not by
fitting.

## Law smoothness

PLACEHOLDER_LAWS

## The two open questions

PLACEHOLDER_OPEN

## Context

PLACEHOLDER_CONTEXT

## What I did not measure

- **Independent data between stations.** The dense set is board2's own blend of the stored
  sections. It answers "would a law track the surface we build today", not "would a law track
  what a shaper would have drawn there". A board exported from Shape3D at 40 stations, or a
  scanned blank, would settle that; none was to hand.
- **Asymmetric boards' minus side.** Only the plus side of every board is measured. The
  asymmetric test board has a minus side and it was not fitted.
- **The panels.** They are taken from the section and never checked. A real law engine would
  build them from a bottom-contour and a deck-crown law, and whether *those* are a few numbers
  is a separate question this study does not touch. It is the larger half of the architecture.
- **Continuity along the board.** Only each station's own section is measured. Whether a
  surface swept from these laws is G1/G2 **along** x, and whether it sheds the banding the
  current least-squares fit was built to avoid (`section-lsq.ts`), is unmeasured.
- **Volume, area and the mesh.** No derived quantity was compared. A 0.2 mm section residual
  concentrated on one side would move volume more than a residual that alternates.
- **Fitting cost in the editor.** The prototype's fit is about half a second per station,
  which is a grid search written for clarity. Nothing was done to find what it would cost
  properly implemented, and the editor's budget was not considered.
- **Hard-edged and beaked rails.** The sample has tucked and soft rails. A rail with a true
  crease — the thing `section-lsq.ts` carries as a triple control point — is not in the eight
  Shape3D boards, and a conic cannot hold a corner at all.
- **The tangent-point floor itself.** 70° is a judgement about where a panel stops being a
  panel, not a measurement. The pinned ladder shows what the choice costs, but no board's
  actual panel geometry was examined to confirm the number.

## Recommendation

PLACEHOLDER_REC
