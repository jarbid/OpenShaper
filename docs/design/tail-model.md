# Tail model: how the NURBS engine should hold concave tails

Status: **study**, read-only on the engine. Prototype in `packages/board2/src/tailproto/`
(scratch; nothing in the engine imports it). Frame as everywhere: cm, **tail at x = 0**,
nose toward +x.

## Recommendation

**Keep today's model: the chord frame with a notch zone (option C, in its weakest form —
change nothing now).** The problem the brief sets out to fix is not in the tail model.
Refining the STEP fit from **56 × 48 to 88 × 74** control points on the swallow moves the
worst stringer fold from **0.063° to 0.065°**, and tripling or halving the zone length
moves it the wrong way (0.063° → 0.243° at zone 32 cm); the fold is a structural residual
of the STEP fitter's stringer-lean constraint where the fan chords carry a large x
component, not a crease the model puts there. The two candidates that would change the
model both lose: option B (outline-driven, perpendicular sections) moves a converted
shortboard **93 mm** from the classic loft where today it is 0.74 mm, produces **crossing
chords on all three goldens**, and needs **4.4×** the live-mesh vertices (34 → 131 ms,
over the 50 ms p95 drag budget on its own); option D (the same chord rule with a
C-infinity transition instead of the zone's C2 quintic) makes the swallow's fold **3.5×
worse** (0.063° → 0.222°).

Two things do follow from the measurements, neither a tail-model change:

1. **`m3-exports.md`'s fold table needs re-baselining.** The same measure, on the same
   commit that recorded it (`board2` and `geom` are untouched since `f4402b0`), gives
   0.063° for the swallow and 0.036° for the fish, not 0.104° and 0.146°. The fish is
   already inside the 0.05° target; the swallow is 0.013° over it. I did not find the
   cause of the discrepancy (see "What I did not measure").
2. **The bat tail is the case today's model actually loses on**, and option D wins it.
   A 5 cm-deep notch with two wings validates only with a 30 cm zone (shorter zones are
   refused by `notch-chord-angle`, because the fan chords run along the wing's concave
   corner), and its STEP fold is **0.721°** — 11× the swallow's. The same board on option
   D's map is **0.166°**. Before M4 ships a bat tail, pick the zone against the fold as
   well as against the chord angle, or use option D's map for notched tails whose fan is
   long relative to the notch depth. Small; sized below.

## What the options are

|       | Rule                                                                                                                                               | Status                                                                         |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **A** | Shape3D's way: a plain square-tail outline and a subtractive 3D cut layer                                                                          | Rejected, on the brief's own grounds plus measurement of what we would give up |
| **B** | One rule everywhere: the section runs from the outline to the spine, perpendicular to the outline in plan                                          | Rejected: crossing chords, 93 mm migration, 4.4× mesh                          |
| **C** | Keep the zone; improve the map inside it                                                                                                           | **Recommended** (no change now; one small follow-up for the bat tail)          |
| **D** | New here: keep the chord-to-stringer rule but make the ξ → outline-parameter map breakpoint-free (C-infinity), so there is no zone boundary at all | Rejected for the swallow and fish; **wins the bat tail**                       |

Option D exists because the brief's diagnosis — "the fold is exactly where the notch zone
ends" — pointed at the join, not at the fan. Today's map is C2 at `d + zone`, so its third
derivative jumps and the fan's turning stops abruptly there. D replaces the quintic with
`s(ξ) = s_x(ξ) − s_x(d)·Φ((ξ − d)/λ)`, where `Φ` is the C-infinity ramp
`(1 + bτ)·e^(1 − 1/(1 − τ))`: 1 at τ = 0, and flat **to every order** at τ = 1, where it
and all its derivatives are exactly 0. `b` sets the start slope, taken from the same
wall-angle rule `frame.ts` uses, so the first chords leave the notch bottom at twice the
validator's minimum angle. A standard board gets no map at all, so its surface is bit
identical to today's (measured: `surfaceMove` exactly 0 on all four standard boards). It
is the cleanest possible version of the brief's hypothesis, and it is the hypothesis that
the measurement refutes.

## How the prototype is wired

`makeFrame(chain, tail, mapOf?)` and `buildBoard(doc, { chordMap })` take an optional
chord-map factory; `outlineParam`, `frameAt` and `xiOfParam` consult it when a frame
carries one. That is the whole seam — seven lines in `frame.ts`, three in `surface.ts`,
both additive with the default path unchanged (the package's 358 tests pass untouched).
Everything downstream — the evaluator, the live mesh, the STEP fit, the validator's
`notch-chord-angle` sampling, `probe.ts` — then runs on the alternative map with no further
change, which is why real STEP numbers were affordable.

The study runs are `*.measure.test.ts` under `tailproto/`, kept out of the package's suite
by `TAIL_STUDY`:

```sh
TAIL_STUDY=1 pnpm --filter @openshaper/board2 exec vitest run src/tailproto --silent=false
```

Numbers below are Node in a 4-core container, one run each unless a median is given. Folds
are degrees of **excess over the evaluator's own fold** along the two stringer rows, worst
over s from 3 % to 97 %, measured by `step.test.ts`'s own measure lifted into
`tailproto/fold.ts`.

## Measurements

### 1. Fold, accuracy, STEP: today vs option D

| Board                                    | Fold, today (bottom / deck)   | Fold, D            | Dev, today | Dev, D  | Controls s × t    | Passes | Size         | Export        |
| ---------------------------------------- | ----------------------------- | ------------------ | ---------- | ------- | ----------------- | ------ | ------------ | ------------- |
| swallow                                  | **0.063 / 0.063** @ s = 0.212 | 0.222 / 0.222      | 0.30 mm    | 0.29 mm | 56 × 48 → 59 × 54 | 8 → 7  | 462 → 549 KB | 1.02 → 1.08 s |
| fish                                     | **0.036 / 0.036** @ s = 0.199 | 0.212 / 0.212      | 0.36 mm    | 0.35 mm | 63 × 55 → 59 × 44 | 7 → 7  | 598 → 446 KB | 1.06 → 0.71 s |
| asymmetric swallow (Δv 0.06)             | **0.063 / 0.063**             | 0.222 / 0.222      | 0.31 mm    | 0.31 mm | 58 × 48 → 61 × 55 | 8 → 7  | 479 → 578 KB | 1.74 → 2.00 s |
| shortboard (control)                     | 0.001 / 0.000                 | identical (no map) | 0.25 mm    | 0.25 mm | 42 × 33           | 5      | 246 KB       | 0.26 s        |
| **bat tail** (notch 5 cm + 2 wings)      | **0.721**                     | **0.166**          | 0.31 mm    | 0.37 mm | —                 | —      | —            | —             |
| winger (squash tail + 2 wings, no notch) | **0.000**                     | —                  | 0.40 mm    | —       | —                 | —      | —            | —             |

`checkBrep` ok on every row; ends unchanged (`edge/edge` for the notched boards,
`edge/cap` for the shortboard, `cap/edge` for the winger). Every deviation is inside the
project's 0.5 mm, on both maps. The faces stay **untrimmed**: two B-spline faces plus caps,
no intersection edges, no tolerance growth. `pnpm --filter @openshaper/board2 test:occt`
passes (4 tests, 32 s) on the current model.

Option D is 3.5× worse on the swallow and 5.9× worse on the fish, and the reason is visible
in the construction: `Φ` falls to 0.37 by τ = 0.5 and to 1.2e-4 by τ = 0.9, so the
C-infinity ramp **concentrates** the fan's turning into the first half of the transition. A
smoother join bought a sharper turn, and the fit minds the turn more than the join.

### 2. The fold is not a resolution problem

Today's map, today's documents, the STEP fit's tolerance tightened:

| Board   | Tolerance      | Deviation reached | Fold         | Controls          | Export        |
| ------- | -------------- | ----------------- | ------------ | ----------------- | ------------- |
| swallow | 0.50 mm        | 0.303 mm          | **0.063**    | 56 × 48           | 0.99 s        |
| swallow | 0.35 mm        | 0.276 mm          | 0.069        | 68 × 54           | 1.20 s        |
| swallow | 0.25 mm        | 0.157 mm          | 0.069        | 74 × 62           | 2.04 s        |
| swallow | 0.15 mm        | 0.098 mm          | 0.065        | 88 × 74           | 3.25 s        |
| fish    | 0.50 mm        | 0.355 mm          | **0.036**    | 63 × 55           | 1.03 s        |
| fish    | 0.35 → 0.15 mm | 0.117 → 0.120 mm  | 0.036 (flat) | 69 × 69 → 89 × 90 | 1.98 → 4.32 s |

Three times the control points, three times the export time, no change in the fold. It is a
residual of a constraint, not an approximation error. Nor is it an artefact of the measure:
taking the evaluator's own cross direction as the **exact** ∂S/∂t instead of
`step.test.ts`'s 1e-6 step in t gives the same excess to three decimals on every board.

### 3. The fold against the zone length (option C's dial)

| Board   | Zone, cm       | Fold      | Dev     | Controls | Passes | Size   | Live-mesh vertices |
| ------- | -------------- | --------- | ------- | -------- | ------ | ------ | ------------------ |
| swallow | **24 (today)** | **0.063** | 0.30 mm | 56 × 48  | 8      | 462 KB | 12,528             |
| swallow | 32             | 0.243     | 0.30 mm | 49 × 42  | 5      | 352 KB | 13,680             |
| swallow | 44             | 0.157     | 0.22 mm | 60 × 51  | 7      | 527 KB | 14,760             |
| swallow | 60             | 0.126     | 0.33 mm | 63 × 58  | 7      | 630 KB | 17,538             |
| swallow | 80             | 0.162     | 0.27 mm | 53 × 40  | 6      | 363 KB | 19,388             |
| fish    | **18 (today)** | **0.036** | 0.36 mm | 63 × 55  | 7      | 598 KB | 11,130             |
| fish    | 26             | 0.308     | 0.39 mm | 47 × 40  | 4      | 321 KB | 11,270             |
| fish    | 36             | 0.171     | 0.30 mm | 53 × 39  | 5      | 354 KB | 12,530             |
| fish    | 50             | 0.086     | 0.38 mm | 57 × 45  | 6      | 441 KB | 13,720             |
| fish    | 70             | 0.068     | 0.36 mm | 53 × 40  | 6      | 363 KB | 15,890             |

Today's zone is the best rung on both boards, and the relation is not monotone — the fold
tracks where the fit's knots happen to land relative to the fan, not the fan's length.
Lengthening the zone also costs vertices monotonically (+55 % on the swallow at zone 80),
because the fan is spread over more rows.

### 4. Option B's live-mesh and build cost, and option D's

Build + mesh of a whole move, median / p95 of 7, fresh build each time (noisy container,
± 30 %):

| Board              | Vertices, today → D | Build + mesh, today → D      |
| ------------------ | ------------------- | ---------------------------- |
| swallow            | 12,528 → 13,032     | 25.4 / 53.8 → 16.3 / 20.5 ms |
| fish               | 11,130 → 11,060     | 18.4 / 22.8 → 19.7 / 22.7 ms |
| classic swallow    | 12,172 → 12,512     | 14.3 / 15.4 → 23.0 / 24.8 ms |
| classic fish       | 10,880 → 11,016     | 14.3 / 18.9 → 13.1 / 13.4 ms |
| asymmetric swallow | 13,300 → 13,756     | 42.2 / 52.9 → 45.2 / 52.9 ms |

Option D is a wash on cost (±4 % vertices, inside the container's noise on time), and the
station fits are unchanged (worst fit error 0.0095–0.0336 cm either way, worst fitted-tangent
error 0.22–3.13° either way). Its minimum chord angle stays above the validator's 20°:
23.8 → 23.3 (swallow), 23.5 → 26.0 (fish), 20.5 → 21.0 (classic swallow), 20.4 → 20.9
(classic fish). **Option D is affordable; it just does not help.**

Option B is not affordable:

| Board             | Vertices          | Mesh time         | Distance from the classic loft, max (mean) |
| ----------------- | ----------------- | ----------------- | ------------------------------------------ |
| shortboard, today | 8,160             | 34 ms             | **0.74 (0.54) mm**                         |
| shortboard, B     | **36,252** (4.4×) | **131 ms** (3.9×) | **93.00 (33.70) mm**                       |
| funboard, today   | 9,042             | 13 ms             | 0.70 (0.56) mm                             |
| funboard, B       | 13,530 (1.5×)     | 27 ms             | 1.31 (0.68) mm                             |
| longboard, today  | 10,360            | 11 ms             | 1.06 (0.65) mm                             |
| longboard, B      | 13,464 (1.3×)     | 25 ms             | 1.10 (0.77) mm                             |

(Plane sections every 10 cm against `loftRing`, the project's own measure — the
`m1-model.md` §13 figures are 1.02 / 0.70 / 1.07 mm, which this run reproduces as 0.74 /
0.70 / 1.06 mm on a 10 cm instead of a 4 cm sampling.)

### 5. Why option B fails, concretely

The perpendicular foot on the stringer is `foot(s) = x(s) + y(s)·y_s/x_s`. Measured over
each golden's outline, `d(foot)/ds` goes **negative on all three** — the chords cross:

| Board      | min d(foot)/ds | where                                                                   |
| ---------- | -------------- | ----------------------------------------------------------------------- |
| shortboard | −5.9e15        | x = 188 cm (the 1 cm nose transom: the outline is vertical, so x_s → 0) |
| funboard   | −4.43          | x = 0 (the tail)                                                        |
| longboard  | −1568          | x = 0 (the tail)                                                        |

Wherever the outline turns vertical — every pointed or round tip, every blunt transom,
every pinned tail — `x_s → 0` and the perpendicular foot runs off to infinity. The
shortboard's 93 mm is that singularity landing inside the board. Taming it needs a clamp or
a soft-min with a width parameter, which is a notch zone under another name, and the mesh
cost (1.3–4.4×) survives the taming because the rows are no longer planes and the row
ladder has to resolve the tilt.

The second failure is structural, and it is the one that matters most: **on a notched tail
the rule cannot reach the inner wall at all.** At a point on a pod's inner wall the board's
material lies toward the outer rail, so the inward perpendicular points at the outer rail,
never at the stringer. The u = 1 line has to traverse the inner wall, the tip and the rear
outer rail while the u = 0 end is parked at the notch bottom — which is exactly today's
fan. On the classic swallow the perpendicular foot first reaches the stringer at outline
x = 6.6 cm (y = 13.0 cm) against a notch bottom at x = 11.2 cm, so a fan is still needed
over the whole inner wall plus the first 6.6 cm of rail, plus a smoothed handover where the
two rules meet. Option B's "one rule everywhere" does not survive contact with a notch: it
becomes today's model plus a worse frame for the other 98 % of the corpus.

### 6. Option A: the subtractive cut

The brief's prior is right, and the measurements above size what we would be trading. Today
each board is **two untrimmed B-spline faces plus caps**, `checkBrep` ok, OCCT reading it as
one clean solid with no tolerance growth, 246–598 KB. A boolean replaces the notch's two
inner walls and its tip edge with numerically computed intersection curves held by
tolerances, in a format where the importer's own tolerance then governs whether the solid
closes; and the live grid mesh (8–13 k vertices, 11–34 ms, straight from the evaluator, no
trimming) would need the trim loop evaluated per frame. Against that, the cut buys nothing
the chord frame does not already give: the notch's inner wall is already a real rail with a
real tuck, and the fan already spans it. Rejected, with no measurement spent beyond
confirming the untrimmed baseline.

The one genuinely interesting idea in the Shape3D files is the other one — explicit guide
curves running the length of the board. That is orthogonal to this note: it is a statement
about what the _sections_ are registered to, and `section-lsq.ts` already registers every
station's rail to the same `t` (`SECTION_LANDMARK_BOTTOM` / `_DECK`), which is a guide curve
by construction rather than by authoring. Making it an authored curve is an M4-size feature,
not a tail model.

### 7. Editing

**Does every station edit in one frame?** Today, all but one per board. The chord tilt from
the x-plane at each station:

| Board      | Notch zone   | Station x : tilt, degrees (`*` = inside the fan)                              |
| ---------- | ------------ | ----------------------------------------------------------------------------- |
| swallow    | [11.0, 35.0] | 11* : 0, \*\*24* : 62\*\*, 40 : 0, 70 : 0, 100 : 0, 130 : 0, 160 : 0, 185 : 0 |
| fish       | [6.0, 24.0]  | 6* : 0, \*\*16* : 38\*\*, 32 : 0, 64 : 0, 100 : 0, 120 : 0, 150 : 0, 170 : 0  |
| shortboard | —            | 1 : 0, 30 : 0, 93 : 0, 157 : 0, 185 : 0                                       |

So "stations inside the zone edit in a different frame" is, on today's boards, **one station
each** — the one at the notch bottom has a zero-length chord (tilt 0 by degeneracy), and
exactly one interior station is genuinely tilted. That is a UX labelling problem (say "rail
section, 62° from the cross-cut" in the section editor and draw the chord in the plan view),
not a reason to change the geometry. Option D does not change it: the fan still tilts, it
just decays differently. Option B would make it _worse_: every station on every board gets a
tilt (up to 32° on the asymmetric board's interior stations, and ±90° at the ends where the
foot is singular).

**What happens to a station when the notch depth changes?** Unchanged by any candidate,
because all of them key stations on the stringer coordinate ξ ∈ [d, L]: deepening the notch
raises `d`, the domain's lower end moves forward, and stations the notch passes are no longer
in the domain. The fix is not in the frame — it is to key a station on something the notch
does not move (its position as a fraction of the _remaining_ stringer, or a station id with a
stored x that is clamped rather than deleted) and to key bottom features the same way. That
is a `store`/`doc` change of its own, independent of all four options, and it is the one
listed cost in the brief that none of these options addresses. Sized below.

### 8. Generality: bat tails and wings

Measured, not argued:

- A **wing** needs no new machinery at all. It is a corner knot in the outline chain
  (`smooth: false`). A squash tail with two wings and no notch builds with no warnings,
  station fit 0.0100 cm, 8,362 live vertices, 44 ms mesh, STEP deviation 0.40 mm and a
  **0.000°** fold. A wing added to the swallow at x = 60 builds with no warnings, fit
  0.0123 cm, 13,104 vertices.
- A **bat tail** is a shallow notch plus wings, and it is where today's model is weakest:
  with a notch 5 cm deep, zones of 10, 15 and 20 cm are all refused by `notch-chord-angle`
  (chords crossing the outline at 12.5°, 0.2° and 4.7°), because the fan's chords run along
  the wing's concave corner. The auto ladder settles on 30 cm (6× the depth), which validates
  but puts the fan's end in the middle of the wing: fold **0.721°**. Option D's map on the
  same outline gives **0.166°**, same deviation band (0.37 mm), 15,336 vertices (+18 %),
  21–32 ms.
- A tail with **two notches either side of a centre pod** would break every option here,
  because its side notches put a pole off the stringer and the single-spine model has
  nowhere to put it. No sample file and no listed feature needs it.

## Authoring: drawing a cut that bakes into the outline

Shape3D's "draw the cut" is a better gesture than our tail dropdown, and it does not need a
boolean. The data flow, sketched (not built):

1. The shaper draws a plan region on the tail — in the simplest case a two-point Bézier from
   a point on the stringer to a point on the rail, which is literally what Shape3D stores.
2. We **bake it into the outline chain**: split the outline at the rail end of the drawn
   curve (exact de Casteljau split, which `convert.ts` already does for sections), drop the
   span behind it, and splice in the drawn curve reversed as the inner wall, so the chain runs
   notch bottom → tip → outer rail. Set `tail: { kind: 'notched', zone, auto: true }` and let
   `resolveTail` pick the zone from `NOTCH_ZONE_LADDER`.
3. Refuse at the drawing stage, not after: the two checks are the validator's own
   (`notch-tip`, `notch-chord-angle`), so the gesture can show the shaper live that the wall
   is too steep for the tips they are asking for, and the auto zone will usually fix it for
   them.
4. Nothing is trimmed and nothing new is stored: the saved document is an ordinary notched
   board, indistinguishable from one built from the dropdown.

The same flow turns the dropdown into a preset ("swallow 4 cm" draws the curve for you), so
the two authoring routes share one code path.

## Importing Shape3D cut layers as a native tail

`Sample board imports/carlos/Go_fish.s3dx` has the fish notch as `Calque_0`, `TypeCalque` 4.
Its `OtlExt` plan region is a 2-point cubic from (0, 14.85) to (10.795, 0) — in board
coordinates with the tail at x = 0, that **is** our inner wall: tip at x = 0, half-width
14.85 cm; notch bottom at x = 10.795, y = 0. So the conversion is step 2 of the authoring
flow above, with the curve read from the file instead of drawn. What it needs:

- the layer's `OtlExt` control points and both tangent polygons, mapped through the reader's
  existing coordinate convention (the `.srf`-style end-swap does not apply here; `.s3dx`
  already stores the tail at x = 0, as `fbfe4a7` established for `<Otl>`);
- a test that the cut is a **through** cut and not a pocket: the layer's depth (4.78 in the
  file) against the board's thickness at the notch. A through cut becomes a notched tail; a
  pocket is a bottom feature and belongs in `features[]`, not in the tail;
- `DeckBot`, `LeftSide`/`RightSide` to decide which side(s) and which face the cut is on — a
  one-sided cut is an asymmetric outline, which the model already holds;
- the layer's own cross-sections and its edge-smoothing flag: **discarded**, with a
  `convert-adjusted` warning. Our inner wall takes its section from the board's stations and
  the fan, which is the whole point of not doing a boolean. This is the same class of
  divergence `notchReshaped` already reports for classic notch pods;
- `TypeCalque` 4 layers that are not at the tail (the file's second layer is a bottom
  channel) keep going to `features[]` as now.

Everything here is a reader change in `packages/io`, with no engine change — which is also
why it is safe to do while another branch is working in `packages/io`: it should be done
_there_, not here.

## Migration plan

The recommendation is no change to the engine, so the migration is the follow-ups only.

| Step | What                                                                                                                                                                                                                                                                                                                                                                 | Size                                                | Re-baselined                                                                                                                                                                                                                                                                       |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | **Re-measure and correct `m3-exports.md`'s fold table** (and the "What did not improve" paragraph, which names 0.104° / 0.146° at s ≈ 0.07; the measure now puts the swallow's worst at 0.063° at s = 0.212). Find out why the recorded run differs before trusting either figure.                                                                                   | Half a session                                      | The table only; no fixture, no snapshot. If the table is wrong, nothing shipped was wrong.                                                                                                                                                                                         |
| 2    | **Pick the notch zone against the fold.** `NOTCH_ZONE_LADDER` currently stops at the first rung that validates (monotone map, 20° chords). Add the fold as a second gate for `auto` tails, or simply add rungs and prefer the lowest measured fold. Needs a cheap fold proxy at build time (the chord direction's turning rate in the fit's `s`, not a STEP export). | One session                                         | `board-store` and `io` characterization snapshots for any board whose auto zone changes — on today's corpus, none: the swallow and the fish store explicit zones and the converted goldens are standard tails. The classic swallow/fish fixtures would move if their rung changes. |
| 3    | **Option D's map for long fans only** (bat tails), behind the same `ChordMap` seam the prototype already adds. Only notched tails whose chosen zone exceeds some multiple of the notch depth would take it, so the swallow and the fish keep today's surface bit for bit.                                                                                            | One session, the seam is already written and tested | Nothing on today's corpus (standard boards get no map; the swallow and fish keep theirs). A new golden for the bat tail when M4 ships one.                                                                                                                                         |
| 4    | **Station and feature keys that survive a notch-depth drag** (§7). Independent of the tail model: key a station and a feature key on something the notch bottom does not move, and clamp rather than delete.                                                                                                                                                         | Two sessions, mostly `store` and `doc`              | `board-store.characterization.test.ts` (the editing actions) and the v3 document's station `x` semantics — a document-format decision, so it needs its own note.                                                                                                                   |
| 5    | **If 0.05° everywhere is really wanted**, it is a STEP-fitter change: the stringer-lean collocation where the fan chords carry a large x component. Not measured; see below.                                                                                                                                                                                         | Unknown; a measurement first                        | `m3-exports.md`'s table, `step.test.ts`'s 0.2° notched bound.                                                                                                                                                                                                                      |

**Does "every classic file converts" still hold?** Yes, untouched: steps 1–3 change nothing
a standard tail sees (measured: `surfaceMove` exactly 0 between today's and option D's
build on the shortboard, funboard, longboard and the asymmetric board), and the converter is
not in the path. Had option B been adopted, it would not have held: the shortboard's 93 mm
breaks the 0.5 mm rule, `rail-smoothness.test.ts`'s 2 mm bound and the `divergences.md`
entry, and the 1 cm nose transom — a real feature of a real golden file — is the thing that
breaks it, so the rule would have failed on the corpus rather than on an edge case.

## What I did not measure

- **Why `m3-exports.md` records 0.104° / 0.146° where the same code now gives 0.063° /
  0.036°.** `board2` and `geom` have no commits between `f4402b0` (which wrote the table) and
  the branch point of this study, and `step.test.ts`'s own assertions pass either way (its
  bound is 0.2° for a notched tail), so the discrepancy is not a regression I introduced —
  but I did not run it down, and until someone does, **neither number should be quoted.**
- **The cause of the residual fold**, beyond ruling out the three candidates above (map
  smoothness class, zone length, fit resolution) and ruling out the measure itself. I did not
  instrument the fitter's stringer-lean rows to see which constraint the residual comes from,
  so step 5 above is a guess about where to look, not a diagnosis.
- **Option B at the evaluator's second order.** Its map's second derivative is a central
  difference of an analytic first derivative, so its curvature, zebra and STEP fit would need
  real third derivatives of the outline chain. It was not worth writing: the first-order
  numbers already sink it.
- **Option B on a notched tail, numerically.** §5's argument is geometric (the inner wall's
  inward perpendicular points away from the stringer) and the one number I took for it — the
  outline x at which the perpendicular foot first reaches the stringer — is confounded by the
  tip singularity on the synthetic boards (it reads x = 0 because the foot is infinite there,
  not because the rule works). The classic swallow's 6.6 cm is the only clean figure.
- **Browser timings.** All times are Node in a container. The brief's 35 ms median / 50 ms
  p95 budget is end to end in the browser; option B's 131 ms mesh on the shortboard exceeds
  the budget by so much that a browser run would not change the verdict, but option D's
  "wash" verdict rests on Node medians inside a ±30 % noise band.
- **Volume, area, curvature and zebra** under either candidate map; the Go fish's own outline
  (the file is gitignored third-party data and its outline is not yet read as a notched tail);
  DXF and PDF, which draw the document's outline chains and so cannot change; the web app,
  the e2e suites and the benchmarks (out of budget by instruction).
- **A bat tail golden.** The bat tail measured here is a hand-built outline (a 5 cm notch and
  two wings on the swallow's rail), not a real design. Its 0.721° is real, but a real bat
  tail's proportions could be better or worse.
