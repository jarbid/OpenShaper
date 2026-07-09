import { Link } from 'react-router-dom';
import { ArticleHero, Container, CtaBand, Faq, Figure, Sources, Toc } from '../components/content';
import { JsonLd } from '../seo/JsonLd';
import { Seo } from '../seo/Seo';
import { absUrl, AUTHOR_NAME, SITE_NAME } from '../seo/site';

const TOC = [
  { id: 'why', label: 'Why hollow wood' },
  { id: 'method', label: 'How the method works' },
  { id: 'materials', label: 'Materials & tools' },
  { id: 'templates', label: '1 · Design & templates' },
  { id: 'frame', label: '2 · The frame' },
  { id: 'skins', label: '3 · Skins & rails' },
  { id: 'finish', label: '4 · Vent, seal, finish' },
];

const FAQ = [
  {
    q: 'Do I need a CNC machine to build a hollow wooden surfboard?',
    a: (
      <>
        No. Export the frame as <strong>1:1 PDF templates</strong>, print and tile them, glue the
        paper to plywood and cut the ribs with a jigsaw or bandsaw. A CNC (or a maker-space laser
        cutter) just makes the frame faster and more repeatable — the DXF export gives you clean
        curves for either route.
      </>
    ),
    text: 'No. You can print 1:1 PDF templates, glue them to plywood and cut the ribs with a jigsaw or bandsaw. A CNC or laser cutter makes the frame faster and more repeatable but is optional.',
  },
  {
    q: 'Does a hollow wooden surfboard need a vent?',
    a: (
      <>
        Yes — this is the one non-negotiable piece of hardware. The sealed air chamber expands and
        contracts with temperature; without a vent (a small screw-in plug or breathable Gore-Tex
        vent in the deck), a hot car or black board bag can push the pressure high enough to split a
        seam. Open a screw vent when the board is stored, close it before you paddle out.
      </>
    ),
    text: 'Yes. The sealed air chamber expands and contracts with temperature, so every hollow board needs a small deck vent (screw-in or breathable membrane) to relieve pressure. Without one, heat can split a seam.',
  },
  {
    q: 'How heavy is a hollow wooden board compared to foam?',
    a: (
      <>
        Expect roughly 1–3&nbsp;kg over an equivalent foam board, depending on timber and skin
        thickness — a Paulownia shortboard-size build often lands around 4–6&nbsp;kg. The extra
        weight reads as momentum and glide rather than dead weight, and the durability trade is
        dramatically in wood&apos;s favour.
      </>
    ),
    text: 'Typically 1–3 kg heavier than an equivalent foam board; a Paulownia shortboard-size build often lands around 4–6 kg. The weight rides as momentum and glide, and the board is far more durable.',
  },
];

