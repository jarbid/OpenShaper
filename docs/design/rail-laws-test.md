# Rail laws: can four numbers reproduce a real rail?

Status: **study**, read-only on the engine. Prototype in `packages/board2/src/railproto/`
(scratch; nothing in the engine imports it). Frame as everywhere: cm, **tail at x = 0**,
nose toward +x.

## Verdict

**A — build it, and build it smaller than proposed.** Over fourteen boards and the 64 stored
stations the model can describe at all, a conic pair with the tangent point fixed by
convention and **one shape number per blend** reproduces the rail to a **worst case of
0.23 mm** and a median of 0.02 mm — every station inside the project's 0.5 mm, with better
than half the tolerance to spare. On the dense set, 551 stations, the worst is 0.40 mm.

The free four-parameter fit does not beat that, because two of the four parameters are not
shape. The tangent points sit wherever the optimiser drops them (roughness 0.18 of their
range) and the answer barely moves when they do: tripling the blend's length changes the
worst station from 0.23 mm to 0.28 mm. The two ρ values *are* shape, and they are laws — ρ of
the tuck ramps smoothly from about 0.05 at the tail to about 0.5 by mid-board on every one of
the eight Shape3D boards, roughness 0.029. **Solved for directly, a law of five control
points per parameter leaves twelve of the fourteen boards with a worst station between 0.12
and 0.34 mm.**

Three qualifications, none fatal, all to be designed for rather than discovered later:

- **One board in fourteen will not take a law.** The Diamond Twin's best five-control-point
  law leaves a worst station of **0.65 mm — over the tolerance** — with every station
  blendable and no excuse available. It is also the board with the worst per-station fit
  (0.40 mm): its rail changes along its length faster than five control points follow. More
  control points, or a station, would be the remedy; this study did not test either.
- **4% of stations are outside the model, not badly fitted by it.** Where a section is thin
  and its apex sits near the bottom — a 24 mm-thick wedge whose bottom half is 2 mm tall — the
  panel tangent and the vertical apex tangent diverge and *no* conic is tangent to both. 23 of
  574 dense stations, 18 of them on one board. These need a fallback by convention, not a
  better fit.
- **The blend must stay a blend.** It reproduces the rail band — out to 80° of the 90° turn,
  about 30 mm of arc — and not the panel. Asked to carry 88° it reaches 1.77 mm. The panels
  are the other half of this architecture and this study does not touch them.

Both open questions came back clearly: **two conics, not one** (one conic is 33× the median
deviation and puts the widest point up to 7.7 mm off the apex), and **no fifth parameter**
(the better of the two candidates removes 0.01 mm on average and 0.07 mm at its best).

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

### The same four parameters against the dense set

The as-built section at 41 stations per board — 574 asked for, **551 fitted, max 0.40 mm,
median 0.04 mm, every one within 0.5 mm**. Freeing the tangent point buys the free fit a
larger blend than the stored stations chose (bottom 14–20 mm, deck 22–50 mm).

| board | n | no blend | max mm | RMS mm | ≤0.5 mm | ρ (bottom / deck) |
| --- | --- | --- | --- | --- | --- | --- |
| 5.10 × 19.8 MLC | 39 | 2 | 0.15 | 0.03 | 100% | 0.43 / 0.52 |
| 5.8 × 20 Trusther White Tiger | 23 | **18** | 0.10 | 0.02 | 100% | 0.33 / 0.51 |
| 6.0 × 22 Master Trusther 3 | 41 | – | 0.12 | 0.03 | 100% | 0.40 / 0.49 |
| 6.11 × 21.3 Diamond Twin | 41 | – | **0.40** | 0.11 | 100% | 0.29 / 0.51 |
| Go fish | 38 | 3 | 0.18 | 0.03 | 100% | 0.38 / 0.53 |
| gremilin56 | 41 | – | 0.11 | 0.02 | 100% | 0.39 / 0.52 |
| hyptocrypto | 41 | – | 0.17 | 0.03 | 100% | 0.46 / 0.52 |
| long classico 9'6" | 41 | – | 0.11 | 0.02 | 100% | 0.47 / 0.50 |
| shortboard | 41 | – | 0.09 | 0.02 | 100% | 0.49 / 0.52 |
| funboard | 41 | – | 0.15 | 0.02 | 100% | 0.50 / 0.50 |
| longboard | 41 | – | 0.13 | 0.02 | 100% | 0.55 / 0.50 |
| swallow | 41 | – | 0.16 | 0.06 | 100% | 0.56 / 0.53 |
| fish | 41 | – | 0.11 | 0.05 | 100% | 0.55 / 0.53 |
| asymmetric | 41 | – | 0.10 | 0.05 | 100% | 0.56 / 0.53 |

