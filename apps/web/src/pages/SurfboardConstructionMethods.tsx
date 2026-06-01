import { Link } from 'react-router-dom';
import { ArticleHero, Container, CtaBand, Faq, Sources, Toc } from '../components/content';
import { JsonLd } from '../seo/JsonLd';
import { Seo } from '../seo/Seo';
import { absUrl, OG_IMAGE, SITE_NAME } from '../seo/site';

const TOC = [
  { id: 'compare', label: 'At a glance' },
  { id: 'pu', label: 'PU / polyester' },
  { id: 'eps', label: 'EPS / epoxy' },
  { id: 'hollow', label: 'Hollow wooden' },
  { id: 'chambered', label: 'Chambered wood' },
  { id: 'compsand', label: 'Compsand / sandwich' },
  { id: 'printed', label: '3D-printed cores' },
  { id: 'cad', label: 'From CAD to board' },
];

const FAQ = [
  {
    q: 'EPS/epoxy vs PU/polyester — which is better?',
    a: (
      <>
        Neither is universally &ldquo;better.&rdquo; PU/polyester is the traditional construction:
        slightly heavier, with a softer flex and a planted, &ldquo;classic&rdquo; feel many surfers
        prefer in good waves. EPS/epoxy is lighter, livelier and more buoyant, with better
        small-wave performance and durability — but it can feel skittish to some. Choose by the
        waves you ride and the feel you want.
      </>
    ),
    text: 'Neither is universally better. PU/polyester is slightly heavier with a softer, planted flex and a classic feel. EPS/epoxy is lighter, more buoyant, livelier and more durable, with stronger small-wave performance but a feel some find skittish. The right choice depends on wave type and preferred feel.',
  },
  {
    q: 'Can I build a hollow wooden surfboard from a CAD file?',
    a: (
      <>
        Yes — that&apos;s exactly what OpenShaper is good at. Export the outline and cross-sections
        as DXF or PDF templates to cut internal frames (ribs and a perimeter rail), or an STL to CNC
        the parts, then skin the frame in timber. <Link to="/about">My own daily board</Link> is a
        hollow Paulownia fish built this way.
      </>
    ),
    text: 'Yes. Export the outline and cross-sections as DXF or PDF templates to cut the internal frame (ribs and perimeter rail), or an STL to CNC the parts, then skin the frame in timber. This is a standard skin-on-frame hollow wooden build.',
  },
  {
    q: 'Are wooden surfboards heavier than foam ones?',
    a: (
      <>
        Solid wooden boards are heavy, but modern <strong>hollow</strong> wooden boards use a frame
        and thin timber skins to come in surprisingly light — heavier than a foam shortboard, but
        very durable and with a smooth, dampened flex. They&apos;re also among the most sustainable
        boards you can build.
      </>
    ),
    text: 'Solid wooden boards are heavy, but hollow wooden boards use an internal frame with thin timber skins and are much lighter — still heavier than a foam shortboard, but very durable, with a smooth flex, and among the most sustainable constructions.',
  },
];

