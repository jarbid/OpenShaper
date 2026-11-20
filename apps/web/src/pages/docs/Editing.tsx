// SPDX-License-Identifier: GPL-3.0-or-later
import { Link } from 'react-router-dom';
import { RAIL_PRESETS } from '@openshaper/kernel';
import { BUILT_IN_RAILS, DECK_SHAPES } from '@openshaper/store/rails';
import type { ReactNode } from 'react';
import { NUDGE, shortcutKeys } from '../../shortcuts';
import { SHAPE_NOTES, shapeLabel } from '../../workspace/deck-panel';
import { DESIGN_STEPS, PANEL_ENTRIES, type PanelId, type StepId } from '../../workspace/steps';
import { DocsPage, Section, Term, Terms } from './DocsPage';

/**
 * What each workspace step shows and what it does to the sidebar. A `Record` over the step ids, so a
 * step added to `workspace/steps.ts` does not type-check until it is described here.
 */
const STEP_DOCS: Record<StepId, ReactNode> = {
  outline: (
    <>
      The plan shape, in the outline editor, with the fins drawn on it. The sidebar opens the tools
      the Outline view opens: Control point, Board shape, Analysis and Trace image.
    </>
  ),
  rocker: (
    <>
      The profile: the deck line and the bottom line, in the rocker editor. The sidebar opens
      Control point, Analysis, Trace image and Bottom features.
    </>
  ),
  deck: (
    <>
      The <strong>slice</strong> at the chosen station, to scale, with the deck curve and one
      handle, the crown, and under it the <strong>station strip</strong>: every station along the
      board, to add, move or remove. The right-hand column opens with the{' '}
      <strong>deck panel</strong>: the deck&rsquo;s shape, Flat or Domed, and the crown dial.{' '}
      <em>Edit curve</em> shows the curve&rsquo;s own knots and handles in the cross-section editor.
      See <a href="#deck-step">The Deck step</a> below for all of it.
    </>
  ),
  bottom: (
    <>
      The same drawing, editing the station&rsquo;s bottom curve. The Shape tab opens with Bottom
      features, which cut a vee, a concave or channels into the bottom.
    </>
  ),
  rails: (
    <>
      The <strong>rail map</strong>: the board&rsquo;s rail laid out straight, tail to nose, as
      coloured zones with blends between them, and under it the board&rsquo;s section at the cursor,
      to scale. The right-hand column opens with the <strong>rail panel</strong>, above the sidebar.
      See <a href="#rails-step">The Rails step</a> below for all of it.
    </>
  ),
  tail: (
    <>
      The outline again, for the tail. The Shape tab opens with Board shape, where the tail type
      (standard, swallow or fish), the symmetry and the notch depth are set.
    </>
  ),
  fins: (
    <>
      The outline with the fins drawn on it. The Build tab opens with Fins: the setup, the system
      and each fin.
    </>
  ),
};

/** The three entries under the divider of the list, which are tabs of the sidebar and not steps. */
const PANEL_DOCS: Record<PanelId, ReactNode> = {
  specs: <>The Specs tab: length, width, thickness, volume, centre of mass and the rest.</>,
  build: <>The Build tab: Board info, Fins and the weight estimate.</>,
  compare: (
    <>
      The Reference tab, where the comparison with a ghost board is (see{' '}
      <Link to="/docs/specs#ghost">comparing two boards</Link>); it has nothing to compare until a
      ghost is loaded with <em>Board &rsaquo; Open ghost&hellip;</em>.
    </>
  ),
};