The 23 stations with no blend are the model's real gap, and they are not spread evenly: 18
of them are one board, the 5.8 Trusther, over x = 19 to 55 cm (x/L 0.11 to 0.32). They are
the same geometry as the stored station above — a thin section whose apex sits near the
bottom, so the bottom half is a couple of millimetres tall and the two end tangents diverge
across it. **4% of the dense set is outside the model, not badly fitted by it.**

### What the blend is allowed to carry: the pinned ladder

This is the table to read, because the tangent point has no freedom in it. The blend is
pinned at a fixed turn angle and ρ is the only parameter left.

| turn° the blend must carry | n | median mm | p90 mm | max mm | ≤0.5 mm | mean blend span mm |
| --- | --- | --- | --- | --- | --- | --- |
| 50 | 64 | 0.01 | 0.07 | 0.23 | 100% | 10.4 |
| 60 | 64 | 0.01 | 0.09 | 0.21 | 100% | 13.2 |
| **70** | 64 | **0.02** | **0.12** | **0.23** | **100%** | **17.7** |
| 80 | 64 | 0.09 | 0.24 | 0.28 | 100% | 30.2 |
| 85 | 64 | 0.20 | 0.47 | 1.17 | 94% | 54.0 |
| 88 | 64 | 0.46 | 1.11 | 1.77 | 53% | 87.5 |

Read it as the answer to "how much rail can a conic carry?". Out to 80° of the 90° turn —
a blend averaging **30 mm of arc**, which is the rail band as a shaper would describe it —
the worst station on fourteen boards is **0.28 mm**, with the tangent point fixed by
convention and ρ the only number fitted. The model does not begin to strain until 85°
(54 mm blends, 1.17 mm), and gives way at 88° (88 mm — by then the "blend" has eaten the
whole panel and is being asked to be a deck crown, which is not its job).

The practical reading: **the tangent point does not have to be fitted at all.** Pinning it
at 70° and fitting only ρ gives 0.23 mm worst over all 64 stored stations — the same number
the four-parameter free fit gets. That halves the model.

### Figures

Four plots of fitted against real sections. They are study output and are **not committed**;
they were written to the session scratchpad, and anyone re-running the study regenerates them
with `cases.measure.test.ts` and the drawing script. Each shows the whole half-section to
true aspect, the rail region enlarged, and the deviation along the blend — the deviation
panel spans exactly the blend, tangent point to tangent point, and nothing beyond it.

| file | station | what it shows |
| --- | --- | --- |
| `rail-fit-good.png` | shortboard, x/L = 0.49 | the ordinary case: **0.02 mm**, the residual a flat line across the whole blend |
| `rail-fit-worst.png` | gremilin56, x/L = 0.18 | the worst stored station: **0.23 mm**, a single smooth lobe on the bottom side — a shape mismatch, not noise |
| `rail-fit-tail.png` | Diamond Twin, x/L = 0.18 | where rails go hard: **0.23 mm**, the tuck at ρ = 0.240 and a turn of 88° |
| `rail-fit-one-conic.png` | Go fish, x/L = 0.17 | the conic pair at **0.20 mm** against a single conic at **2.84 mm**, visibly bowed off the rail |

All four were regenerated after the arc-length sampling fix, so the set is one vintage. The
header figure of each is the two-sided deviation the tables report; the panel's "worst here"
is the one-sided section-to-model trace that is plotted, which is the same number to a
hundredth of a millimetre except where the model bulges off the end of the data.

## Law smoothness

### Two of the four parameters are a law. Two are noise.

Plotted against position along the board, on the dense set, the four parameters do not
behave alike. Roughness below is the mean absolute second difference between neighbouring
stations over the parameter's own range: near 0 is a trend, near 1 means neighbours disagree
as much as the whole board does.

