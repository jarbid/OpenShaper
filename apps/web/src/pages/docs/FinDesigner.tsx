// SPDX-License-Identifier: GPL-3.0-or-later
import {
  FCS_SINGLE_TAB,
  FCS1_BASE,
  GBOX_TAB,
  gboxNotchHeight,
  US_BOX_HEAD,
  FUTURES_TAB_HOLES,
  FIN_BASE_LABEL,
  FIN_MAX_CANT,
  FIN_MAX_TOE,
  FIN_MAX_FRONT_OVERHANG,
  FIN_EXPORT_MIN_THICKNESS,
  FIN_MIN_THICKNESS,
  FIN_MIN_THICKNESS_LIMITS,
  FUTURES_TABS,
  rearClearance,
} from '@openshaper/kernel';
import { Link } from 'react-router-dom';
import { shortcutKeys } from '../../shortcuts';
import { DocsPage, Section, Term, Terms } from './DocsPage';

/** Kernel cm to a "12.7 mm" string. Numbers come from the kernel so the page can't drift. */
const mm = (cm: number) => `${Number((cm * 10).toFixed(2))} mm`;
const deg = (d: number) => `${Number(d.toFixed(1))}°`;

/**
 * Where testers send feedback, if this deployment says (`VITE_FEEDBACK_EMAIL`): a
 * callout at the top of the help page.
 */
function FeedbackNotice() {
  const email = import.meta.env.VITE_FEEDBACK_EMAIL as string | undefined;
  if (!email) return null;
  return (
    <aside
      aria-label="Feedback"
      className="mb-10 rounded-lg border border-primary/40 bg-primary/10 px-5 py-4 text-foreground"
    >
      Please email feedback to:{' '}
      <a className="font-medium text-primary underline underline-offset-4" href={`mailto:${email}`}>
        {email}
      </a>
    </aside>
  );
}

