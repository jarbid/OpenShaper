# Rail bands

Deriving the facet dimensions a hand shaper marks on a blank, from the board they drew.

## The problem

Shaping a rail by hand is not cutting a curve. You plane a short sequence of flat
planes — bands — into the squared blank, then blend them away. What you actually need
at the stand is a small table of numbers: how far up the rail edge to pencil a line, how
far in from the deck corner to pencil another, and what angle to set the plane to.

Those numbers normally come from a printed reference chart (Greenlight's are the widely
circulated ones) which gives a handful of dimensions for a generic 2½" board and tells
you to adjust by eye. OpenShaper already holds the exact section the shaper drew, so it
can produce the numbers for _that_ board instead.

## The geometry: tangents, not secants

For a band at angle α, the plane to cut is the **tangent to the section at the point
where the section's own slope is α**.

This is the load-bearing decision, and the obvious alternative is wrong. A straight line
from the rail apex to a chosen mark on the deck flat — a secant — is easier to construct
and looks right on a drawing. But a chord between two points on a convex curve passes
_inside_ it, so on a section with a pronounced deck dome the cut removes foam the
finished rail needed. A tangent to a convex curve lies outside it everywhere, by
definition, so it can never cut too deep.

The method came from a contributor who hit exactly this: their first implementation used
secants, and the error only became visible once plotted. `rail-facets.test.ts` pins it
with a property test — over generated arcs and all three golden boards, no sampled
contour point may lie outside any facet plane — and constructs the secant version
explicitly to show it fails the same check.

### Angles are normal angles

The profile spline runs bottom-centre → rail → deck-centre in (x = half-width,
y = height), and the legacy tangent convention is `atan2(dx, dy)`. Walking it,
`normalByTT` sweeps π → π/2 → 0. So the apex is `normalByTT = π/2` (the same finder the
area integral uses), a deck band at α° is `normalByTT = α`, and a bottom band at β° is
`normalByTT = 180° − β`.

The tangent point is found by **bracketing within one side of the rail zone, walking
outward from the apex**, then bisecting. Not `ttByNormal`: that root-finds across the
whole spline, and any given normal angle occurs on both branches — three times on a
section with a bottom concave — so it can return a point on the far side of the board.

## Where the bands go

The angles were originally a **halving ladder** — 45°, then 22.5°, then 11.25° — because
that is what the printed reference cards use and it needs no arithmetic at the stand. It
is also, on inspection, close to the worst place to put them.

The foam a facet leaves over an angular gap Δ on a rail of local radius ρ is
`ρ²(tan(Δ/2) − Δ/2)`: **cubic in the gap**. The ladder's gaps across the 90° deck
quadrant are 45 / 22.5 / 11.25 / 11.25, so 87% of everything it leaves sits in the single
gap between the rail plane and the first band — and every extra band a shaper cuts is
spent halving the gap that was already smallest.

### One dynamic program

The leftover region decomposes into independent **caps**, one per pair of consecutive
facets, and a cap depends on nothing but the two tangents bounding it. Placement is
therefore a shortest path over an angle grid, solved exactly rather than hill-climbed —
and the same run returns the best placement for *every* band count, which is what lets
the dialog show where the returns die before the shaper commits to a count.

The grid is half a degree, so every angle printed is one a bevel gauge can be set to.

### The modes, and what unconstrained costs at the rail

Three placements: **least foam** (fitted), **halving ladder**, and **manual**. The fit is
per section — candidates are the tangents to that station's own convex hull — so the
angles differ station to station along a board. Nothing is drawn from a list; the
half-degree grid rounds the answer, it does not choose it.

Scoring runs all the way in to the stringer, and over that span the deck crown holds far
more removable foam than the rail turn does, so the unconstrained fit spends bands
flattening deck. Three bands on the golden shortboard:

| placement    | angles            | foam removed | worst left | left at the rail corner |
| ------------ | ----------------- | ------------ | ---------- | ----------------------- |
| ladder       | 45 / 22.5 / 11.25 | 83.8%        | 4.7 mm     | 1.21 mm                 |
| `least-foam` | 25.5 / 9.5 / 4.5  | 95.1%        | 2.8 mm     | 2.77 mm                 |

A `balanced` mode used to pin the first band at 45° to prevent that last column. It was
removed: it duplicated `least-foam` at every band but the first, which made two of the
three modes produce near-identical sheets. **The rail corner regression is real and
accepted** — a shaper who wants the corner held now says so in manual mode, which is a
better answer than a mode differing in one number.

### Manual marks

The trade's own set-out, and the terms are Greenlight's: a **rail mark** up from the
bottom corner, **deck marks** in from the top corner. The primary band joins the rail mark
to deck mark 1; each later band starts at the **midpoint of the band before it**, which is
why one new number per band is enough — by the time band 2 is marked, band 1 is a flat
face whose middle can be found by eye. The tuck takes two marks of its own.