| parameter | median roughness | range across a board | reads as |
| --- | --- | --- | --- |
| ρ bottom (tuck) | **0.029** | 0.07 – 0.49 | a smooth monotone ramp |
| ρ deck (rail) | **0.043** | 0.04 – 0.26 | a smooth shallow curve |
| turn angle, bottom | 0.179 | up to the full 18° band | noise against the band's edges |
| turn angle, deck | 0.178 | 0.3° – 15.8° | noise |

The text plots make it plain. Each row is one parameter across 41 stations, tail on the
left, darker meaning larger:

```
gremilin56
  rhoB    0.050 .. 0.520  |.     .:-==+*%%%%%@@@@@@@@@@@@@@@@@@@@@@@|  rough 0.016
  rhoD    0.502 .. 0.562  |--*@+=-:::-----=======+----::...         |  rough 0.052
  turnB  70.000 .. 88.000 |@@@@@@    @@@ **++++==#                  |  rough 0.243
  turnD  70.000 .. 76.938 |+*@.                 .-           **  +  |  rough 0.209

Go_fish
  rhoB    0.050 .. 0.482  |     .:=*##%%@@@@@@@@@@@@@@@@@@@@@@@@@|  rough 0.018
  turnB  70.000 .. 88.000 |@@@@@#          ..:::::-==+++      ###|  rough 0.126
```

**ρ of the tuck is the rail's own story told in one number**: 0.05 at the tail, where the
rail is hard and the tuck is a flat ellipse, climbing smoothly to about 0.5 — a parabola —
by the middle of the board, and that same ramp appears on every one of the eight Shape3D
boards. It is exactly what a law is for. ρ of the deck blend is flatter and stays near 0.5.

The turn angles are noise, and the noise is **fitting slack, not shape**. Three things say
so, and they agree:

1. The per-station cost is nearly flat in the turn angle. The pinned ladder above is the
   proof: moving the tangent point from 50° to 80° of turn — tripling the blend — changes the
   worst station from 0.23 mm to 0.28 mm. A parameter the answer barely depends on is a
   parameter the optimiser can put anywhere, and it does: turnB sits against one edge of the
   allowed band or the other on nine of fourteen boards.
2. Replacing the noisy values with a smooth law costs almost nothing in millimetres (below).
3. Pinning the turn angle at a constant 70° — no law at all — gives the same 0.23 mm worst
   station as fitting it freely.

### What a law costs, in millimetres

Two ways of asking. A law fitted **through the per-station parameters** is a law fitted
through that noise, so it is the pessimistic answer; a law fitted **against the sections
themselves** is what an engine would actually solve for.

Through the per-station parameters, on the dense set:

| law | median mm | p90 mm | within 0.5 mm | extra over the free fit (median) |
| --- | --- | --- | --- | --- |
| per-station free fit | 0.04 | 0.11 | 100% | – |
| k = 3 (quadratic) | 0.16 | 0.41 | 95% | 0.10 |
| k = 4 (one cubic span) | 0.15 | 0.37 | 95% | 0.09 |
| k = 5 (two cubic spans) | 0.13 | 0.28 | 97% | 0.06 |

**A law of four or five degrees of freedom per parameter costs about a tenth of a
millimetre**, and three quarters of what is left is under 0.3 mm. That is the measurement
that settles the "noise or shape" question: if the per-station scatter were real shape,
smoothing it would have cost a great deal more than 0.1 mm.

Against the sections themselves, by coordinate descent on the law coefficients — the
question an engine would actually solve. This is the **worst station on each board**, not a
distribution over stations, so it is not comparable with the table above row for row; the
right comparison is board against board, and it wins every one.