export default function SurfboardConstructionMethods() {
  return (
    <>
      <Seo
        title="Surfboard Construction Methods Compared: PU, EPS, Hollow Wood & More"
        path="/surfboard-construction-methods"
        type="article"
        description="Compare surfboard construction methods — PU/polyester, EPS/epoxy, hollow wooden, chambered wood, compsand and 3D-printed cores — by weight, feel, durability, cost and how to build each."
      />
      <JsonLd
        data={[
          {
            '@context': 'https://schema.org',
            '@type': 'Article',
            headline: 'Surfboard Construction Methods Compared',
            description:
              'An overview of surfboard construction methods and how they differ in weight, feel, durability, sustainability and cost.',
            image: absUrl(OG_IMAGE),
            author: { '@type': 'Organization', name: SITE_NAME },
            publisher: { '@type': 'Organization', name: SITE_NAME },
            mainEntityOfPage: absUrl('/surfboard-construction-methods'),
          },
          {
            '@context': 'https://schema.org',
            '@type': 'BreadcrumbList',
            itemListElement: [
              { '@type': 'ListItem', position: 1, name: 'Home', item: absUrl('/') },
              {
                '@type': 'ListItem',
                position: 2,
                name: 'Surfboard construction methods',
                item: absUrl('/surfboard-construction-methods'),
              },
            ],
          },
        ]}
      />

      <ArticleHero
        eyebrow="Guide"
        title="How surfboards are built."
        lede="Same shape, very different boards. The core and skin you choose decide a board's weight, flex, durability — and its footprint. Here's how the main methods compare."
      />

      <Container className="py-14">
        <div className="grid gap-12 lg:grid-cols-[16rem_1fr]">
          <aside className="hidden lg:block">
            <div className="sticky top-24">
              <Toc items={TOC} />
            </div>
          </aside>

          <article className="prose-shaper">
            <p>
              A surfboard is a <strong>core</strong> (the foam or wood that gives it shape and
              float) wrapped in a <strong>skin</strong> (cloth and resin, or timber) that gives it
              strength. The combination you choose changes everything about how the finished board
              feels and how long it lasts. Design the shape once — in OpenShaper — then pick the
              build that suits it.
            </p>

            <h2 id="compare">At a glance</h2>
            <table>
              <thead>
                <tr>
                  <th>Method</th>
                  <th>Weight</th>
                  <th>Feel</th>
                  <th>Durability</th>
                  <th>Footprint</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>PU / polyester</td>
                  <td>Medium</td>
                  <td>Classic, planted</td>
                  <td>Moderate</td>
                  <td>Higher</td>
                </tr>
                <tr>
                  <td>EPS / epoxy</td>
                  <td>Light</td>
                  <td>Lively, buoyant</td>
                  <td>High</td>
                  <td>Medium</td>
                </tr>
                <tr>
                  <td>Hollow wooden</td>
                  <td>Medium</td>
                  <td>Smooth, dampened</td>
                  <td>Very high</td>
                  <td>Low</td>
                </tr>
                <tr>
                  <td>Chambered wood</td>
                  <td>Heavy</td>
                  <td>Glidey, momentum</td>
                  <td>Very high</td>
                  <td>Low</td>
                </tr>
                <tr>
                  <td>Compsand / sandwich</td>
                  <td>Light</td>
                  <td>Stiff, strong</td>
                  <td>Very high</td>
                  <td>Medium</td>
                </tr>
              </tbody>
            </table>

            <h2 id="pu">PU / polyester (PU/PE)</h2>
            <p>
              The traditional surfboard: a <strong>polyurethane (PU) foam</strong> blank with a
              wooden stringer, hand-shaped and laminated with <strong>polyester resin</strong> over
              fibreglass cloth. It&apos;s what most boards have been made of for decades. PU/PE sits
              a touch lower in the water with a softer flex and a planted, predictable feel that
              many surfers love in quality waves. The trade-offs: it&apos;s a little heavier, dings
              and yellows more readily, and polyester resin has a heavier environmental footprint.
            </p>

            <h2 id="eps">EPS / epoxy</h2>
            <p>
              An <strong>expanded polystyrene (EPS)</strong> core — the lighter, closed-bead foam —
              laminated with <strong>epoxy resin</strong>. EPS/epoxy boards are lighter, stiffer and
              more buoyant than PU/PE, which makes them lively and strong performers in smaller,
              weaker waves, and notably more durable. The flip side is a feel some surfers describe
              as skittish or &ldquo;corky,&rdquo; and EPS will absorb water if the skin is breached.
              Epoxy is also more forgiving to build with at home than polyester.
            </p>

            <h2 id="hollow">Hollow wooden (skin-on-frame)</h2>
            <p>
              A timber take on aircraft construction: an internal <strong>frame</strong> of a
              perimeter rail and evenly spaced <strong>ribs</strong>, skinned top and bottom with
              thin wooden panels (Paulownia and cedar are favourites for their light weight). The
              result is a board that&apos;s far lighter than solid wood, extremely durable, and with
              a uniquely smooth, dampened flex. It&apos;s also one of the most sustainable ways to
              build — and the method that pairs best with CAD, because the ribs and rail are simply
              cross-sections and the outline cut from templates. This is how{' '}
              <Link to="/about">my own 5&apos;8&quot; Paulownia fish</Link> is built.
            </p>

            <h2 id="chambered">Chambered solid wood</h2>
            <p>
              Solid timber boards with the interior <strong>hollowed into chambers</strong> to shed
              weight before the halves are glued and shaped. Heavier than hollow skin-on-frame, they
              carry serious momentum and glide, look stunning, and last a lifetime — a
              labour-intensive, traditional craft more than an everyday performance build.
            </p>

            <h2 id="compsand">Compsand / sandwich</h2>
            <p>
              A composite &ldquo;sandwich&rdquo; construction: an EPS core skinned with a thin layer
              of timber or high-density foam between glass layers. Compsands are light, very strong
              and stiff, with a lively spring — popular with home builders chasing durability and a
              bit of wood aesthetic without a full hollow frame.
            </p>

            <h2 id="printed">3D-printed cores</h2>
            <p>
              An emerging approach: a printed lattice or core (often then glassed) produced directly
              from a 3D model. Still niche and slower to make, but a natural fit for a CAD workflow
              — export an STL and the geometry is ready for the printer.
            </p>

            <h2 id="cad">From CAD to a real board</h2>
            <p>OpenShaper exports the three things a build needs, whatever method you choose:</p>
            <ul>
              <li>
                <strong>STL</strong> — a watertight 3D mesh for CNC machining a blank or printing a
                core.
              </li>
              <li>
                <strong>DXF</strong> — clean 2D outline and cross-section curves for cutting
                templates, ribs and rails.
              </li>
              <li>
                <strong>PDF</strong> — 1:1 printable templates and a spec sheet for hand-shaping.
              </li>
            </ul>
            <p>
              If you&apos;re still deciding on a shape, start with the{' '}
              <Link to="/surfboard-design-guide">surfboard design guide</Link>. When the outline and
              foil are dialled, the export you need is one click away.
            </p>

            <Faq items={FAQ} />

            <Sources
              items={[
                {
                  label: 'Rusty Surfboards — PU vs Epoxy vs Epoly',
                  href: 'https://rustysurfboards.com/blogs/know-your-shaper/pu-vs-epoly-vs-epoxy',
                },
                {
                  label: 'Global Surf Industries — Epoxy vs PU construction',
                  href: 'https://us.surfindustries.com/blogs/ground-swell/epoxy-vs-pu-understand-surfboard-construction',
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
        heading="Design it, then build it"
        body="Shape your board in the browser and export STL, DXF or PDF for any construction method."
      />
      <div className="h-20" />
    </>
  );
}