The rail mark is a **percentage of the blank's thickness**, not a length, so it holds as
the board thins. That is not a modelling convenience: it is the "board thickness
multiplier, adjusting for thickness separately in nose, middle, and tail" that build guides
tell a shaper to apply by eye. Deck marks and the tuck are entered at the widepoint and
scale with thickness alongside it.

### How far thickness scaling actually carries — measured

The fitted mode's own marks, as a percentage of each station's thickness, across the
golden boards:

| mark        | shortboard | longboard |
| ----------- | ---------- | --------- |
| rail mark   | 45–56%     | 45–51%    |
| deck mark 1 | 108–166%   | 78–151%   |
| tuck up     | 5–13%      | 10–16%    |

So the **rail mark really is near-constant** — thickness is the right variable for it, and
60% (Greenlight's worked example is 65%) sits in range. The deck marks vary by ±25% and
**the tuck by 2.5×**, because a rail hardens toward the tips rather than merely shrinking.
No scaling rule recovers that from one number.

That is a fact about the method, not a defect in this implementation, and it is why the
per-station `cuts-inside` check earns its place: a chart applied down a whole board *will*
sit proud in places and cut in in others, which is exactly what a shaper corrects by eye.
The sheet says where, and by how much, before any foam is touched.

Two controls follow from it, both optional and both behind a disclosure: a **rail
percentage at each tip**, and a **mark scale at each tip** for the deck and tuck marks.

### What "start from the fitted marks" seeds, and what it refuses to

The button fills the centre marks and the per-tip rail percentages from the fit on the
board in hand. It deliberately does **not** fit a mark scale. That was tried: deriving one
from each tip's own first deck mark cut the shortboard's overcut stations from 9 to 2 and
made the funboard's *worse*, 10 to 14, because the deck marks and the tuck want different
scales and one number cannot serve both. Per-tip rail percentage, by contrast, improves
all three boards and regresses none (9→2, 10→8, 17→15), so that is seeded and the scale is
left as a dial the shaper can reach for.

### The percentage is the mark, not the rail's name

Worth stating because the first cut of this got it wrong in both directions. **"60/40"
names where the finished apex sits along the rail curve, counted from the deck** — "60% of
the curve above the apex, 40% below", "in a 60/40 rail the wide point is 60% down", "a
50/50 rail slightly turned down, the meeting point 10 degrees past center". A down rail is
80/20: apex 20% up.

The rail *mark* is a different quantity: a marking distance up the squared blank's rail
face, which the finished apex ends up **below**. Greenlight glosses its own mark
percentage as the rail's name, which is where the confusion came from; every other source
consulted counts from the deck.

So the sheet dimensions the apex as **a plain height** and prints no ratio at all. A
printed "27/73" would be read as a rail name by anyone who knows the term, and it would be
both inverted and measured against the wrong baseline (blank thickness rather than the
rail's own curve). The dialog says plainly that the mark is not the rail.

### What else the trade does that this does not

- **Angles vary along the length.** One build guide marks the first band "0-12″ at 30
  degrees, 12″–18″ at 45 degrees, 18″–30″ at 60 degrees"; the general rule is rails "quite
  round in the middle of the board and harder towards the nose and tail". The fitted mode
  does this per station because it reads each section. Manual **by angle** applies one set
  to the whole board — a deliberate simplification for the shaper who already knows the
  angle they want, and the dialog says so.
- **Rail types beyond the two charted.** Greenlight documents boxy and knifey; the field
  runs 50/50, 60/40, 70/30, 80/20 (down), egg, pinched, tucked-under. Nothing here is
  limited to a catalogue — the marks are free numbers — but there are no presets either,
  which is the obvious next addition.

The percentage resolves against the **blank's** corner-to-corner height, not the board's
nominal thickness — that is where the tape actually goes, and the two differ by a few
percent because the bottom plane is the in-zone minimum.

**A marked band can cut inside the finished rail**, which is the one thing the tangent
construction cannot do. It is measured, not corrected: `clearOf` is deliberately not
applied there, the marks stay exactly as typed, and the overcut is reported as a
`cuts-inside` warning and drawn in red on the station page. Silently moving a shaper's
line and printing a number they did not choose would defeat the point of a manual mode.

### An objective that was tried and dropped

A scale-free variant — minimising `Σ cap area / ρ²`, so a 1 mm leftover on a 15 mm rail
radius scores like a 60 mm leftover on a 900 mm deck — is the obvious way to protect the
rail without a hard constraint. It works: equal angular gaps (`90k/(n+1)` on a circle, the
closed form), and 0.33 mm left at the corner, the finest of anything tried.

It was removed anyway, for two reasons that only show up in measurement. 0.33 mm is finer
than a hand plane holds, so the facet lands close enough to the finished surface to leave
nothing to fair. And it pays for that with 60% foam removal, because being scale-blind it
spends every band inside the turn and leaves the entire crown to one gap.

### Real decks are not convex, and the hull is the honest answer

Two things break once bands reach past the rail turn.

A tangent taken by slope matching can be **crossed by the curve just inboard of it**: the
shortboard has a ~0.1 mm kink at a spline knot where the slope jumps back up for a
fraction of a segment. Every facet is therefore slid outward until nothing on the section
pokes through it (`clearOf`). On a convex stretch this changes nothing, which is why the
analytic tests are unaffected; where it bites it costs a rounding error's worth of foam
and preserves the invariant the whole module exists for.

More seriously, a deck stops being convex a long way out — the shortboard's tail stations
reverse at 18°. The first implementation refused every angle past the reversal, which
walled the bands out of the crown entirely and left *more* foam than the ladder. The fix
is to place bands on the **convex hull** of the deck branch: a hull edge bridges a hollow,
and a plane set to an angle in that range genuinely does ride across it on the two high
points either side. Same geometry, correct answer, no special case.

## Dimensions follow the cut order

Band 1 is measured off the squared blank: one mark up from the bottom corner, one in
from the deck corner. Those two corners are the only reference that exists when the first
cut is made.

Every later band is measured **on the face already cut** — band 2's mark sits on band 1,
measured back from its deck edge. Reporting band 2 as an offset from the original deck
corner would be simpler and useless: by then that corner is on the floor.

The tuck is cut last, because it destroys the bottom corner every rail mark is measured
up from.

## Stations: a fitted spacing, not a walked interval

Spacing is a **target**. The two sides of the widepoint are fitted independently: each
takes the whole number of steps closest to the target and divides its span by that, so
the outermost stations land exactly on the end margins and the widepoint keeps a station
of its own.

The first version walked a fixed interval outward from the widepoint, which left a
leftover gap of anywhere between nothing and a full interval at each tip. The last
station then floated an arbitrary distance short of where the shaper said to stop, so
"leave 20 cm" could mean 20 or 50 and the setting stopped meaning what it said.

The span is clamped to what is **bandable** before the fit runs, not after. A margin
that suits the tail can land inside a nose that tapers to a point — 5 cm from the tip of
a shortboard there is no rail at all. Fitting across the requested span and dropping the
unbandable stations afterwards spaced everything for a length that then went uncovered,
leaving the outermost station a long way short of the nose and the pattern looking
broken. Now each end walks inward to the first point with enough width and thickness to
band, and the fit covers that.

The cost is that the two sides get slightly different spacings. That is the right trade:
the widepoint is the reference a rail is designed around and the margin is where the
bandable rail ends, and both are worth more than a spacing uniform to the millimetre
when it was only ever a round number picked off a tape. The dialog and the sheet both
report the spacing that came out, not the one asked for.

## Reference planes

Deliberately asymmetric:

- **Deck plane = the section's highest point** (normally at the stringer). The blank's
  deck is still flat when the bands are cut; the dome comes afterwards. Taking an
  in-zone maximum would sit the plane below the blank's real top and under-report every
  band-1 deck mark.
- **Bottom plane = the lowest point within the rail zone**, not the value at the
  stringer. Some sections have a kink near the rail with a slight concavity whose low
  point sits below the stringer value, and measuring up from the stringer would start
  below foam that exists.

Where the bottom is flat, the minimum is attained across a whole interval; the
**outboard** end of that interval is reported, because that is where the flat stops and
the edge begins to turn. That also caps the residual-radius fit window.

## Residual bottom-edge radius

After the tuck, whatever round is left on the bottom edge is reported as a note, not a
facet. A circle is fitted (Kåsa) over the window from the in-zone minimum out to the
tuck's touch point, capped at 3 cm of arc. Two failure modes, both found in testing:

- a window reaching past the low point fits a circle across an S-curve and returns a
  meaningless radius — hence the cap;
- a near-straight tail section fits a radius of metres — hence the 0.05–15 cm sanity
  bounds, **outside which no radius is reported at all**.

Those bounds reject the fit; they do not clamp it. Clamping a metres-wide fit to 15 cm
and printing it with a caveat beside it puts a number on the sheet that describes
nothing, and the shaper reads the number, not the caveat. Every radius printed is one
actually measured off the curve.

A **null** radius is not an error and raises no warning. Plenty of bottom edges are
deliberately hard; the sheet says `hard` in that column. Warning about it would put a
caveat on every board with a hard tail edge, which is most of them.

## What is not proven

The construction assumes the bottom half of the rail zone is a simple convex turn.
Convexity is exactly monotonicity of the normal angle, so that is what gets measured. A
vee, a hard edge or a channel reaching into the zone breaks the assumption, and none of
the three has been checked against a real cut board — those stations carry an
`unvalidated-bottom` warning on the sheet rather than being refused.

Note the check is on the **zone**, not the whole section. A single concave lifts the
bottom at the stringer on a large share of real boards and never reaches the zone;
warning about all of them would train the shaper to ignore warnings.

The original method was tested on one board with seven sections. What is added here: it
now runs on the three golden boards at every station, with the convexity property
asserted, and every failure surfaces as a warning rather than a number.

## No golden fixture

BoardCAD-LE has no rail bands, so there is no legacy oracle to port against and none to
regenerate (`.claude/CLAUDE.md` rule 2). The tests use analytic oracles: the rail zone
is built as an exact circular arc — from **45° cubic segments, not 90°**, since slope
matching amplifies the arc error about fourfold and a quarter-arc fixture is not
accurate enough to assert against at 1e-3 cm.

## Scoring the leftover

Every station reports what its cuts leave standing proud of the finished section: the
area, the fraction of the blank's proud foam removed, and the deepest remaining spot.
Deck and bottom are scored **separately**, and the deck is the headline. On a board with
bottom concave the foam between the bottom plane and the section near the stringer is
real, but it comes off when the concave is cut, not when the tuck is; folding it into one
number would blame the tuck for work that was never its own. For the same reason the
bottom is scored across the rail zone only.

The measure is a shoelace between the cut path and the section, against the same loop
taken to the squared blank's corner. On the circular fixture that denominator is exactly
`R²(1 − π/4)` and the leftover for n bands is `(n+1)·R²(tan(Δ/2) − Δ/2)` at `Δ = 90/(n+1)`
— both asserted, so the metric is pinned to closed forms rather than to itself.

## Output

- **Page 1** — plan and rocker, drawn on one scale and one x origin with a drafting
  centreline dropped through both at every station, plus a master table of every number.
  Each band's mark is traced down the length of the board as a dash-dot line — the
  pencil line the shaper actually draws before planing anything, so where it runs out
  toward the tips is visible. A diagram, scaled to the sheet and stamped NOT TO SCALE.
- **Per station** — the real cross-section at **true 1:1**, the **rail apex** dimensioned
  as a height and as the rail it makes (60/40 means the apex sits at 60% of thickness —
  the vertical face between the rail mark and the tuck is what a shaper judges rail volume
  by), the leftover foam tinted so
  the shaper can see where the sanding is rather than infer it, facets drawn on it with
  chained dimensions and angles, the blank's overall thickness dimensioned off to the
  inboard side, the designed rail ghosted behind so the shaper can see what is left to
  blend, its own mark table, and a calibration ruler.

### Colour carries the band number

Band 1 blue, band 2 green, band 3 red, tuck magenta, station lines cyan — the palette
the printed reference cards use. Colour tracks _which band_, not what kind of dimension,
because the job it has to do is let a shaper follow one band from the line running down
the plan view, to its row in the table, to the facet on the 1:1 page, without reading a
word.

Dimension labels are drawn over an opaque knocked-out box. They land on the geometry
they are dimensioning more often than not, and an unreadable number on a shaping
template is worse than no number.

### The page is a budget, not a set of offsets

Section thickness, table length and whether there is a radius note all vary, and fixed
offsets pushed the footer off the bottom of the page and over the brand line on thick
stations. The detail page now costs out its pieces and, when they do not fit, **drops
explanatory prose before it allows the page to grow**. A sheet even a few millimetres
over A4 is a trap: the shaper reaches for "fit to page", which silently destroys the one
thing the page exists to carry. The cut order always survives; the prose is also in
`/docs/export`. All three golden boards fit A4 exactly.

Detail pages are never scaled to fit. Width is **capped at the sheet** rather than
allowed to grow: fitted bands put the innermost deck mark most of the way to the
stringer, and letting the crop follow it would push every page on a wide board past A4.
A mark beyond the crop keeps its true number over a **broken dimension line** — it is a
tape pull from the deck corner, not a traced line, so interrupting the drawing of it
costs nothing and the rail stays 1:1. Height can still force an oversized page, with a
`page-oversized` warning; six bands genuinely need more room than A4 holds. A rail
template printed at 96% is worse than no template.

Pages default to landscape because rail crops are wide: the shallowest band reaches
about 5¼ in in from the rail on a real shortboard, since a nearly-flat deck only meets a
shallow tangent a long way inboard.

## Reference material

The contributor's write-up, their Python reference, and the Greenlight cards are in
`reference/rail-bands/`, which is gitignored — third-party material, never committed.
Only `analyze_section()` and its helpers were worth porting; the rest of that
implementation is Python-ecosystem plumbing.