| board | n | per-station free fit | k = 3 | k = 4 | k = 5 | law through parameters, k = 5 |
| --- | --- | --- | --- | --- | --- | --- |
| 5.10 × 19.8 MLC | 39 | 0.15 | 0.28 + 1 ✗ | 0.26 + 1 ✗ | 0.24 + 1 ✗ | no law found |
| 5.8 × 20 Trusther White Tiger | 23 | 0.10 | 0.20 + 1 ✗ | 0.10 + 1 ✗ | 0.10 + 1 ✗ | no law found |
| 6.0 × 22 Master Trusther 3 | 41 | 0.12 | 0.34 | 0.28 | **0.26** | 0.51 |
| 6.11 × 21.3 Diamond Twin | 41 | 0.40 | 0.89 | 1.12 | **0.65** | no law found |
| Go fish | 38 | 0.18 | 0.25 | 0.24 | **0.24** | 0.43 |
| gremilin56 | 41 | 0.11 | 0.29 | 0.29 | 0.34 | 0.39 |
| hyptocrypto | 41 | 0.17 | 0.31 | 0.30 | **0.30** | 0.60 |
| long classico 9'6" | 41 | 0.11 | 0.22 | 0.33 | **0.21** | 0.35 |
| shortboard | 41 | 0.09 | 0.23 | 0.32 | **0.20** | 0.27 |
| funboard | 41 | 0.15 | 0.41 | 0.35 | **0.31** | 0.89 |
| longboard | 41 | 0.13 | 0.33 | 0.28 | 0.32 | 0.37 |
| swallow | 41 | 0.16 | 0.16 | 0.16 | **0.12** | 0.20 |
| fish | 41 | 0.11 | 0.14 | 0.14 | **0.12** | 0.20 |
| asymmetric | 41 | 0.10 | 0.15 | 0.15 | **0.12** | 0.19 |

All in mm. "✗" is a station where the law's own values ask for a blend that does not exist;
the mm figure beside it is the worst of the rest. The search is coordinate descent from two
starts with two sweeps, so every number here is an **upper bound** on what the best law of
that order could do — the conservative direction.

**Of the fourteen boards, twelve have a k = 5 law whose worst station is between 0.12 and
0.34 mm**, against a per-station free fit of 0.09 to 0.18 mm. Solving for the law directly
rather than through the parameters roughly halves its cost — funboard 0.89 → 0.31,
hyptocrypto 0.60 → 0.30, Master Trusther 0.51 → 0.26 — and recovers three boards the
pessimistic fit could not fit a law to at all. That is the measure of how much of the
per-station scatter was slack: a law aimed at the sections sails through noise the
parameters were full of.

Two boards do not come clean, and both deserve naming rather than averaging away:

- **The Diamond Twin is the one genuine law failure: 0.65 mm at k = 5, over the 0.5 mm
  tolerance**, with every station blendable and no excuse available. It is also the board
  with the worst per-station fit (0.40 mm), so the law is not the whole story there; it is a
  board whose rail changes faster along its length than five control points can follow.
- **The 5.10 MLC and the 5.8 Trusther each keep one station no law value can blend.** These
  are the thin-wedge sections of the previous section, the ones outside the model altogether.
  The law is not at fault and a fallback would carry them.

On the stored stations alone, where the law has nearly as many degrees of freedom as there
are data points, the law is essentially free on half the boards and costs up to 1.08 mm on
`gremilin56` at k = 3 — which is the three-point-law artefact, not a result. It is recorded
for completeness and should not be read as the law's cost.

## The two open questions

### One blend or two?

**Two. It is not close, and the reason is structural, not a matter of a millimetre.**

A single conic from the bottom tangent point straight to the deck tangent point, tangent to
both panels, fitted over exactly the stretch of rail the two-conic model covers:

| | two conics, vertical at the apex | one conic |
| --- | --- | --- |
| median deviation | **0.02 mm** | 0.67 mm |
| worst station | **0.23 mm** | 2.84 mm |
| within 0.5 mm | **100%** | 34% |
| widest point misses the apex by | 0 (by construction) | 1.18 mm median, **7.73 mm** worst |

Thirty-three times the median deviation is the small part. The real objection is the last
row: a single conic has no vertical tangent in it, so its widest point is wherever the
curve puts it, and on these boards that is up to 7.7 mm from where the board's outline says
the widest point is. The outline is the one curve in a board a shaper measures with a tape.
A rail model that moves it is not a rail model.

The picture is `rail-fit-one-conic.png` (listed above): on Go fish at x/L = 0.17 the single conic
bows **2.84 mm** outboard of the rail while the conic pair sits on it to 0.20 mm.

### Does a fifth parameter earn its place?

**No, for either candidate. Neither pays, and one of them cannot.**