export default function HollowWoodenSurfboard() {
  return (
    <>
      <Seo
        title="How to Build a Hollow Wooden Surfboard: From CAD File to Water"
        path="/build-a-hollow-wooden-surfboard"
        type="article"
        image="/images/guides/og-hollow-wooden-surfboard.jpg"
        description="A step-by-step guide to building a hollow wooden (skin-on-frame) surfboard — design the shape in CAD, cut rib and rail templates from DXF or PDF, skin it in Paulownia, and seal it right."
      />
      <JsonLd
        data={[
          {
            '@context': 'https://schema.org',
            '@type': 'Article',
            headline: 'How to Build a Hollow Wooden Surfboard: From CAD File to Water',
            description:
              'A step-by-step guide to skin-on-frame hollow wooden surfboard construction, from CAD design and templates to frame, skins, rails and finishing.',
            image: absUrl('/images/guides/og-hollow-wooden-surfboard.jpg'),
            author: { '@type': 'Person', name: AUTHOR_NAME, url: absUrl('/about') },
            publisher: { '@type': 'Organization', name: SITE_NAME },
            datePublished: '2026-07-09',
            dateModified: '2026-07-09',
            mainEntityOfPage: absUrl('/build-a-hollow-wooden-surfboard'),
          },
          {
            '@context': 'https://schema.org',
            '@type': 'BreadcrumbList',
            itemListElement: [
              { '@type': 'ListItem', position: 1, name: 'Home', item: absUrl('/') },
              {
                '@type': 'ListItem',
                position: 2,
                name: 'Build a hollow wooden surfboard',
                item: absUrl('/build-a-hollow-wooden-surfboard'),
              },
            ],
          },
        ]}
      />

      <ArticleHero
        eyebrow="Build guide"
        title="Build a hollow wooden surfboard."
        lede="Skin-on-frame is the most CAD-friendly way to build a board: the ribs are literally your design's cross-sections. Here's the whole process — from a file on screen to a board in the water."
      />

      <Container className="py-14">
        <div className="grid gap-12 lg:grid-cols-[16rem_1fr]">
          <aside className="hidden lg:block">
            <div className="sticky top-24">
              <Toc items={TOC} />
            </div>
          </aside>

          <article className="prose-shaper">
            <h2 id="why">Why build in hollow wood</h2>
            <p>
              Of all the <Link to="/surfboard-construction-methods">construction methods</Link>,
              hollow skin-on-frame is the one that rewards a home builder most: no foam dust, no
              blank to buy, timber you can source sustainably, and a board that shrugs off dings
              that would kill a foam board. The ride is distinctive too — a smooth, dampened flex
              and glide that foam doesn&apos;t quite match.{' '}
              <Link to="/about">My own daily board</Link> is a 5&apos;8&quot; Paulownia fish built
              exactly this way, and it&apos;s outlasted every foam board I&apos;ve owned.
            </p>
            <Figure
              src="/images/guides/paulownia-fish-surfboard.webp"
              alt="Finished hollow wooden fish surfboard in Paulownia with twin keel fins"
              width={1280}
              height={1600}
              caption="The finished board: a 5'8&quot; hollow Paulownia fish, designed in OpenShaper and built from its templates."
            />
            <p>
              Be honest with yourself about the commitment: a first build typically takes 40–100
              hours spread over weeks. It&apos;s woodworking first, board building second — and
              that&apos;s most of the fun.
            </p>

            <h2 id="method">How skin-on-frame works</h2>
            <p>
              The construction borrows from wooden aircraft and boat building. An internal skeleton
              — a <strong>spine</strong> down the stringer line and <strong>ribs</strong> at regular
              stations — defines the rocker and the cross-sectional shape. Thin timber panels
              (typically ~6&nbsp;mm) are glued over the top and bottom of the frame, rails are built
              up from strips or blocks around the perimeter and shaped by hand, and the whole thing
              is sealed. The frame carries the geometry; the skins carry the loads.
            </p>
            <Figure
              src="/images/guides/hollow-surfboard-frame-top-down.webp"
              alt="Top-down view of a hollow wooden surfboard frame showing spine, ribs and swallow-tail blocks before skinning"
              width={1200}
              height={1600}
              caption="The frame is the design made physical: every rib is a cross-section exported straight from the CAD file."
            />

            <h2 id="materials">Materials &amp; tools</h2>
            <ul>
              <li>
                <strong>Paulownia</strong> for skins and rails — light, rot-resistant, bends easily,
                glues well and takes epoxy beautifully. Western red cedar is the classic (heavier,
                gorgeous) alternative; many builders mix the two for contrast.
              </li>
              <li>
                <strong>Plywood</strong> (~6&nbsp;mm exterior or marine grade) for the spine and
                ribs — stable and cheap, and it stays hidden inside.
              </li>
              <li>
                <strong>Glue:</strong> a waterproof wood glue (Titebond III class) for timber
                joints, epoxy where wood meets hardware.
              </li>
              <li>
                <strong>Hardware:</strong> a deck <strong>vent</strong> (non-negotiable — see{' '}
                <a href="#finish">finishing</a>), a leash plug, and fin boxes with solid timber
                blocking inside the hull.
              </li>
              <li>
                <strong>Tools:</strong> jigsaw or bandsaw, block plane, spokeshave, sanding blocks,
                clamps (many), and a simple building cradle to hold the rocker true. A CNC router is
                optional.
              </li>
              <li>
                <strong>Finish:</strong> epoxy resin, with a light fibreglass cloth (4&nbsp;oz) if
                you want maximum durability.
              </li>
            </ul>

            <h2 id="templates">Step 1 — Design the board and export templates</h2>
            <p>
              This is where CAD earns its keep. Design the board in the{' '}
              <Link to="/app">OpenShaper editor</Link> — outline, rocker, and a cross-section at
              each rib station (the <Link to="/surfboard-design-guide">design guide</Link> covers
              what each curve does; the volume readout matters in timber, because litres you
              don&apos;t need are weight you&apos;ll carry). Then export the geometry as build
              templates:
            </p>
            <ul>
              <li>
                <strong>DXF</strong> — outline and cross-section curves, ready for CNC or laser
                cutting. Offset each rib inward by the skin thickness so the finished surface lands
                on your designed shape.
              </li>
              <li>
                <strong>PDF</strong> — the same templates at 1:1 for the no-CNC route: print, tile,
                glue to plywood, cut by hand.
              </li>
              <li>
                <strong>STL</strong> — the full 3D surface, useful if a local shop is machining
                parts for you.
              </li>
            </ul>

            <h2 id="frame">Step 2 — Cut and assemble the frame</h2>
            <p>
              Cut the spine (which carries the rocker profile) and the ribs, then slot them together
              egg-crate style — half-depth slots in the spine, matching slots in the ribs — and
              check the skeleton against your rocker template in the cradle before gluing anything.
              Drill lightening holes in the ribs; they shed weight and, importantly, let air move
              between chambers so the vent can do its job. Glue up square and true: every error in
              the frame telegraphs through the skins.
            </p>
            <Figure
              src="/images/guides/hollow-surfboard-frame-assembly.webp"
              alt="Plywood ribs and spine of a hollow wooden surfboard glued up on the bottom skin in a home workshop"
              width={1600}
              height={1200}
              caption="Ribs and spine glued to the bottom skin — an ordinary garage is all the shaping bay this build needs."
            />

            <h2 id="skins">Step 3 — Skins and rails</h2>
            <p>
              Edge-glue Paulownia strips into two panels, then glue the bottom skin to the frame
              first — clamped or vacuum-bagged over the cradle so it takes the rocker. Build the
              rails around the perimeter from bendable strips or stacked blocks, glued in courses
              and left proud. Fit internal blocking for fins, vent and leash plug before the deck
              goes on — once the deck skin is glued down, the inside is sealed forever. Then the
              most satisfying part: plane and sand the rails to the profile from your printed
              cross-section templates.
            </p>
            <Figure
              src="/images/guides/hollow-surfboard-rail-lamination.webp"
              alt="Laminated timber rail strips clamped around a hollow wooden surfboard frame with hand planes on the deck"
              width={1200}
              height={1600}
              caption="Rails built up in glued courses and planed back — hand-plane work, guided by the cross-section templates."
            />

            <h2 id="finish">Step 4 — Vent, seal and finish</h2>
            <p>
              A hollow board is an airtight chamber, and air expands with heat — every hollow wooden
              board needs a <strong>vent</strong> in the deck (a small screw plug you open for
              storage, or a breathable membrane vent that stays put). Skipping it risks a split seam
              the first time the board sits in a hot car. Seal the timber with epoxy — on its own
              for a light build, or under 4&nbsp;oz glass for the most durable finish — and install
              the fin boxes and leash plug bedded in epoxy. Sand, polish, go surfing.
            </p>
            <Figure
              src="/images/guides/wooden-fish-twin-fins.webp"
              alt="Twin keel fins fitted beside the swallow tail of a hollow wooden fish surfboard"
              width={1280}
              height={1600}
              caption="Twin keels on the finished fish — the fin boxes sit on solid blocking glued inside the hull before the deck went on."
            />

            <Faq items={FAQ} />

            <Sources
              items={[
                {
                  label: 'Grain Surfboards — hollow wooden board builds & kits',
                  href: 'https://www.grainsurfboards.com/',
                },
                {
                  label: 'Surf Simply — Surfboard construction series',
                  href: 'https://surfsimply.com/magazine/surfboard-construction-part-1',
                },
              ]}
            />
          </article>
        </div>
      </Container>

      <CtaBand
        heading="Start with the shape"
        body="Design your board in the browser, then export DXF, PDF or STL templates for the build."
      />
      <div className="h-20" />
    </>
  );
}