export default function DocsFinDesigner() {
  const side = FUTURES_TABS.side;
  const centre = FUTURES_TABS.centre;
  return (
    <DocsPage
      siblings={false}
      notice={<FeedbackNotice />}
      route="/docs/fin-designer"
      title="OpenFinShaper help"
      lede="Design a Futures-tab surf fin from scratch — profile, foil and flex — and export it for a CNC mill or a 3D printer."
      toc={[
        { id: 'start', label: 'Starting a fin' },
        { id: 'outline', label: 'The profile' },
        { id: 'sweep', label: 'The foil sweep' },
        { id: 'foil', label: 'The foil' },
        { id: 'control sections', label: 'Control sections' },
        { id: 'cant-lines', label: 'Cant lines' },
        { id: 'taper', label: 'Thickness and flex' },
        { id: 'base', label: 'The tab' },
        { id: 'tab', label: 'Placing the fin on its tab' },
        { id: 'analysis', label: 'Section analysis' },
        { id: 'colours', label: 'What the colours mean' },
        { id: 'rules', label: 'The rules it keeps' },
        { id: 'files', label: 'Saving your work' },
        { id: 'import', label: 'Importing drawings' },
        { id: 'export', label: 'Exporting for CNC and printing' },
      ]}
    >
      <Section id="start" title="Starting a fin">
        <p>
          Open the <Link to="/fin">fin designer</Link> and choose a starting fin from{' '}
          <strong>New fin</strong>. The starting fins are a place to begin, not a catalogue: reshape
          them as far as you like. Each one sits on a standard tab, which you don&apos;t edit (see
          The tab).
        </p>
        <Terms>
          <Term name="Side, left or right">
            The {mm(side.height)}-deep side tab, with cant. Left and right are mirror images: the
            outside face points to the rail. They are named the way fin makers mark them, with the
            board seen from below, nose up — so a left fin goes on the rider&apos;s right rail.
          </Term>
          <Term name="Quad rear, left or right">
            The shallower {mm(centre.height)} tab (quad rears sit where the tail is thinner), with
            cant.
          </Term>
          <Term name="Centre">The {mm(centre.height)} tab, upright, with a symmetric foil.</Term>
          <Term name="Twin fin, left or right">
            A tall, raked twin fin on the side tab, with cant, its rear running out behind the tab
            over a raised underside. A starting point for the rear overhang twins and keels need.
          </Term>
          <Term name="Keel, left or right">
            A long, low keel on the side tab, with cant, its raised rear running well back behind
            the tab.
          </Term>
          <Term name="Canard, left or right">
            A small fin on the FCS single tab (see <a href="#base">The tab</a>), its base centred
            over the tab, with a flat inside face and no cant: the plug carries it.
          </Term>
          <Term name="Single fin (US box)">
            A raked 8&quot; ({mm(20.32)}) longboard single fin on a US box head (see{' '}
            <a href="#base">The tab</a>), with a symmetric foil {mm(1)} thick at the base and no
            cant.
          </Term>
        </Terms>
        <p>
          Both tabs are {mm(side.length)} long and {mm(side.thickness)} thick. Lengths are shown in
          millimetres unless you choose inches in <a href="#settings">File settings</a>.
        </p>
        <p>
          The fin is shown four ways: the profile, the foil, the thickness and a 3D view. One fills
          the large pane on the left and the other three sit in small panes on the right; the swap
          button on a small pane brings its view into the large pane. The large pane&apos;s toolbar
          holds that view&apos;s controls. The 3D view keeps its controls (side, cant and position)
          under it when it is small. The measurements run along the bottom.
        </p>
      </Section>

      <Section id="outline" title="The profile">
        <p>
          The profile shows the fin from the side, drawn over its tab, front on the left and rear on
          the right, as fin designers draw it and as the foil view runs. Drag a point or a handle to
          reshape it; double-click the curve to add a point; select a point and press Delete to
          remove it. The toolbar&apos;s point tools do the same for the selected point on any curve
          — <strong>+</strong> adds a point halfway to the next, <strong>−</strong> deletes it — and
          make it <strong>Smooth</strong> (its handles in line) or a <strong>Corner</strong> (each
          handle free). A curve&apos;s two end points stay put. Drag empty space to pan and scroll
          to zoom. The profile starts and ends on the base: its two ends slide along it.
        </p>
        <p>
          To move several points at once, hold Shift and click each one (Shift-click a selected
          point to drop it). Then drag any of them: the others follow the same distance the same
          way, and they all stop together where the fin would break a rule. An end point in the
          group stays on its line (the base, the tip or the chord). Delete removes every selected
          point that can go. This works on any curve: the profile, the foil faces and the thickness
          curve.
        </p>
        <p>
          <strong>Depth</strong> stretches the profile to a new height over the same base. Readouts
          show the area (the profile above the tab), depth, base length and rake — the angle from
          where the leading edge meets the base to the tip, measured from upright.
        </p>
        <p>
          <strong>Scale</strong>, the icon at the top left of the profile view, below the ghost,
          makes the whole profile larger or smaller, evenly. A dashed box appears round the profile,
          showing its depth and base length, with a square block at its top-left corner. Drag the
          block out toward the top left to make the fin larger, or in toward the bottom right to
          make it smaller; the percentage shows as you drag. The rear end of the base stays put on
          the top of the tab, so the fin stays on the tab and keeps its place at the back of it. (On
          a raked fin the tip reaches back past the base, so the box&apos;s lower-right corner is a
          little behind that point.) The fin stops growing where it would break a rule, such as
          overhanging the front of the tab. Let go and the tool puts itself away; the whole drag is
          one undo step. Press Escape or click away from the block to put it away without scaling.
          Only the profile changes: the thickness stays as it was.
        </p>
      </Section>

      <Section id="sweep" title="The foil sweep">
        <p>
          The fin is foiled the way a foiler works it: the foil starts along the base and sweeps up
          the blade, turning as it goes, until it lies across the tip. The profile shows where it
          starts and ends as two thin green lines, <strong>Base foil</strong> along the base and{' '}
          <strong>Tip foil</strong> across the tip. In between, every section runs from the leading
          edge to the trailing edge, so each edge is foiled straight across, hooked tips and raised
          rears included, and the foil blends from the base foil to the tip foil. The tip line is
          one of those sections, exactly straight: the tip foil lies along it as you drew it, at one
          thickness. Past it the sections shorten toward the middle of the tip edge, so the tip
          thins to its edge the way a foil&apos;s nose does. The whole surface is one smooth piece,
          so blending the foils, thickness, cant and toe can&apos;t crease it; check it with{' '}
          <a href="#analysis">Zebra</a>.
        </p>
        <p>
          Click either green line to edit its foil: it glows, and the foil view shows that foil with
          its name, the tip foil turned level. The foil view&apos;s <strong>Base</strong> and{' '}
          <strong>Tip</strong> tabs do the same. Until you change it, the tip foil is the base foil.
          Drag either green dot at the ends of the tip line along the profile to move where the
          sweep ends: it starts where the profile begins to curve tightly into the tip. The top of
          the fin counts as tip: the dot on the leading edge&apos;s side starts where the leading
          edge turns onto the top (within 20° of level), so the sections near the top run level, and
          a cut near the top is thickest toward its front, as a foil is. Drag it anywhere along the
          profile, round the top included: further round, the sections near the top slant down
          toward the trailing edge, and so does the thickness.
        </p>
        <p>
          The dashed amber line is the <strong>thickness path</strong>: where each section is
          thickest, from the base to the tip line. Its ends are the base and tip foils&apos;
          thickest points, so the two always agree: drag the path&apos;s end dot in the profile and
          that foil is reshaped to match; drag the orange <strong>thickest point</strong> dot in the
          foil view (or reshape the foil) and the path follows. The middle dot moves only the path.
          Each section is as thick on the path as the thickness curve says at that point along the
          fin: the curve is read along the path, from the base round to the tip, so on a hooked or
          swept fin it follows the arm.
        </p>
        <p>
          On a raised rear the sweep starts along the underside too, so the underside keeps the
          foil&apos;s thickness rather than thinning to an edge.
        </p>
      </Section>

      <Section id="foil" title="The foil">
        <p>
          The foil view shows the foil being edited true to scale: as thick for its chord as the
          thickness curve makes it there, the outside face above the chord line and the inside face
          below, its name at the top right; the toolbar holds its controls. Scroll to zoom in on a
          thin foil. Its tabs pick the foil: <strong>Base</strong> and <strong>Tip</strong>, the
          sweep&apos;s two (see <a href="#sweep">The foil sweep</a>), then each control section
          foil, by how far along the fin it is (see <a href="#slices">Control sections</a>). Its
          size follows the profile and the thickness curve; this pane sets only its shape. With a
          panel set in <a href="#settings">File settings</a>, the panel&apos;s two faces are drawn
          level and true to scale either side of the foil, slate when the fin fits it and orange
          when not.
        </p>
        <Terms>
          <Term name="Asymmetric">
            A side fin&apos;s foil, with an inside face of its own. Choosing it starts with a flat
            inside face, the usual side-fin foil (100 / 0). The <strong>Outside</strong> and{' '}
            <strong>Inside</strong> boxes beside it in the toolbar say how the thickness is shared,
            the way shapers describe a foil: 70 / 30 is 70% of the thickness above the chord line
            and 30% below. Type either and the other follows; Enter builds the foil as a rounded
            leading edge on each face, as tall as that face&apos;s share of the thickness, then a
            straight line on to the trailing edge: in the fin each radius is four times longer than
            it is tall, a fine nose with the thickest point about a sixth of the way back. Each face
            gets a point halfway round its radius and one where it meets the line, to reshape it
            from. The sizes are true to the fin: its thickness and chord at the base, or at the
            control section being edited. The split goes from 100 / 0 down to 51 / 49: an even split
            is a symmetric foil, which has its own button. An asymmetric foil&apos;s leading- and
            trailing-edge points can be dragged off the chord line, outboard or inboard, to blend a
            twist: both faces move with them, so the edge stays closed and at the minimum thickness,
            and the edge moves with the foil as it scales. A new control section copies the edge
            where the fin has it. Making the foil symmetric or flat inside brings its edges back to
            the line.
          </Term>
          <Term name="Symmetric">
            The same curve on both faces — always the case on a centre fin. Its edges stay on the
            chord line.
          </Term>
          <Term name="NACA presets">
            Pick a NACA 4-digit foil from the list (2412, 0010, …), or Other… to type any code, and
            Apply to replace both faces with that foil, six points each; they stay editable
            afterwards. The convex face goes outside. A centre fin takes only symmetric 00xx foils.
            The foil keeps its proportions above the minimum thickness, so a 2412 stays 2 : 12
            camber to thickness however thick the fin.
          </Term>
          <Term name="Analysis">
            At the top left of the foil view, as in the 3D view: draws the fin&apos;s other sections
            faintly behind the foil you are editing, to compare them. <strong>Align</strong> lines
            them up with it at the <strong>Thickest point</strong>, the <strong>Front</strong> or
            the <strong>Rear</strong>, each in its own chord&apos;s frame; or{' '}
            <strong>On the tab</strong>, where they really sit, seen from above, so the cant leans
            the higher ones out and toe turns them. <strong>Show</strong> picks the base and tip
            foils and the control sections, each as it lies (a tip foil on a steep tip line is seen
            nearly edge-on, a thin line), or horizontal <strong>sections every</strong> so many
            millimetres (10 mm to start). They are true to scale against your foil, and the higher
            on the fin, the brighter, so the stack reads from base to tip; point at one to see which
            it is.
          </Term>
        </Terms>
      </Section>

      <Section id="slices" title="Control sections">
        <p>
          The sweep carries one foil up the blade. A <strong>control section</strong> sets the foil
          on one line across the fin, from edge to edge, always below the tip line.{' '}
          <strong>Add control section</strong> (in the profile&apos;s toolbar) puts a dashed line
          across the profile, following the fin; drag it along the fin in the profile or the
          thickness view. A control section can be dragged past another: it waits just short of it,
          then hops to the other side, and it takes its foil with it. Its name is its distance along
          the fin from the base. Each control section has its own foil: pick its tab in the foil
          view and shape it with the same tools, NACA presets included. A new control section starts
          as the shape already there, drawn with as few points as follow it to within 2% of its
          thickness, so adding one changes next to nothing until you reshape it.
        </p>
        <p>
          A control section&apos;s foil is the fin&apos;s shape along its line, exactly as drawn.
          Its change blends smoothly into the fin over 15% of the way along the fin below and above
          it — less where the base, the tip line or the next control section is nearer — and has
          always gone by the tip line, so it never disturbs the tip foil. Two control sections
          closer than that hold their changes all the way between them. The thickness still comes
          from the thickness curve, so a control section changes the foil&apos;s shape, not how
          thick it is; it has no thickest-point handle. <strong>Remove control section</strong>,
          next to Add control section, takes the selected control section away: click a control
          section&apos;s line (or its foil tab) to select it. Control sections keep at least 2% of
          the way from each other and from the base and tip line.
        </p>
        <p>
          A control section sets the foil only. To bend or twist the blade, use a{' '}
          <a href="#cant-lines">cant line</a>.
        </p>
      </Section>

      <Section id="cant-lines" title="Cant lines">
        <p>
          A <strong>cant line</strong> changes the blade&apos;s cant and toe from a height up: more
          cant leans the upper blade out, and toe twists it in or out, as a hatchet fin&apos;s tip
          often does. The line is level, so the bend runs along the water&apos;s flow, not across
          it. <strong>Add cant line</strong> in the profile&apos;s toolbar puts one at a height;
          drag it up or down.
        </p>
        <p>
          Click a line, or pick it in the 3D view&apos;s <strong>Cant and toe at</strong> list, to
          set its <strong>Cant</strong> (−20° to 20°: it may lean back past upright) and{' '}
          <strong>Toe</strong>. A new line starts at what the blade has there, so adding one changes
          nothing until you edit it. The blade eases from what it had to the line&apos;s values over
          the 15% of the depth above the line, or up to the next line if that is nearer, with no
          crease, and holds them above. <strong>Remove cant line</strong> takes the selected one
          away. Cant lines keep at least 2% of the depth from each other, the base and the top.
        </p>
      </Section>

      <Section id="taper" title="Thickness and flex">
        <p>
          The thickness view shows how thick the fin is at the foil&apos;s thickest point, from the
          base (bottom) to the tip (top). It stands upright at the fin&apos;s true depth, so it
          lines up with the profile; thickness runs across, drawn four times wider than true. A
          straight run that curves in near the tip is the usual shape: that curve is what controls
          how the tip flexes. The curve holds all the way up: past the tip line the tip is no
          thicker than the curve says at each height, the loft rounding it off to the edge, so a
          fuller curve near the tip gives a fuller tip and no more. <strong>Base thickness</strong>{' '}
          scales the whole curve. <strong>Min thickness</strong>, beside it, sets the thinnest the
          fin may get (see <a href="#rules">Minimum thickness</a>); the dashed line shows it. On a
          heavily swept-back fin, whose arm reaches back to the tip spanning little height, the
          curve is measured along the sweep instead — from the base, along the orange thickness
          path, to the tip — so the arm thins toward its tip rather than keeping its full thickness
          to the tip line. The thickness view says so when it does; fins that rise as they sweep
          back are read by height, as always.
        </p>
      </Section>

      <Section id="base" title="The tab">
        <p>
          The tab is what the fin sits on in the board&apos;s box. Choose it with{' '}
          <strong>Tab</strong>, beside the 3D view. Each starting fin begins on its usual Futures
          tab; changing the tab re-places the fin on the new one.
        </p>
        <Terms>
          <Term name={FIN_BASE_LABEL['futures-side']}>
            The {mm(side.height)}-deep Futures side tab, with cant built into the fin. Like the
            1/2&quot; tab it has four weight-saving holes through it, {mm(FUTURES_TAB_HOLES.length)}{' '}
            × {mm(FUTURES_TAB_HOLES.height)} with round ends, centred on its height.
          </Term>
          <Term name={FIN_BASE_LABEL['futures-centre']}>
            The {mm(centre.height)}-deep Futures centre tab, for centre and quad-rear fins. Its
            weight-saving holes sit level with the rear slot.
          </Term>
          <Term name={FIN_BASE_LABEL['fcs-single']}>
            A plain {mm(FCS_SINGLE_TAB.length)} × {mm(FCS_SINGLE_TAB.height)} ×{' '}
            {mm(FCS_SINGLE_TAB.thickness)} block for an FCS 1 style single plug, usual for small
            canard fins. It drops straight in and a grub screw in the side of the plug holds it, so
            it has no slot, notch, front-overhang limit or rear clearance. The plug sets the cant
            (0°, 5° or 9°), so the fin has none: the cant field is greyed out. A fin moved onto it
            starts centred over the tab, and the tab must stay wholly under the fin&apos;s base.
          </Term>
          <Term name={FIN_BASE_LABEL['fcs-1']}>
            Two {mm(FCS1_BASE.tabLength)} × {mm(FCS1_BASE.height)} × {mm(FCS1_BASE.thickness)} tabs,{' '}
            {mm(FCS1_BASE.gap)} apart, their lower corners rounded to {mm(FCS1_BASE.cornerRadius)},
            for the two plugs of an FCS 1 fin. FCS II plugs take FCS 1 fins too. Like the single tab
            they drop straight in, the plugs set the cant so the fin has none, and both tabs must
            stay wholly under the fin&apos;s base. FCS fins are aligned from the back: a fin moved
            onto it starts with its trailing edge {mm(FCS1_BASE.rearBlade)} behind the rear tab, so
            a bigger fin overhangs further at the front; a fin too short for that comes forward just
            enough to cover the front tab. The tabs have no grub-screw hole, as on most aftermarket
            fins.
          </Term>
          <Term name={FIN_BASE_LABEL['us-box']}>
            The head of a longboard&apos;s single-fin box: {mm(US_BOX_HEAD.height)} deep,{' '}
            {mm(US_BOX_HEAD.thickness)} thick, {mm(US_BOX_HEAD.minLength)}–
            {mm(US_BOX_HEAD.maxLength)} long. Its front is a nose half the depth, ahead of the
            leading edge, with the {mm(US_BOX_HEAD.screwRadius * 2)} hole for the box&apos;s 8-32
            screw drilled down through it; behind the nose a {mm(US_BOX_HEAD.scoopRadius)} radius
            curve sweeps down to the full depth, and the lower rear corner is rounded. The
            head&apos;s front follows the fin, {mm(US_BOX_HEAD.noseAhead)} ahead of the leading edge
            (but never under {mm(US_BOX_HEAD.minLength)} long); its rear end stays put. A fin starts
            with its trailing edge {mm(US_BOX_HEAD.rearStub)} ahead of that rear end. The position
            arrows are forward and back only: they slide the blade along the head, back as far as
            the head&apos;s rear end, forward until the head is {mm(US_BOX_HEAD.maxLength)} long. A
            symmetric fin centred on the head has no side to slide to, so there are no left and
            right arrows. No cant, and no toe.
          </Term>
          <Term name={FIN_BASE_LABEL.gbox}>
            The legacy Gbox fin base, from Gbox&apos;s drawing: one 2 7/8&quot; × 17/32&quot; ×
            1/4&quot; block ({mm(GBOX_TAB.length)} × {mm(GBOX_TAB.height)} ×{' '}
            {mm(GBOX_TAB.thickness)}). A 7/8&quot; ({mm(GBOX_TAB.notchRadius * 2)}) hole saw,
            centred along the tab with its centre 1/8&quot; below the bottom, cuts a notch{' '}
            {mm(gboxNotchHeight())} (5/16&quot;) up into its underside. The box sets the cant, so
            the fin has none, and the tab must stay wholly under the fin&apos;s base. A fin moved
            onto it starts with its trailing edge 13/16&quot; ({mm(GBOX_TAB.rearBlade)}) behind the
            tab&apos;s rear end, as drawn; a fin too short for that comes forward just enough to
            cover the tab. Not in the exported files: the two screw grooves in the tab&apos;s side
            (a 1/8&quot; flat end mill, 1/16&quot; deep, 7/16&quot; long, 3/16&quot; in from each
            end, 1/4&quot; above the bottom). Cut them after printing or machining.
          </Term>
        </Terms>
      </Section>

      <Section id="tab" title="Placing the fin on its tab">
        <p>
          Starting fins are rear-aligned: the blade&apos;s trailing edge meets the tab&apos;s rear
          end. A flat inside face sits flush with the tab; a symmetric foil is centred on it.
        </p>
        <Terms>
          <Term name={`${shortcutKeys('fin-nudge-forward')} ${shortcutKeys('fin-nudge-back')}`}>
            Move the fin forward or back along the tab.
          </Term>
          <Term name={`${shortcutKeys('fin-nudge-left')} ${shortcutKeys('fin-nudge-right')}`}>
            Slide the blade left or right across the tab, as the 3D view from above shows it (nose
            up the screen) — for a strongly curved inside face that overhangs the tab, slide it back
            over. On a left fin, left is outboard; on a right fin, right is.
          </Term>
          <Term name="Cant">
            How far the blade leans out from the tab, 0° to {FIN_MAX_CANT}°. Futures builds cant
            into the fin, not the box. A centre fin has none.
          </Term>
          <Term name="Toe">
            Turns the blade on its tab, within ±{FIN_MAX_TOE}°, about the centre of the base&apos;s
            thickest point, to correct a box set at the wrong angle to the stringer: toed in too
            much, or not enough. The arrows turn it a quarter-degree a click (a little toe makes a
            big difference), or type the angle. Plus is more toe in: the leading edge turned toward
            the stringer, on either side, so a left and right pair match.{' '}
            <strong>View from above</strong> looks down the blade, with a slate line along the tab:
            the box&apos;s direction to judge it by. A flat inside face turned this way no longer
            lies exactly along the tab. A centre fin and a fin in a US box sit on the stringer, so
            they have no toe: the toe controls are greyed out.
          </Term>
        </Terms>
      </Section>

      <Section id="analysis" title="Section analysis">
        <p>
          <strong>Analysis</strong>, at the top left of the 3D view, turns the fin see-through and
          cuts it with a section plane, the cut drawn in yellow so it shows from any angle. Rotate,
          pan and zoom as usual; <strong>Reset view</strong> puts the camera back where it started.
        </p>
        <Terms>
          <Term name="Vertical">
            On by default. An upright plane square to the base, moved with the slider along the
            bottom of the view, which runs the way the fin lies in the starting view. It reads how
            far back from the leading edge it is, the blade&apos;s height there, and its greatest
            thickness there, along the bottom of the view.
          </Term>
          <Term name="Horizontal">
            A plane across the blade at a height, moved with the slider up the right edge. It shows
            the foil at that height and reads the height, the chord and the thickness, along the
            bottom of the view.
          </Term>
          <Term name="Zebra">
            Black and white stripes over the blade, to judge how smooth it is, as on a car body
            under strip lights. Over a smooth face the stripes run on unbroken and bend gently.
            Where they break or jog sideways, the face has a crease; where they kink, its curve
            changes suddenly. Turn the fin to move the stripes across a spot you want to check.
          </Term>
        </Terms>
        <p>
          Any of them can be on together. Thicknesses are square to the blade, allowing for cant.
          The sliders sit on the edges of the view rather than on the planes, so they stay in reach
          however the fin is turned.
        </p>
      </Section>

      <Section id="colours" title="What the colours mean">
        <p>Each colour means one thing, in every view.</p>
        <Terms>
          <Term name="Cyan">The profile and the outside face; also what is selected or on.</Term>
          <Term name="Violet">The inside face.</Term>
          <Term name="Pink">Control sections: their lines.</Term>
          <Term name="Pale grey">Cant lines.</Term>
          <Term name="Green">The base foil and the tip foil: the sweep&apos;s two lines.</Term>
          <Term name="Amber">Thickness: the thickness curve and the thickness path.</Term>
          <Term name="Orange">
            Limits and warnings: the minimum thickness, the rear clearance, a panel the fin
            doesn&apos;t fit.
          </Term>
          <Term name="Red">A problem that stops export.</Term>
          <Term name="Slate">Guides, labels, the section planes, and a panel the fin fits.</Term>
        </Terms>
      </Section>

      <Section id="rules" title="The rules it keeps">
        <p>
          The designer won&apos;t let a drag break these; a point stops where it would. Anything
          that does break one (an old file, say) shows as a red chip at the right of the status bar;
          open it for the list.
        </p>
        <Terms>
          <Term name="Front overhang">
            The leading edge may overhang the front of the tab by at most{' '}
            {mm(FIN_MAX_FRONT_OVERHANG)}: the box&apos;s grub screw sits there.
          </Term>
          <Term name="Raised rear">
            A Futures fin is fitted rear first, hooked on the pin at the back of the box, then
            rocked down — about {deg(rearClearance('side').tilt)} on a side tab,{' '}
            {deg(rearClearance('centre').tilt)} on a centre tab. Anything behind the tab swings
            toward the board, so a fin whose base runs past the tab&apos;s rear end needs a raised
            rear. The dashed orange line behind the tab is the clearance it needs. The raised rear
            keeps the base&apos;s foil: its underside is as thick as the foil is there, thinning to
            the minimum where it turns up into the trailing edge. The profile may leave the base
            steeply at first, as long as the underside then runs further back than that rise. It
            counts as a raised rear only if it turns up into the trailing edge within the lowest
            quarter of the fin: higher up, a trailing edge sweeping gently back to a hooked tip is a
            trailing edge.
          </Term>
          <Term name="Minimum thickness">
            Nowhere thinner than {mm(FIN_MIN_THICKNESS)} by default — edges and tip included — so
            the fin is safe to bump into and something a cutter can make. Set it higher, up to{' '}
            {mm(FIN_MIN_THICKNESS_LIMITS.max)}, in the thickness view&apos;s{' '}
            <strong>Min thickness</strong> box: it is saved with the fin, and the thickness
            curve&apos;s tip follows it, as does any of the curve below it. The foil is shaped to
            the thickness curve less this, and this is added all the way along, so the faces stay
            curved right to edges that end at the minimum. A sharp bend in the profile — a hooked
            tip, say — reshapes the blade only near that edge, rather than creasing it right across.
            Never under {mm(FIN_MIN_THICKNESS)}, enough edge for CAD to read the surface as closed.
            Exports can thicken it further (see <a href="#export">Export min</a>).
          </Term>
          <Term name="One clean shape">
            The edges keep rising to a single tip, and the foil&apos;s faces never cross.
          </Term>
        </Terms>
      </Section>

      <Section id="files" title="Saving your work">
        <p>
          The fin saves itself in your browser as you work, so a reload or a closed tab doesn&apos;t
          lose it. <strong>Save</strong> ({shortcutKeys('save')}) writes it as a{' '}
          <code>.fin.json</code> file to keep or share; <strong>Open…</strong> loads one back. The
          designer works offline.
        </p>
        <p>
          Save, and each Export, opens a dialog first. Name the file there (the extension is added
          for you) and choose where it goes. In Chrome and Edge on a computer,{' '}
          <strong>Choose folder…</strong> picks a folder, which is offered again next time; the
          browser asks once a visit before the page may write to it, and the dialog warns before it
          replaces a file of the same name. <strong>Use Downloads</strong> goes back to the
          browser&apos;s downloads folder. Other browsers, and tablets and phones, save to the
          downloads folder: to be asked where each time, turn on the browser&apos;s own &ldquo;ask
          where to save&rdquo; setting. The name you type is offered again until you open or start
          another fin.
        </p>
        <p>
          For a side, quad-rear or canard fin, tick <strong>Left and right fin</strong> in the
          Export menu to write a matched pair: each Save or Export then writes two files, the fin
          and its mirror for the other side (offered as <code>fin-side-left</code> and{' '}
          <code>fin-side-right</code>
          ), each named in the dialog. Your browser may ask once to allow more than one download.
          The choice is remembered on this device.
        </p>
      </Section>

      <Section id="panel" title="Fitting in a panel">
        <p>
          Fins are machined from panels (G10 and the like), so the panel&apos;s thickness limits the
          whole fin: blade and tab together. Set the panel&apos;s thickness in{' '}
          <a href="#settings">File settings</a> and the app checks the fin as it will be exported
          (at the export minimum), in three dimensions.
        </p>
        <p>
          The status bar says what panel the fin needs, tab included. When that&apos;s more than the
          panel, an orange chip at its right says so; open it for the details and Fit to panel. A
          warning only: the fin still exports.
        </p>
        <p>
          To see it, press <strong>Panel fit</strong> beside the 3D view. The view swings round
          behind the fin and looks along the panel, all but flat, like a drawing, with the
          panel&apos;s outline round the whole fin: slate when tab and blade fit inside it, orange
          when not. You can still orbit; Panel fit again goes back to the view beside the fin.
        </p>
        <p>
          A cambered foil, its inside face curved, can need a thinner panel turned a little in it:{' '}
          <strong>Panel angle</strong>, in the foil view, turns the fin in the panel, seen from
          above (±45°), and the Panel fit view turns with it. A foil with a flat inside face already
          fits best lying straight.
        </p>
        <p>
          Cant leans the blade out from its upright tab, so a canted fin (a Futures side fin, or an
          FCS fin with a control section that adds cant) sticks out of a panel standing upright.{' '}
          <strong>Tilt</strong>, in the Panel fit view, leans the panel toward the fin&apos;s
          outside face (±45°), so it runs diagonally between the tab and the leaning blade; the{' '}
          <strong>Cant</strong> field beside it lets you work the lean into the panel.{' '}
          <strong>Fit to panel</strong>, in the foil view or the Panel fit view, turns and tilts the
          fin together to fit the thinnest panel, as one undo step. The angle and tilt are only a
          check, saved with the fin: the fin and its STEP and STL files don&apos;t change.
        </p>
      </Section>

      <Section id="import" title="Importing drawings">
        <p>
          <strong>Open…</strong> also has <strong>Import vector outline</strong> and{' '}
          <strong>Import vector foil</strong>, for SVG and EPS files. After you pick a file, say
          whether it faces left or right: a right-facing drawing is flipped, so the leading edge
          ends up on the left as in the views. Every point and handle in the file comes in, ready to
          edit, and Undo takes it back. If a file holds several shapes, the largest is used.
        </p>
        <Terms>
          <Term name="Profile from a fin">
            <strong>Import profile from fin…</strong> takes the profile from another fin&apos;s{' '}
            <code>.fin.json</code> file, exactly as drawn, for a set of fins that share a shape: a
            centre fin&apos;s profile for the side fins, say. Only the profile changes. This
            fin&apos;s tab, foils, thickness and side stay as they are, and the profile is placed on
            this fin&apos;s tab, the views re-fitting to it. Then size it with{' '}
            <a href="#outline">Scale</a>: the side fins of a thruster are usually bigger than the
            centre. If it is too big or small for this tab, the status bar says so until Scale puts
            it right. Undo takes it back.
          </Term>
          <Term name="Outline">
            Replaces the profile, placed on the current tab, at the drawing&apos;s own size, and the
            views re-fit to it. Then size it with <a href="#outline">Scale</a> in the profile view,
            by eye or against a ghost of the drawing. A drawing too big or small for the tab still
            comes in: the status bar says what is wrong, and export waits until scaling puts it
            right. Draw it closed along the base, or open with both ends at the bottom. A drawing
            that isn&apos;t a fin profile, such as one whose leading edge turns back down, is
            refused, and the dialog says why.
          </Term>
          <Term name="Foil">
            Replaces the base foil. A closed shape is cut at its leading and trailing edges into two
            faces, the upper one the outside, and turned level if it was drawn at an angle. An open
            line becomes the outside face over a flat inside. A centre fin takes the upper face,
            mirrored. Only the shape counts: the size comes from the profile and the thickness
            curve.
          </Term>
          <Term name="Ghost">
            The ghost icon at the top left of the profile and foil views brings in a drawing as a
            half-transparent reference to trace over. Right-drag anywhere in the view to move it (or
            drag the dot at its centre, on a tablet), and drag the dot at its corner to scale it;
            the × beside the icon removes it. A ghost is not part of the fin: it isn&apos;t saved
            and isn&apos;t exported.
          </Term>
        </Terms>
        <p>An EPS must be saved uncompressed, with any text converted to outlines.</p>
      </Section>

      <Section id="settings" title="File settings">
        <p>
          The gear button at the right of the top bar opens File settings. Changes apply straight
          away and are remembered in this browser.
        </p>
        <Terms>
          <Term name="Units">
            Millimetres, or inches shown to the nearest 1/16, 1/8, 1/4 or 1/2 inch. Fields show
            decimal inches; you can type fractions such as 3/8 or 1 1/4. Exported files are always
            in millimetres.
          </Term>
          <Term name="Grid">
            The profile view&apos;s grid: Auto (it follows the zoom), or 1, 5 or 10 mm, or 1/8, 1/4,
            1/2 or 1 inch. Zoomed far out, a fixed grid draws every second or fourth line rather
            than a solid block, still on multiples of its size. Changing the units sets it back to
            Auto.
          </Term>
          <Term name="Panel">
            The thickness of the panel the fin is machined from, saved with the fin (empty for none;
            see <a href="#panel">Fitting in a panel</a>).
          </Term>
          <Term name="Export">
            The export minimum thickness (see <a href="#export">Export min</a>).
          </Term>
          <Term name="Export core">
            The laminate thickness per face, which faces it goes on, and whether it wraps the tab:
            what Export core… starts from (see <a href="#export">Core</a>).
          </Term>
        </Terms>
      </Section>

      <Section id="export" title="Exporting for CNC and printing">
        <p>
          <strong>Export</strong>, at the right of the top bar, opens a menu: STEP for CNC, STL for
          3D printing, a core to laminate over, or the profile as an SVG drawing.
        </p>
        <Terms>
          <Term name="Export min">
            The thinnest the exported fin gets, set in <a href="#settings">File settings</a>:{' '}
            {mm(FIN_EXPORT_MIN_THICKNESS.default)} by default, from{' '}
            {mm(FIN_EXPORT_MIN_THICKNESS.min)} to {mm(FIN_EXPORT_MIN_THICKNESS.max)}. STEP, STL and
            core exports thicken the edges and tip to at least this in the file, the thickest point
            staying on your thickness curve; the design itself keeps its own minimum (see{' '}
            <a href="#rules">Minimum thickness</a>), so you can see the fin as it will be once
            sharpened. Never under the fin&apos;s own minimum. Some 3D printing materials can&apos;t
            hold a wall under 1 mm; for a CNC file with the edges as designed, set it to{' '}
            {mm(FIN_MIN_THICKNESS)}. Remembered on this device.
          </Term>
          <Term name="STEP">
            For CNC. True curved surfaces, in millimetres: the blade and the tab as two solids that
            meet on the tab top. In Fusion 360 or similar, Combine / Join them into one body before
            machining. Within 0.05 mm of the design, except the last millimetre or two under the
            tip. The surface stays smooth across corners in the profile: only the edge has the
            corner.
          </Term>
          <Term name="STL">
            For 3D printing. A fine triangle mesh in millimetres, the unit slicers assume.
          </Term>
          <Term name="Core (for laminating)">
            For a printed fin that gets laminate vacuum-bagged onto it, such as unidirectional
            carbon to stiffen the base so it doesn&apos;t snap under load. Export core… asks for the
            laminate&apos;s thickness per face (one ply of 200 gsm uni is about 0.20–0.25 mm; add
            plies up) and which faces it goes on: outside, inside or both. The blade is made thinner
            by that much on those faces, so with the laminate on it matches your design, and
            exported as STEP or STL in files ending <code>-core</code>. It never goes under the
            Export min. A laminated face is always thinned by the full laminate, edges included, so
            a flat inside face stays flat and flush with a wrapped tab. Near the edges, where the
            blade is already close to the minimum, the face with less laminate is left thicker to
            make it up (the bare face if only one is laminated; half each if both are equally), so
            the edges come out a little thicker on that side once laminated. The tab is unchanged
            unless you tick Include the tab: then the laminate wraps over the base, where the fin
            leaves the box (a likely snap point in PLA and similar), and the tab&apos;s laminated
            faces are thinned by the same amount so it still fits the box. That suits a flat inside
            face, which runs straight on into the tab; the outside usually meets the tab at too
            sharp a step for laminate to follow.
          </Term>
          <Term name="Profile as SVG">
            The profile alone, as a drawing at full size in millimetres, the front on the left and
            the base closing the shape along the bottom, for a drawing program or another shaper.
            One file, which a left and a right fin share. Every point and handle is kept, so{' '}
            <a href="#import">Import vector outline</a> (facing left) brings back the same profile;
            for your own fins, Import profile from fin is quicker.
          </Term>
        </Terms>
        <p>
          STEP, STL and core exports are unavailable while the fin has a problem; the status bar
          lists it. The profile can always be exported.
        </p>
        <p>
          Exported files are made on your device; nothing is uploaded. Each names OpenFinShaper as
          the program that made it, in the STEP file&apos;s header and the STL file&apos;s 80-byte
          title. See <Link to="/privacy">Privacy</Link> for what the site itself measures.
        </p>
      </Section>
    </DocsPage>
  );
}