| fifth parameter | residual removed, median | mean | best station | stations improved by > 0.05 mm | stations wanting it at all |
| --- | --- | --- | --- | --- | --- |
| short vertical flat at the apex | 0.00 mm | 0.01 mm | 0.07 mm | 14% | 23% |
| apex tangent leaning off vertical | 0.00 mm | 0.00 mm | 0.05 mm | 2% | 11% |

Against a four-parameter residual whose worst station is 0.23 mm, a fifth parameter that
removes 0.01 mm on average and 0.07 mm at its best is not worth storing, fitting or
explaining.

The lean also has a reason it must lose, which the numbers only confirm. Tipping the apex
tangent off vertical moves the model's widest point off the apex — the same defect that
disqualifies the single conic, in miniature. The flat at least keeps the apex where it
belongs, which is why it is the better of the two candidates and still does not pay.

## Context

### Against the project's tolerances

| measure | mm |
| --- | --- |
| Project section tolerance | 0.50 |
| Engine against the classic loft, between stations (`m1-model.md`) | ≈ 1.0 |
| Section least-squares fit budget today (`SECTION_FIT_TOL`) | 0.50 |
| **This model, per station, stored data** | **0.23 worst, 0.02 median** |
| **This model, per station, dense set** | **0.40 worst, 0.04 median** |
| **This model with laws (k = 5), dense set** | **0.65 worst board, 0.25 median board** |

Per station the model costs about a twelfth of the tolerance and a fortieth of the gap the
engine already carries against the classic loft between stations. Even with the parameters
reduced to law curves, the typical board's worst station is **half the tolerance** and a
third of the engine's existing between-station error.

That is the honest size of the claim, and it is worth stating what it is not. The margin is
not a licence to spend: this is the rail region of a section measured against the section
the designer stored, with the panels given. It says nothing about what the panels cost, what
the laws do to volume, or what a surface swept from them does between stations. The engine's
≈ 1 mm against the classic loft is a *different* measurement — a whole surface against
another whole surface — and the two are not additive in any way this study established.

### Tail against middle

PLACEHOLDER_TAILTABLE

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
- **Laws of more than five control points.** The ladder stops at k = 5, so the one board that
  exceeds the tolerance under a law (the Diamond Twin, 0.65 mm) was never offered a richer
  one. Whether six or eight control points would bring it inside 0.5 mm, and what that would
  cost the other thirteen, is unmeasured — as is whether an extra station would do it instead.
- **How good the best law really is.** The law coefficients are found by coordinate descent
  from two starts with two sweeps, so every law number here is an upper bound on what that
  order of law could achieve. No attempt was made to find the true optimum.

## Recommendation

**Build it, as two laws and a convention, not four laws.**

The model to implement, per side of a station:

- the apex from the outline and the thickness, as now;
- the tangent points by **convention** — the point where the section's tangent is 70° from
  vertical, found by walking out from the apex — not stored, not fitted, not a law;
- **ρ_tuck(x)** and **ρ_rail(x)**, two law curves of four or five control points each, which
  are what the designer edits;
- the panels from whatever the bottom-contour and deck-crown model turns out to be — unknown,
  and the larger half of the work.

Rough size, rails only, with the panels taken as given:

| | |
| --- | --- |
| Kernel: conic blend evaluation, tangent-point finder, the two laws in the document | ~500 lines, with tests |
| Converting an existing board to laws (fit ρ per station, then the law) | ~250 lines; the prototype's fitter is most of it already |
| The thin-section fallback and its validator issue | ~150 lines |
| Editor: two law curves in the section pane, which the curve editor already draws | ~300 lines |
| Golden fixtures and divergence note (`docs/specs/divergences.md`) | a day |

Call it a fortnight for the rail half, on the assumption that the panel half is a separate
and larger piece. **Do not start it until the panel question is answered**: a rail law that
blends into a panel nobody has modelled is half a surface, and the 4% of sections the conic
pair cannot describe are exactly the ones where the panel has to take over.

Before building, three measurements this study did not make are worth a day each: whether a
surface swept from these laws is smooth **along** the board (everything here is per-station);
what the residual does to volume; and whether a richer law — six or eight control points, or
one more station — brings the Diamond Twin inside the tolerance. That last one decides
whether the law order is a fixed property of the format or something the document carries
per board, which is a format decision and therefore cheaper to settle before the first file
is written than after.