export default function DocsEditing() {
  return (
    <DocsPage
      route="/docs/editing"
      title="Editing a board"
      lede="Control points, tangent handles, the views, and how cross-sections interpolate."
      toc={[
        { id: 'views', label: 'The views' },
        { id: 'workspace', label: 'The workspace (rails boards)' },
        { id: 'rails-step', label: 'The Rails step: zones and blends' },
        { id: 'deck-step', label: 'The Deck step: shapes and the crown' },
        { id: 'guides', label: 'Guides in 3D' },
        { id: 'analysis', label: 'Surface analysis in 3D' },
        { id: 'nurbs', label: 'Experimental NURBS engine' },
        { id: 'board-shape', label: 'Asymmetric boards & tail types (NURBS)' },
        { id: 'bottom-features', label: 'Bottom features (NURBS)' },
        { id: 'points', label: 'Control points & tangents' },
        { id: 'locks', label: 'Locking handle angles' },
        { id: 'keyboard', label: 'Nudging from the keyboard' },
        { id: 'sections', label: 'Cross-sections' },
        { id: 'blank', label: 'Cross-sections stay inside the blank' },
        { id: 'rails', label: 'Rail presets' },
        { id: 'tail', label: 'Concave tails' },
        { id: 'undo', label: 'Undo & history' },
      ]}
    >
      <Section id="views" title="The views">
        <Terms>
          <Term name="Outline">
            The plan shape, seen from above. Mirrored about the stringer, so you edit one half and
            both update.
          </Term>
          <Term name="Rocker">
            The profile from the side: two curves, deck and bottom. The gap between them is the
            thickness flow.
          </Term>
          <Term name="Cross-section">
            One station across the board, rail to rail. Use{' '}
            <code>{shortcutKeys('cross-section-prev')}</code> and{' '}
            <code>{shortcutKeys('cross-section-next')}</code> to page through stations.
          </Term>
          <Term name="3D">
            The tessellated surface. Useful for spotting a bump you cannot see in a single profile.
          </Term>
        </Terms>
        <p>
          The quad view shows all four at once. Number keys switch views — see{' '}
          <Link to="/docs/shortcuts">shortcuts</Link>. Phones do not get the quad view: four panes
          in that width leaves none of them usable, so a phone opens on the outline and switches
          between the single views instead.
        </p>
        <p>
          <strong>Split view</strong> is the middle ground: two full-width panes, one above the
          other, each with a picker where its title would be — so you can put the outline over the
          rocker, or the outline over a cross-section, and read both at full window width. Picking
          the pane the other half is already showing swaps the two rather than doubling it up. The
          pairing is remembered between sessions. Split is a desktop layout only: halving the height
          of a tablet or phone window leaves two panes too short to work in, so the tab and its
          number key are not offered below 1024px wide.
        </p>
        <p>
          With a mouse there is a shortcut that skips the tabs:{' '}
          <strong>double-click a pane title</strong> in the quad view to blow that pane up to the
          full viewport, and double-click the title again to drop back to quad. The controls in the
          title bar are unaffected — only the title itself switches views.
        </p>
        <p>
          On a touch screen, outline and rocker are drawn <strong>nose-up</strong> whenever the pane
          is taller than it is wide — which on a phone held upright it is. A board is about four
          times longer than it is wide, so lying it across a narrow pane wastes most of the height;
          standing it up trades that for about half as much again in size. Turn the phone sideways
          and the board lies down again, because a wide pane already fits it the better way round.
          Nothing to set, and it never applies to the cross-section view, which is already the shape
          of its pane.
        </p>
        <p>
          Right-click clear space in any 2D view and choose <strong>Set reference curve</strong>
          to capture its current curves. A faint copy stays underneath as you edit, revealing the
          original shape wherever the live curves move away. Choose the option again to replace the
          reference, or choose <strong>Clear reference curve</strong> to remove it. References are
          temporary: one lasts while its view stays open, is cleared when you move to another
          cross-section, and is never saved with the board.
        </p>
        <p>
          Turn on <strong>Tunni controls</strong> from the <strong>View</strong> menu, or
          right-click a 2D view and check <strong>Show Tunni controls</strong>, to adjust both
          handles of a curve segment together. Drag the amber dashed line to scale the handles
          together, or drag its diamond to adjust their balance and strength. The curve endpoints
          and tangent directions stay fixed. Double-click the diamond to balance the handles.
          Controls are hidden for degenerate geometry, and a drag holds its last valid shape while a
          handle would cross its endpoint. The setting applies to every 2D view and stays on as you
          switch views and cross-sections; each drag is one undo step. Controls appear only on the
          editable half of mirrored views.
        </p>
      </Section>

      <Section id="workspace" title="The workspace (rails boards)">
        <p>
          With a rails board open the editor is laid out as a <strong>workspace</strong> in place of
          the row of view tabs. On the left is the <strong>design list</strong>, the steps of a
          board in the order a shaper works. Beside it, the board in 3D is always on screen, with
          its look controls; under the board is the drawing for the chosen step; and the sidebar
          stays on the right. Everything it edits is the same board, in the same editors, as in the
          tabbed layout: only the arrangement changes.
        </p>
        <p>
          <strong>Turning it on.</strong> The workspace belongs to the experimental rails board. In{' '}
          <em>Settings &rsaquo; Experimental</em> turn on both{' '}
          <strong>Engine: NURBS (experimental)</strong> and{' '}
          <strong>Rails engine (experimental)</strong>: the open board becomes a rails board and the
          workspace opens. Opening a rails board file, or a share link to one, turns both on for
          you. With the rails engine off nothing about the editor changes, and a phone always keeps
          the view tabs: the workspace is for a tablet or larger.
        </p>
        <p>
          <strong>Look and Show.</strong> Over the board, two buttons. <strong>Look</strong> says
          how the board is painted, with a swatch of its colour, and opens a menu in three groups.{' '}
          <em>Shaping</em> holds Patches. <em>Surface</em> holds the analysis modes described under{' '}
          <a href="#analysis">Surface analysis in 3D</a>: Zebra, Mean curvature, Gaussian curvature,
          Rail radius, Normal change (approx.), Slope and Deviation from ghost, with the deviation
          band beside the button while it is chosen. <em>Realistic</em> holds Glassed gloss, Raw
          foam and Matte, and under them the <em>Light</em> (Studio, Shaping bay or Neutral) and the
          Board colour. The light and the colour are settings of their own: they light the realistic
          looks and Patches, choosing either leaves the look as it is, and a surface analysis is
          painted in its own colours. A look that cannot be drawn stays in the list, disabled, with
          the reason beside it: the three exact curvature modes on a concave tail, Deviation from
          ghost with no ghost loaded.
        </p>
        <p>
          <strong>Show</strong> holds what is drawn over the look. The <em>Guides</em> are the{' '}
          <a href="#guides">Stringer, the Stations (the sections&rsquo; rings) and the Apex line</a>
          , and they are drawn over every look. <em>Wireframe</em> is Off, Over the surface or
          Alone, and <em>Normals</em> colours the surface by which way it faces. The wireframe and
          the normals show on the realistic looks only: Patches and the surface analyses paint the
          board themselves, so under them those four entries are listed disabled, with the reason.
          The <em>Mesh quality</em> (Draft, Standard or Fine) is the density of the mesh the board
          is drawn with. Both menus open with a click, or with Enter or the down arrow on the
          button; the up and down arrows, Home and End move through them, Enter or Space chooses,
          and Escape, Tab or a click outside closes them and returns focus to their button. A choice
          of a look closes the menu; the switches and settings in it leave it open for the next.
        </p>
        <p>
          <strong>The status line.</strong> A quiet line over the top left of the board says what a
          tap does (<em>Tap the board to choose a patch</em>, or the part you chose, in your display
          unit) and, only while it is true, that the board is being built or that an edit was
          refused. Its <strong>i</strong> button opens the details of the build: the volume, how
          closely the stations were fitted and any warnings, which it counts beside it. Where a
          surface analysis has its legend in the top left, the line moves to the bottom left. The
          workspace always shows the NURBS surface of your own board, so the{' '}
          <strong>Classic / NURBS</strong> switch and the <strong>Test board</strong> menu of the
          tabbed layout are not drawn here; a choice made in them is ignored in the workspace and
          kept for the tabbed layout. A saved <em>Deviation from classic</em> is not a look the
          workspace offers: it reads as the realistic look of the material, and stays saved until
          you choose a look.
        </p>
        <Terms>
          {DESIGN_STEPS.map((step) => (
            <Term
              key={step.id}
              name={
                <>
                  {step.label}{' '}
                  <kbd className="rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-xs text-foreground">
                    {step.key}
                  </kbd>
                </>
              }
            >
              {STEP_DOCS[step.id]}
            </Term>
          ))}
        </Terms>
        <p>
          Under a divider the list also has three entries that are not steps. Each shows a tab of
          the sidebar and leaves the drawing as it is; the list marks the one whose tab is showing.
        </p>
        <Terms>
          {PANEL_ENTRIES.map((panel) => (
            <Term key={panel.id} name={panel.label}>
              {PANEL_DOCS[panel.id]}
            </Term>
          ))}
        </Terms>
        <p>
          <strong>Choosing a step.</strong> Click it in the list, or press its number key. The
          number keys <kbd>1</kbd> to <kbd>7</kbd> choose the steps in the order above while the
          workspace is showing; they are the view keys of the tabbed layout, which do nothing here
          (see <Link to="/docs/shortcuts">shortcuts</Link>). In the list, the up and down arrows
          move through the entries, Home and End go to the ends, and Enter chooses. Choosing a step
          does not move the 3D camera. The sidebar follows the step through the same rules as the
          view it is for: its sections open and shut for it, never against one you opened or shut
          yourself.
        </p>
        <p>
          <strong>Tapping the board.</strong> With the Patches look on, a tap on the board chooses
          the step that edits what was tapped: the deck chooses Deck, and the station nearest the
          tap, the bottom Bottom, a rail Rails, the straight edge of a tail Tail, and a corner
          chooses Tail when it is in the tail half of the board and Outline when it is in the nose
          half. The tapped patch stays lit, and a tap on nothing changes no step. The first time the
          workspace opens the board wears the Patches look, if the 3D look was at No analysis (a
          realistic look); choose another look with the Look button and it stays chosen.
        </p>
        <p>
          <strong>The divider.</strong> Drag the bar between the board and the drawing, or focus it
          and press the arrow keys to move it 2% at a time, or Home and End to take it to its
          limits. It stays between a quarter and three quarters of the height. The step, the divider
          and the first-open look are remembered between sessions.
        </p>
        <p>
          <strong>On a tablet.</strong> Below 1024px wide the list is a column of icons, whose names
          are their tooltips, and the sidebar is the bottom sheet; choosing Specs, Build or Compare
          raises the sheet. The board and the drawing stack as they do on a desktop.
        </p>
      </Section>

      <Section id="rails-step" title="The Rails step: zones and blends">
        <p>
          A board&rsquo;s rail is not one shape: it changes from the tail to the nose. The Rails
          step draws that change as a strip, the <strong>rail map</strong>, and the panel beside it
          sets the rail of the part you choose. Tap a rail on the 3D board, or click the strip, to
          choose; what is chosen is lit on the board.
        </p>
        <Terms>
          <Term name="Zone">
            A stretch of the board where the rail is one design. It is drawn as a block in a colour,
            named for its rail, and the board&rsquo;s rail is that colour in 3D: the first zone from
            the tail is orange, the next sky blue, then green, vermillion, yellow and blue, and
            round again. A zone of no length is one place along the board and is drawn as a thin
            tick; a board opened from an older file arrives as a row of ticks, one for each of its
            stations.
          </Term>
          <Term name="Blend">
            The gap between two zones, where the rail eases from one design to the other. It is
            drawn as a gradient between the two colours. A blend has no settings of its own: it is
            where one zone ends and the next begins, so move those ends to change it.
          </Term>
          <Term name="Rail">
            What a zone holds: a name and a few numbers. The panel shows three dials, Apex, Tuck and
            Edge, and, under More, the rest.
          </Term>
        </Terms>
        <h3 className="mt-4 text-base font-semibold">The rail map</h3>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>Choose</strong> a zone or a blend by clicking it. Clicking the ruler above the
            strip moves the cursor, which is where the slice below is taken, and chooses nothing.
          </li>
          <li>
            <strong>Move a zone&rsquo;s end</strong> by dragging the handle at it. A zone cannot be
            dragged closer than a centimetre to its neighbour. A tick has one handle, which moves
            it; while the tick is chosen a grip beside it draws it out into a zone of length.
            Dragging is one undo step.
          </li>
          <li>
            <strong>Add a zone</strong> by pointing at the strip and clicking the + that follows the
            pointer, or with a touch screen or a keyboard by moving the cursor and pressing{' '}
            <em>Add zone</em> (or Enter on the ruler). In a zone the zone splits: the part toward
            the nose is the new zone, and it starts as the same rail, so the board does not change
            until you give it one. In a blend a zone of no length appears, holding the rail the
            board has there. A tick cannot be split.
          </li>
          <li>
            <strong>Remove a zone</strong> with Delete, or <em>Delete zone</em> in the panel; its
            neighbours blend across the gap. The last zone is never removed.
          </li>
          <li>
            <strong>Left and right.</strong> While the two sides have the same rail there is one
            lane. When they differ, or you are editing one side alone, there are two, Left over
            Right, each with its own zones.
          </li>
          <li>
            <strong>Keyboard.</strong> The strip is one tab stop; the arrow keys move the choice
            along the zones and blends, Up and Down change lane, Home and End go to the ends, and
            Delete removes the chosen zone. A zone&rsquo;s end handles are sliders: the arrow keys
            move one by 0.5 cm, with Shift by 5 cm. The ruler is a slider for the cursor with the
            same keys.
          </li>
        </ul>
        <h3 className="mt-4 text-base font-semibold">The slice</h3>
        <p>
          Under the map, the board&rsquo;s closed section at the cursor, drawn to the scale of the
          board so the width and thickness are the real proportions, with the stringer, the half
          width and the thickness in your display unit, and a marker at the rail&rsquo;s apex. When
          the cursor is in a blend it says which zones it is between and how far across. In the
          panel, a small slice shows the chosen zone&rsquo;s own rail at the zone&rsquo;s start,
          with the section at its end dashed behind it.
        </p>
        <h3 className="mt-4 text-base font-semibold">The rail panel</h3>
        <Terms>
          <Term name="Rail">
            The menu of the built-in rails (listed below), then your own, then Custom, which is
            shown when the zone&rsquo;s numbers match no named rail and says which is nearest, as in
            &ldquo;Custom (like Tucked)&rdquo;. Choosing one sets the zone&rsquo;s rail.
          </Term>
          <Term name="Sides">
            <em>Both sides</em> edits the zone on both sides of the board. <em>Left</em> or{' '}
            <em>Right</em> edits that side alone; on a board whose sides were one, that gives the
            other side a rail of its own, starting as a copy. Choosing <em>Both sides</em> again
            when the sides are the same makes them one again; when they differ the panel says so and
            offers <em>Make both sides like Left</em> or <em>like Right</em>.
          </Term>
          <Term name="Apex">
            Where the widest point of the rail sits between the bottom and the deck, from 40/60
            (more of the rail above it) to 80/20 (a low, down rail). Type it as 60/40 or as a
            percent up from the bottom.
          </Term>
          <Term name="Tuck">
            How far in from the outline the bottom starts to turn under, from none to deep (4 cm).
            It is typed in your display unit.
          </Term>
          <Term name="Edge">
            The angle the rail leaves the bottom at, from none (0°) to hard (60°).
          </Term>
          <Term name="More">
            Band width, hardness, tuck shape and the deck-side edge, and where the zone starts and
            ends, so a zone can be placed by number. It stays open if you leave it open.
          </Term>
        </Terms>
        <p>
          Each dial is a slider with a number: drag it, press the arrow keys (a held key is one undo
          step), or type a number and press Enter; Up and Down in the number step it. A rail from an
          older file can be past the end of a dial: its number is shown and kept until you move the
          dial. Every edit is one undo step with its own name in the history: <em>Edit rail</em>,{' '}
          <em>Move rail zone</em>, <em>Add rail zone</em>, <em>Remove rail zone</em>,{' '}
          <em>Tidy rails</em>, <em>Unlock rail sides</em> and <em>Link rail sides</em>.
        </p>
        <h3 className="mt-4 text-base font-semibold">The built-in rails</h3>
        <Terms>
          {BUILT_IN_RAILS.map((r) => (
            <Term key={r.id} name={r.name}>
              {r.summary}
            </Term>
          ))}
        </Terms>
        <h3 className="mt-4 text-base font-semibold">My rails</h3>
        <p>
          <em>Save as my rail</em> keeps the zone&rsquo;s rail under a name you give it. It is then
          in the Rail menu on every board you open in this browser, and you can rename it or remove
          it from under the menu. A board that uses one of your rails carries it in its file, so
          opening that board on another machine brings the rail with it; if you already have a rail
          of that name with other numbers, the one that came with the board is kept as, say,
          &ldquo;Surf (2)&rdquo;. A board that uses none of them is saved exactly as before.
        </p>
        <h3 className="mt-4 text-base font-semibold">Tidy rails</h3>
        <p>
          <em>Tidy rails</em> joins neighbouring zones whose rails differ by less than 1 mm of band
          or tuck, a tenth of a degree of edge and a tenth of a ratio (apex, hardness, tuck shape):
          less than can be seen on a board, so a board from an older file, with a rail at each
          station, comes down to the few zones it really has. It says how many zones it joined, and
          is one undo step.
        </p>
      </Section>

      <Section id="deck-step" title="The Deck step: shapes and the crown">
        <p>
          The Deck step is about the curve the deck makes across the board at one station: how it
          falls from the stringer to the rail. It draws that station&rsquo;s <strong>slice</strong>{' '}
          with the deck curve on it, under it the <strong>station strip</strong>, and the panel
          beside it names the deck&rsquo;s shape and has one dial, the crown. The shape is read off
          the curve and never stored, so a deck you draw stays yours: nothing is replaced unless you
          choose a shape.
        </p>
        <Terms>
          {DECK_SHAPES.map((shape) => (
            <Term key={shape} name={shapeLabel(shape)}>
              {SHAPE_NOTES[shape]}
            </Term>
          ))}
          <Term name="Custom">
            {SHAPE_NOTES.custom} It is a name, not a choice: the menu offers Flat and Domed. Every
            deck of the starter templates and the made boards is Custom to begin with, because each
            rolls over faster than a dome near its rail.
          </Term>
        </Terms>
        <h3 className="mt-4 text-base font-semibold">The crown</h3>
        <p>
          The <strong>crown</strong> is how far the deck falls from the stringer to the place where
          the rail starts to roll over it, the rail&rsquo;s band edge: the half width less the
          rail&rsquo;s band at that station. Lay a straightedge across the deck from one band edge
          to the other and the crown is the gap under it at the stringer. It is shown in your
          display unit, as a number you can type, a slider, the arrow keys (a millimetre a press in
          centimetres, ten with Shift) and a handle on the slice that you drag up and down. All four
          are one dial, and a drag or a held key is one undo step.
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>Its range</strong> runs from half a millimetre to the most the station holds:
            the deck keeps a millimetre above the bottom where it meets the rail, and is no steeper
            than 60 degrees there. The engine itself would build a closed board right down to a deck
            level with the bottom. A crown typed or dragged past the most is held at the most, and
            the panel says so; it is never refused.
          </li>
          <li>
            <strong>What is typical</strong> on the boards of the project: a crown of 1.2 to 2.5 cm
            over the thick part of a board (6 to 7.5 cm at the stringer), which is 25 to 45 percent
            of the thickness there. A Flat deck made Domed falls 50 percent of the thickness at the
            rail at each station, the median of the 47 stations measured (28 to 68 percent): a crown
            of about 2.5 cm on a shortboard.
          </li>
          <li>
            <strong>The rail</strong> goes on being measured from the same band: change the
            rail&rsquo;s band in the Rails step and the crown, which is read at the band edge, reads
            a little different, while the deck is still Domed. The dome goes on past the band edge
            to the rail, so the deck&rsquo;s height there sets how full the rail is: a flatter deck
            makes a fuller rail. Near the tips, where the engine narrows the band, the crown is read
            at the band as the rail&rsquo;s numbers give it.
          </li>
          <li>
            <strong>Off</strong> for a Flat deck, which has none, and for a Custom one, where a
            crown would replace the curve you drew. The panel says which, in a sentence, and the
            handle on the slice is drawn off.
          </li>
        </ul>
        <h3 className="mt-4 text-base font-semibold">Choosing a shape</h3>
        <p>
          Choosing Flat or Domed replaces the deck curve at once, with no question: the undo is the
          way back, and brings a drawn curve back exactly. Choosing Domed on a drawn deck keeps the
          crown the deck has at each station and makes the curve the dome through it, so the board
          changes least; on a Flat deck it gives the typical crown. A station too thin to hold a
          crown, such as the very tip, stays Flat. Both sides of an asymmetric board get the shape,
          and a crown typed reaches both as the same number.
        </p>
        <h3 className="mt-4 text-base font-semibold">All stations or this one</h3>
        <p>
          Under <em>More</em>, <em>Apply to</em> says how far a shape and a crown reach. It starts
          as <strong>All stations</strong>, since a board&rsquo;s deck is usually one shape from
          tail to nose. A crown you type is the chosen station&rsquo;s, and every other station
          falls the same share of its own thickness at the rail, so the whole board has one curve
          and the tips keep their rails: the same number of centimetres at every station would take
          the rail to nothing where the board is thin, and so would the same share read at the band
          edge where the band is wide beside the half width, as at the nose end of some boards.{' '}
          <strong> This station</strong> changes the chosen station alone and the deck blends
          between it and its neighbours. The choice is not remembered between sessions.
        </p>
        <h3 className="mt-4 text-base font-semibold">Edit curve</h3>
        <p>
          <em>Edit curve</em>, in the slice&rsquo;s header and under <em>More</em>, shows the deck
          curve&rsquo;s own knots and handles in the cross-section editor, for the station you have
          chosen, and the button takes you back to the shape&rsquo;s one handle. Moving a knot or a
          handle makes the deck Custom and the panel says so; a Custom curve is always shown with
          its knots. Choosing a shape again replaces it.
        </p>
        <h3 className="mt-4 text-base font-semibold">The station strip</h3>
        <p>
          Under the slice, every station as a tick, tail to nose, to the scale of the board and in
          your display unit, the chosen one marked; the slice is the section there.
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>Choose</strong> a station by tapping its tick, or the strip beside it for the
            nearest. A tap on the board&rsquo;s deck chooses the station nearest the tap, and{' '}
            <kbd>[</kbd> and <kbd>]</kbd> step through the stations as they always have.
          </li>
          <li>
            <strong>Move</strong> a station by dragging its tick. It is held between its neighbours,
            so a drag never turns into the edit of another station. Its curves are kept, and take
            the width and thickness of the place it moves to. One undo step.
          </li>
          <li>
            <strong>Add</strong> a station with the <em>+</em> that appears under the mouse between
            ticks, or with <em>Add station</em>, which adds one midway between the chosen station
            and the next (or the nose). Its curves follow its neighbours&rsquo;: where they have
            different numbers of knots the curve with fewer is given the knots it lacks, without
            changing its shape, and the two are blended. On the nine boards measured, as shipped and
            with every deck made Flat or Domed, that moves the surface by at most 1.4 mm, and by
            under 1 mm as shipped. The new station is chosen.
          </li>
          <li>
            <strong>Remove</strong> the chosen station with <em>Remove station</em> or Delete. A
            board keeps at least two stations; below that the button is off and says why.
          </li>
          <li>
            <strong>By keyboard</strong>, with a tick focused: the arrow keys, Home and End choose,
            Enter and Space choose the tick you are on, Delete removes the chosen station, and Shift
            with an arrow moves it half a centimetre (five with Ctrl or Cmd too). With the crown
            handle focused, Down is more crown and Up is less. They are listed with{' '}
            <Link to="/docs/shortcuts">the other shortcuts</Link>.
          </li>
        </ul>
        <p>
          Every one of these is an undo step with its name in the history: <em>Flat deck</em>,{' '}
          <em>Domed deck</em>, <em>Deck crown</em>, <em>Add station</em>,{' '}
          <em>Move cross-section</em> and <em>Delete cross-section</em>.
        </p>
      </Section>

      <Section id="guides" title="Guides in 3D">
        <p>
          The 3D view can draw reference lines directly on the surface. Three buttons in the 3D
          controls toggle them independently; in the workspace they are the Guides in the{' '}
          <strong>Show</strong> menu, where Sections is called Stations and Apex is the Apex line.
        </p>
        <Terms>
          <Term name="Stringer">
            An amber line tracing the centreline: down the deck from nose to tail, and back along
            the bottom. Together they outline the stringer plane, so you read the rocker and the
            deck crown at the same time.
          </Term>
          <Term name="Sections">
            A red ring around the board at every cross-section, with the station you are currently
            editing drawn in cyan. Useful for judging whether your stations are spaced sensibly, and
            for seeing which one a change belongs to.
          </Term>
          <Term name="Apex">
            A dashed green line down each rail through the rail apex: the widest point of every
            section, where the rail stops facing down and starts facing up. It is the line that
            parts the deck from the bottom &mdash; where a CNC machine flips the blank to cut the
            other side. Where a rail has a truly vertical face, or one that dips in a hair between
            two level corners, the line runs down the middle of it; inside a swallow or fish notch
            it follows the outer rail. The rocker view can show the same line&rsquo;s height (Apex
            height, see <Link to="/docs/specs#overlays">Analysis overlays</Link>).
          </Term>
        </Terms>
        <p>
          The lines are computed from the same surface the mesh is built from, so they sit on the
          board rather than floating near it. All three toggles are remembered between sessions,
          along with the rest of the 3D appearance settings.
        </p>
      </Section>

      <Section id="analysis" title="Surface analysis in 3D">
        <p>
          The <strong>Surface analysis</strong> menu in the 3D controls repaints the hull to show
          its shape rather than its finish; in the workspace the same modes are the <em>Surface</em>{' '}
          group of the <strong>Look</strong> menu. Three modes are <em>exact</em>: they fit the hull
          with the same B-spline surface the <Link to="/docs/export">STEP export</Link> writes
          &mdash; within 0.15 mm of the 3D hull &mdash; and work out its curvature mathematically at
          every point, so what you see does not change with zoom or mesh quality. The rest are quick
          effects on the viewport mesh.
        </p>
        <Terms>
          <Term name="Patches">
            With the rails engine (Settings &rsaquo; Experimental), the board painted by its parts,
            still lit so it reads as a solid: the deck and the bottom each in a light, quiet grey
            (the deck the lighter), the tail&rsquo;s straight edge and the corners in their own
            colours, and the rail in a colour for each rail key along the board, blending from one
            to the next. Thin dark lines mark where one part ends and the next begins: along both
            edges of the rail, along its apex, and across it where the outline passes from one
            stretch to the next, at a corner or a tail&rsquo;s straight edge. The half of the rail
            below the apex, the tuck, is a little darker than the half above it. A key along the
            bottom of the 3D view names each colour, the rail&rsquo;s zones as Rail zone 1, Rail
            zone 2 and so on from the tail; its Key button folds it, and the choice is remembered.
            Tap the board to choose the patch under the pointer: it is lit, the rest goes a little
            quieter, a part of the rail also turns its two edge lines white, and the 3D view says
            what it is, in your display unit. Dragging to orbit does not choose; Escape, or a tap on
            the background, clears the choice.
          </Term>
          <Term name="Zebra">
            Stripes, as if a striped room were reflected in a glossed board. Stripes that run on
            smoothly mean a smooth surface; a kink in them is a crease.
          </Term>
          <Term name="Mean curvature">
            How much the surface bends, averaged over its two directions, and which way: red is
            convex (a domed deck, a rail), blue is concave (a bottom concave, a dished deck), grey
            is flat. Use it to judge how evenly the deck and bottom flow. The rails are usually
            beyond the scale and show solid red &mdash; read them with Rail radius.
          </Term>
          <Term name="Gaussian curvature">
            The two bends multiplied: red where the surface curves the same way in every direction,
            like a dome; blue on a saddle, curving up one way and down the other &mdash; where a
            concave runs out into the rail, or rocker meets a vee; grey where it is flat or bent one
            way only, like a cylinder. A fair board has broad, calm areas; blotches show where the
            shape twists.
          </Term>
          <Term name="Rail radius">
            The tightest radius of curvature at each point &mdash; the smallest circle that fits the
            surface there. Dark is tight, a hard or tucked edge, fading to light where the board is
            flat. Follow a rail from tail to nose to see where the edge hardens and softens.
          </Term>
          <Term name="Normal change (approx.)">
            The quick view: how fast the mesh normal turns from one pixel to the next. Rails and
            nose light up, but the picture changes as you zoom and with mesh quality, and it cannot
            tell a smooth join from a break &mdash; hence &ldquo;approx.&rdquo; It is the curvature
            view that works on a concave tail.
          </Term>
          <Term name="Slope">
            How far the surface faces away from straight up: deck and bottom one colour, the rails
            another.
          </Term>
          <Term name="Deviation from ghost">
            With a reference board loaded, how far your board lies from it at every point: red for
            more foam, blue for less. See <Link to="/docs/specs#ghost">Comparing two boards</Link>.
          </Term>
        </Terms>
        <p>
          <strong>Reading the exact modes.</strong> A legend in the corner of the 3D view shows the
          colour scale. Curvature is labelled as a radius in your display unit &mdash; &ldquo;as
          curved as a ball of this radius&rdquo; &mdash; and the scale fits itself to the board: it
          ends at the curvature that only the most curved fifth of the surface (by area) goes
          beyond, so a needle-sharp nose tip cannot wash the rest out to grey. Rail radius runs from
          the tightest two percent of the board to its median.
        </p>
        <p>
          <strong>Expect a band at every cross-section.</strong> The hull is lofted from one station
          to the next with a straight-line blend, so it changes direction slightly at each station
          instead of flowing through it &mdash; a real crease, however small. The exact modes show
          every one of them as a crisp line across the board where the colour jumps. That is not a
          drawing artefact: it is the shape the exports describe, and it is where a smoother loft
          would make a difference.
        </p>
        <p>
          An exact mode takes about a second to compute, in the background, so editing never waits
          for it. When you pick one, and after each edit, the 3D view shows the board shaded as
          normal with <em>Computing curvature&hellip;</em> in the corner until the result is ready.
          During a drag it waits until you let go.
        </p>
        <p>
          The fitted surface does not yet model a{' '}
          <Link to="/docs/editing#tail">concave (swallow or fish) tail</Link> &mdash; the same limit
          as STEP export &mdash; so on such a board the three exact modes are listed but disabled,
          with the reason. If one was already chosen, the view says so and shows Normal change
          (approx.) instead.
        </p>
      </Section>

      <Section id="nurbs" title="Experimental NURBS engine">
        <p>
          <strong>Engine: NURBS (experimental)</strong> is an opt-in preview of a new surface model.
          Turn it on in <em>Settings &rsaquo; Experimental</em>, or open the editor with{' '}
          <code>?engine=nurbs</code> to try it for one session. It is off by default, and with it
          off nothing about the editor changes.
        </p>
        <p>
          With it on, the open board is converted to NURBS curves and sections, and the editors edit
          that board: drag, lock, nudge and undo the <strong>outline</strong>,{' '}
          <strong>rocker</strong> and <strong>deck</strong> exactly as you do in the classic editor.
          The 3D view shows the NURBS surface and follows every drag, not after a wait. The{' '}
          <strong>cross-sections</strong> are edited too: pick a station in the outline or rocker
          view, then drag its points and handles in the cross-section view. The centre points stay
          where the outline, rocker and deck put them, the widest point moves up and down only, and
          nothing goes wider than it, so a section can never change the outline, rocker or deck. You
          can add a station (right-click the outline or rocker), drag it along the board, delete it,
          paste a section onto it or give it a rail preset; each is one undo step. A dashed line in
          the cross-section view is the section the NURBS surface really has there, and follows the
          pointer as you move it along the outline. Sections follow the outline, rocker and deck
          automatically, so the interpolation setting and{' '}
          <em>Resize cross-sections to rocker/deck</em> belong to the classic engine and are hidden
          or ignored.
        </p>
        <p>
          In the tabbed layout a <strong>NURBS (experimental) &mdash; editing</strong> badge sits
          over the 3D view, with a <strong>Classic / NURBS</strong> switch to compare the same board
          on both, and an <strong>i</strong> button that lists the volume, how closely the stations
          were fitted and any warnings. A <strong>Test board</strong> menu shows one of the NURBS
          model&rsquo;s own test boards (swallow, fish, asymmetric, analytic) on its own; your board
          is untouched. The <a href="#workspace">workspace</a> draws none of these: it has one
          engine, and one quiet status line in their place.
        </p>
        <p>
          Saving, sharing and the autosave write the NURBS board itself (see{' '}
          <Link to="/docs/files#nurbs-files">Files &amp; templates</Link>): both halves of an
          asymmetric board, the tail and the bottom features are in the file. STL, DXF, the 1:1 PDF
          and STEP are made from the NURBS board itself, in a worker, with a progress note and a
          Cancel in the Export menu; an edit made while one runs does not change it. The STEP
          surfaces are fitted to within 0.5 mm of the NURBS surface, a swallow or fish tail
          included. Rail bands and the legacy <code>.brd</code> still write its classic projection,
          which has neither the bottom features nor the smooth blend between the stations, so a
          board cut from those differs from the NURBS surface by the amount below. Turning the
          engine off returns to the classic board you opened, and turning it on again finds the
          NURBS board where you left it; opening another classic file converts that one, and a board
          the converter cannot hold stays classic, with the reason shown in a notice. In this mode
          the specs in the sidebar (volume, area, centre of mass) are measured on the NURBS surface,
          so the bottom features and an asymmetric outline show in them. The NURBS surface is a
          different surface from the classic one: it matches the outline, rocker, deck and every
          cross-section, and flows smoothly between the stations where the classic loft blends them
          linearly, so the two differ by up to a few millimetres between stations. The surface
          analysis modes above all work on it, read from the NURBS surface&rsquo;s own exact
          derivatives, with no crease at the stations, and the menu of the tabbed layout gains one
          more (the workspace does not offer it):
        </p>
        <Terms>
          <Term name="Deviation from classic">
            How far the NURBS surface lies from the classic surface of the same board, measured
            along the surface normal: red where the NURBS surface has more foam, blue where it has
            less, in your display unit. Once you have edited the NURBS board it shows how far the
            edits took it from the board you opened. The colour band is the same control as for the
            ghost deviation. It is left blank within half a centimetre of the tips.
          </Term>
        </Terms>
        <p>
          Every board the classic editor can open converts, including a V in the bottom of a
          cross-section, a board with no thickness at an end and a blunt tail. A board the model
          cannot hold, such as an outline that folds back on itself or a deck that dips below the
          rocker, stays classic: the editors keep editing the classic board, the classic mesh stays
          on screen and the <strong>i</strong> button says why. If a drag on the NURBS board makes
          it something the model cannot hold, the 3D view keeps the last good surface until you drag
          back.
        </p>
      </Section>

      <Section id="board-shape" title="Asymmetric boards & tail types (NURBS)">
        <p>
          With the NURBS engine on, the <strong>Board shape</strong> section of the Shape tab sets
          the board&rsquo;s symmetry and tail. Each change is one undo step.
        </p>
        <Terms>
          <Term name="Asymmetric">
            Gives each half of the board its own outline and its own cross-section at every station.
            The two halves start as exact copies, so nothing about the surface changes until you
            edit one. The outline view then shows both rails, the first above the centre line and
            the second below it, and the cross-section view shows the first half on the right of the
            centre line and the second on the left. Drag a point on either: only that half changes.
            The rocker, the deck, the stations and the nose and tail points are shared, so moving a
            shared end point moves it on both halves. Copy and paste, and a rail preset, go to the
            half you last selected a point on.
          </Term>
          <Term name="Mirrored">
            Switching back asks which half to keep (the upper or the lower rail, as the outline view
            draws them). The other half is dropped, so the board is mirrored from the one you keep.
            Undo brings both back.
          </Term>
          <Term name="Standard">
            The tail is a tip on the centre line, as in the classic editor.
          </Term>
          <Term name="Swallow">
            A V notch cut into the tail: a straight inner wall from the notch bottom on the centre
            line to a corner tip at each side. Switching to it replaces the tail&rsquo;s knots with
            the notch and drops any station behind the notch bottom; undo restores them.
          </Term>
          <Term name="Fish">
            The same notch with a rounded inner wall, and by default a shallower one.
          </Term>
        </Terms>
        <p>
          <strong>Notch depth</strong> is the distance from the tail tips to the notch bottom. Type
          it in the section, in your display unit, or drag the point on the centre line of the
          outline view along the stringer. It is held between half a percent and thirty percent of
          the board&rsquo;s length. A station on the notch bottom follows it, and one the notch
          bottom passes is dropped. Near a notch a station is cut across the rail, not across the
          board, so the cross-section view calls it a <em>rail section</em>.
        </p>
        <p>
          Not yet for an asymmetric board: saving, exporting, sharing and the autosave write it as a
          classic board, which has one half only (the first, mirrored), so the other half is not in
          the file. The specs readout is of that mirrored board too; the volume in the 3D
          view&rsquo;s <strong>i</strong> button is of the whole surface.
        </p>
        <p>
          A very deep or narrow notch, or an outline edit near the tail, can make the rail fold so
          the notch&rsquo;s cross-cuts would cross the outline at a shallow angle. The model then
          refuses the board: the 3D view keeps the last good surface until you drag back, and the{' '}
          <strong>i</strong> button says why. Nothing is lost, and the document stays editable.
        </p>
      </Section>

      <Section id="bottom-features" title="Bottom features (NURBS)">
        <p>
          With the NURBS engine on, the <strong>Bottom features</strong> section of the Shape tab
          adds a vee, a concave or channels to the bottom. A feature is a depth that changes along
          the board, so it is zero at both ends, and a shape across the bottom. Each feature has a
          switch to turn it off without losing its settings, and a Remove button. Every change is
          one undo step, and dragging a slider is one step in all. Nothing else in the board is
          refitted by it, so the 3D view follows as you drag.
        </p>
        <Terms>
          <Term name="Vee">
            The bottom rises towards the rails by the depth and is flat at the stringer.{' '}
            <em>Stringer blend</em> is how much of the half-width is rounded off at the stringer, so
            a small value gives a sharp ridge and a large one a soft one.
          </Term>
          <Term name="Single concave">
            One hollow across the middle of the bottom, deepest on the stringer and fading to
            nothing towards the rails. <em>Width</em> is its half-width as a share of the half-width
            of the bottom.
          </Term>
          <Term name="Double concave">
            Two hollows, one each side of the stringer. <em>Hollow width</em> and{' '}
            <em>Hollow centre</em> are shares of the half-width of the bottom. The hollows stay
            apart from each other and off the outline: widening one moves the centre if it has to.
          </Term>
          <Term name="Channels">
            Narrow grooves parallel to the rails. You set how many there are, their width, the
            spacing from one to the next and the distance of the outer one from the outline. They
            cannot reach the stringer, so the fields stop where the narrowest part of the board
            under the feature ends.
          </Term>
        </Terms>
        <p>
          <strong>Depth</strong> is the greatest depth, in your display unit. A feature has two
          ends, named for the end of the board they are on and drawn in the same order as the
          outline and rocker views, tail on the left: <strong>Tail end &mdash; from tail</strong> is
          measured from the tail, so its least value means the feature runs out through the tail,
          and <strong>Nose end &mdash; from nose</strong> is measured back from the nose tip. Under
          each the other reading is written (&ldquo;= 152.4 cm from tail&rdquo;) with the length the
          feature <em>Runs</em>, and a small strip above the fields shades the span between{' '}
          <em>Tail</em> and <em>Nose</em>. A slider moved to the right moves that end towards the
          nose, and the nose end always stays on the nose side of the tail end. The depth between
          them follows a smooth curve through its <em>depth keys</em>: open <em>Depth keys</em> to
          move an inner point (measured from the tail) along the board or change its depth, add a
          key or remove one. A feature always keeps its two ends and one key between them. Every
          field has a slider and a box, and both are held to what the board can take: a value past
          the end of the range is moved back to it.
        </p>
        <p>
          The rocker view draws each feature&rsquo;s depth along the board as a coloured strip
          across the top of the view, on one scale, with the greatest depth written beside it. It is
          read-only. The cross-section view&rsquo;s dashed line is the section the surface really
          has at the selected station, so it dips where a feature is. The dashed line, like the 3D
          view, needs the 3D view to be open (quad, split or 3D).
        </p>
        <p>
          A feature must lie between the notch bottom and the nose. When a tail change or a deeper
          notch would put the start of a feature behind the notch bottom, the feature is squeezed
          into the room that is left instead of being refused; undo restores it. Bottom features are
          in the 3D view and the volume, but not yet in exported files.
        </p>
      </Section>

      <Section id="points" title="Control points & tangents">
        <p>
          Drag a point to move it. Selecting one reveals its tangent handles: drag those to change
          how the curve leaves the point. Longer handles make a fuller curve; shorter ones tighten
          it.
        </p>
        <p>
          Hovering a point or tangent enlarges it; selecting it turns it orange. Its exact X/Y
          position then appears in that pane's header, where you can type a value or use the number
          field arrows for unit-aware increments (5 mm, 0.5 cm, or 0.25 in). Corner points stay
          green and square so they remain distinct from smooth points.
        </p>
        <p>
          Press <code>{shortcutKeys('cross-section-blur')}</code> to clear a selected point or
          tangent handle. On a touch screen, tapping empty canvas does the same — it also releases a
          focused station.
        </p>
        <p>
          Right-click a control point to fair its local curve, switch between smooth and corner,
          select either tangent, or delete it. On the outline and rocker the two tangents are named
          for the end of the board they point at — tail and nose — so the labels still read true
          when a phone draws the board nose-up. A cross-section has neither end nearer the nose, so
          its handles stay left and right. Right-click a tangent to collapse it to zero length; a
          selected collapsed tangent can be right-clicked again and extended so it is easy to grab.
          On a touch screen, press and hold in place for the same menu — holding still is what
          distinguishes it from a drag, so it will not interrupt one you have started.
        </p>
        <p>
          Press <code>{shortcutKeys('delete-point')}</code> to remove the selected point. The curve
          re-fits through the remaining points. A curve&apos;s two endpoints cannot be deleted, nor
          can a cross-section&apos;s widest point — see{' '}
          <Link to="/docs/editing#blank">Cross-sections stay inside the blank</Link>.
        </p>
      </Section>

      <Section id="locks" title="Locking handle angles">
        <p>
          Lock a point to keep the direction of its tangent handles while you work on their length.
          Select the point or one of its handles and click the padlock in the pane&apos;s header,
          press <code>{shortcutKeys('toggle-lock')}</code>, or right-click the point or a handle and
          choose Lock handle angles. A locked point shows a short bar across each locked
          handle&apos;s line.
        </p>
        <p>
          A locked handle slides along its line: drag it anywhere and it only gets longer or
          shorter, so tuning how full a curve is can no longer tip its angle by accident. Drag it
          back through the point and it collapses to zero length rather than flipping round; drag it
          out again and it comes back the same way. On a smooth point the other handle keeps its own
          length and direction. With a locked handle selected, the pane header shows its length
          instead of X and Y: type a value, or use the arrow keys to step it. The sidebar Control
          point section shows its X and Y read-only, with the length below them.
        </p>
        <p>
          The lock holds through the other point tools too. Fair curve sets new lengths along the
          locked directions, Extend handle grows a collapsed handle along its lock, and moving the
          point carries its handles with it. To lock handles level or upright, use the horizontal or
          vertical align buttons in the sidebar Control point section: aligning a locked point turns
          its lock with it. <Link to="/docs/specs#resize">Resizing the board</Link> scales the locks
          with the shape.
        </p>
        <p>
          Locks are part of the board. Locking and unlocking undo like any other edit, and locks are
          saved in OpenShaper&apos;s own <code>.board.json</code> files and share links. A{' '}
          <code>.brd</code> export leaves them out — BoardCAD has no such setting — so the curve is
          unchanged but its points come back unlocked.
        </p>
      </Section>

      <Section id="keyboard" title="Nudging from the keyboard">
        <p>
          Select a point or a handle and press the arrow keys (<code>{shortcutKeys('nudge')}</code>)
          to move it one step at a time: 5 mm, 0.5 cm or 0.25 in, depending on the length unit. Hold
          Shift for {NUDGE.shiftFactor} steps at once. The arrows work in whichever view holds the
          selection, and in the pane header&apos;s own X, Y or Length field, where they step that
          value (Shift with Left or Right still selects text there); not in any other text field,
          nor while a dialog is open. Each press is one undo step.
        </p>
        <p>
          Two keys, held down, change what the arrows do. On their own they do nothing; let go and
          the arrows move the selection again.
        </p>
        <Terms>
          <Term name={`Hold ${NUDGE.rotateKey.toUpperCase()}: turn`}>
            <code>{shortcutKeys('nudge-rotate')}</code> turns the selected handle about its point,{' '}
            {NUDGE.turnDegrees}° per press, keeping its length: Left and Up counter-clockwise, Right
            and Down clockwise, as you see it — in every view, including a phone&apos;s nose-up one.
            With the point itself selected, both of its handles turn by the same angle. A smooth
            point&apos;s two handles always turn together, so it stays smooth. Shift turns{' '}
            {NUDGE.turnDegrees * NUDGE.shiftFactor}°.
          </Term>
          <Term name={`Hold ${NUDGE.lengthKey.toUpperCase()}: length`}>
            <code>{shortcutKeys('nudge-length')}</code> lengthens (Right, Up) or shortens (Left,
            Down) the selected handle by one step along the line it points, never past zero; with
            the point selected, both of its handles (at a curve&apos;s first or last point, the one
            handle the curve uses). A handle only shortens to nothing when it can grow back the way
            it pointed — along its lock, or opposite the other handle of a smooth point — so a point
            never loses its tangent; any other handle stops at its last step short of zero. Shift
            changes it {NUDGE.shiftFactor} steps at once.
          </Term>
        </Terms>
        <p>
          A lock fixes a handle&apos;s angle, so turning does nothing to a locked handle — and, on a
          smooth point, to either of its handles — while its length still changes. A turn that would
          fold a curve back on itself, such as an outline or rocker handle turned past square to the
          board&apos;s length, is not made at all rather than squashing the handle: the press does
          nothing, and smaller steps without Shift still take it closer. A ⌘ chord, such as{' '}
          <code>{shortcutKeys('undo')}</code> to take back a step, ends a held mode: press R or T
          again before the next arrow. Every chord is listed on the{' '}
          <Link to="/docs/shortcuts#nudging">shortcuts</Link> page.
        </p>
      </Section>

      <Section id="sections" title="Cross-sections">
        <p>
          You define cross-sections at particular stations; the surface between them is
          interpolated, so you do not need many. Add one where the shape needs to change character —
          through the hips, or where a concave starts — rather than at regular intervals.
        </p>
        <p>
          Sections can be copied and pasted, which is the quickest way to hold a rail shape constant
          through a stretch of the board and then vary it deliberately.
        </p>
        <p>
          Every station shows as a dashed vertical line in the outline and rocker views, with a
          diamond handle at each end. Click a handle to select the station — it turns orange — then
          drag it along the board to reposition it. The position appears beside the handle as you
          drag, in your chosen units, and a station can never pass its neighbours, so the order
          never changes under you. The whole drag is a single undo step. Press{' '}
          <code>{shortcutKeys('cross-section-blur')}</code> to release the handle.
        </p>
        <p>
          Right-clicking a handle offers to add a station either side of it, or to delete it. For an
          exact position, type into the field beside the station counter in the cross-section pane
          header, or use its steppers — they nudge by a sensible amount for the current unit.
        </p>
        <p>
          Moving a station carries its profile with it, so the surface between the neighbouring
          stations changes shape. That is deliberate: you are sliding a control station, not
          re-sampling the existing surface.
        </p>
      </Section>

      <Section id="blank" title="Cross-sections stay inside the blank">
        <p>
          The outline and the rocker — deck and bottom — define the blank, the way a shaper
          hot-wires the side profile and then cuts the outline. Cross-sections (slices) refine that
          blank and always sit inside it, so editing one never changes the outline, the deck or the
          bottom. Those change only in their own views.
        </p>
        <Terms>
          <Term name="Centre points">
            The two points on the stringer sit on the bottom and on the deck, so they do not move. A
            ring marks each, and the sidebar and the pane header show their position read-only.
            Their handles stay free. To make the board thicker or thinner there, edit the rocker
            (with <strong>Resize cross-sections to rocker/deck</strong> on, as it is by default).
          </Term>
          <Term name="Apex">
            The section&apos;s widest point holds it to the outline&apos;s width, so it moves only
            up and down — which is how you raise or lower the rail. Chevrons above and below it show
            the way it can go, its distance from the stringer shows read-only, and it cannot be
            deleted. Its handles can lengthen, shorten or lean in, but never out past it, which
            keeps a smooth apex&apos;s handles upright (so they cannot be aligned flat). To make the
            board wider or narrower there, edit the outline (with the same setting on).
          </Term>
          <Term name="Every other point">
            Moves freely inside the apex, and stops on the line through it when dragged further out;
            so does every handle. A value typed past the line stops there too, and the field shows
            where it stopped; a handle&apos;s length stops where the handle meets the line, keeping
            its angle. Where two points sit level at the widest, as on a boxy rail, neither is
            singled out: either can move in while the other keeps the width.
          </Term>
        </Terms>
        <p>
          A drag the blank refuses outright, such as pulling on a centre point, leaves nothing on
          the undo stack. With <strong>Resize cross-sections to rocker/deck</strong> on in Settings
          (the default), editing the outline or the rocker resizes the cross-sections in that area
          to match; turned off, they keep their own size. Either way, editing a cross-section leaves
          the curves alone. A pasted cross-section brings its shape, stretched to the station&apos;s
          centre points and apex line, so it lands inside the blank too.
        </p>
      </Section>

      <Section id="rails" title="Rail presets">
        <p>
          Right-click in the cross-section view and pick a shape under <em>Rail preset</em> to
          restyle the station you are on. It applies to that one section — build a rail that changes
          along the board by stepping through stations and choosing as you go, which is what a
          shaper does anyway: soft through the nose, tucked through the middle, hard off the tail.
        </p>
        <p>
          Only the rail band is re-cut. Like marking bands in from the rail and planing just those,
          a preset works between two blend points — one in from the rail on the deck, a narrower one
          on the bottom — and joins smoothly to what is already there. Your deck crown, your vee,
          your concave: all untouched. The station&rsquo;s width and thickness do not move either,
          so the outline and rocker stay put.
        </p>
        <p>
          It lands as one undo step, and what you get back is an ordinary profile — drag the points
          afterwards, or leave it.
        </p>
        <p>
          The ratio in a name is where the rail&rsquo;s apex — its widest point — sits between those
          two marks. A 50/50 puts it halfway up the rail; an 80/20 puts it near the bottom, where it
          makes an edge for water to leave from.
        </p>
        <p>
          It is the midpoint of the <em>rail</em>, not of the deck and bottom planes. On a board
          with a flat bottom and a domed deck the rail blends into that dome up top and into the
          flat underneath, so even a 50/50 apex measures below mid-thickness — a third of the way up
          is normal on a shortboard. Dome the bottom too, as a longboard or a hull does, and the
          apex climbs back toward the middle on its own.
        </p>
        <Terms>
          {RAIL_PRESETS.map((preset) => (
            <Term key={preset.id} name={preset.label}>
              {preset.summary}
            </Term>
          ))}
        </Terms>
      </Section>

      <Section id="tail" title="Concave tails">
        <p>
          The outline can fold back into the tail to make a swallow or a wing. Volume, planshape
          area, the 3D mesh and every export understand the cutout, so the numbers stay honest.
        </p>
        <p>
          One shape is not supported: a single notch only, so batwing tails with two cutouts cannot
          be described.
        </p>
      </Section>

      <Section id="undo" title="Undo & history">
        <p>
          Every edit lands on a labelled undo stack — <code>{shortcutKeys('undo')}</code> and{' '}
          <code>{shortcutKeys('redo')}</code>. A drag is one step, not one step per pixel, so undo
          moves in the units you actually think in.
        </p>
        <p>
          Your working board is saved to this device continuously, so closing the tab and coming
          back restores it, along with the view you were in and the camera position. The one
          exception is the quad view on a phone, which is not offered there — a board last left in
          it opens on the outline, and the stored preference is kept for the next time you open the
          editor on a bigger screen.
        </p>
      </Section>
    </DocsPage>
  );
}
