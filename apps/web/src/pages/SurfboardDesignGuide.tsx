import { Link } from 'react-router-dom';
import { ArticleHero, Container, CtaBand, Faq, Figure, Sources, Toc } from '../components/content';
import { JsonLd } from '../seo/JsonLd';
import { Seo } from '../seo/Seo';
import { absUrl, AUTHOR_NAME, OG_IMAGE, SITE_NAME } from '../seo/site';

const TOC = [
  { id: 'outline', label: 'Outline (planshape)' },
  { id: 'tail', label: 'Tail shapes' },
  { id: 'rocker', label: 'Rocker' },
  { id: 'rails', label: 'Rails' },
  { id: 'foil', label: 'Foil & volume' },
  { id: 'bottom', label: 'Bottom contours' },
  { id: 'dimensions', label: 'Dimensions & litres' },
  { id: 'fins', label: 'Fin setups' },
];

const FAQ = [
  {
    q: 'How much volume (litres) do I need in a surfboard?',
    a: (
      <>
        As a rough starting point, multiply your body weight in kilograms by a factor for your
        ability: beginners around 0.9–1.0, intermediates 0.5–0.6, and advanced shortboarders
        0.35–0.40. A 75&nbsp;kg intermediate lands near 38–45&nbsp;litres. Treat it as a starting
        line, not a rule — wave type and fitness shift it. The{' '}
        <Link to="/surfboard-volume-calculator">volume calculator</Link> works this out for you, and
        OpenShaper shows volume live as you shape.
      </>
    ),
    text: 'A common starting point is to multiply body weight in kilograms by an ability factor: beginners ~0.9–1.0, intermediates ~0.5–0.6, advanced shortboarders ~0.35–0.40. A 75 kg intermediate is roughly 38–45 litres. It is a starting point, not a strict rule.',
  },
  {
    q: 'What is rocker on a surfboard?',
    a: (
      <>
        Rocker is the curve of the board from nose to tail when viewed side-on. More rocker turns
        tighter and handles steep waves but is slower to paddle; less (flatter) rocker is faster and
        paddles better but can catch on steep drops.
      </>
    ),
    text: 'Rocker is the nose-to-tail curve of a surfboard seen from the side. More rocker turns tighter and suits steep waves but paddles slower; a flatter rocker is faster and paddles more easily but can be harder to control on steep drops.',
  },
  {
    q: 'Does a wider surfboard paddle better?',
    a: (
      <>
        Generally yes — extra width (and the volume that comes with it) adds planing area and
        stability, so the board paddles and catches waves more easily. The trade-off is that very
        wide boards can feel less responsive rail-to-rail.
      </>
    ),
    text: 'Yes, generally. More width adds planing area and volume, improving paddling and stability and making waves easier to catch. The trade-off is reduced rail-to-rail responsiveness on very wide boards.',
  },
];

export default function SurfboardDesignGuide() {
  return (
    <>
      <Seo
        title="Surfboard Design Explained: Outline, Rocker, Rails & Volume"
        path="/surfboard-design-guide"
        type="article"
        description="A clear guide to surfboard design — outline, rocker, rails, foil, volume, bottom contours and fin setups, and how each one changes the way a board rides."
      />
      <JsonLd
        data={[
          {
            '@context': 'https://schema.org',
            '@type': 'Article',
            headline: 'Surfboard Design Explained: Outline, Rocker, Rails & Volume',
            description:
              'A guide to the fundamentals of surfboard design and how each design element affects performance.',
            image: absUrl(OG_IMAGE),
            author: { '@type': 'Person', name: AUTHOR_NAME, url: absUrl('/about') },
            publisher: { '@type': 'Organization', name: SITE_NAME },
            datePublished: '2026-06-02',
            dateModified: '2026-07-09',
            mainEntityOfPage: absUrl('/surfboard-design-guide'),
          },
          {
            '@context': 'https://schema.org',
            '@type': 'BreadcrumbList',
            itemListElement: [
              { '@type': 'ListItem', position: 1, name: 'Home', item: absUrl('/') },
              {
                '@type': 'ListItem',
                position: 2,
                name: 'Surfboard design guide',
                item: absUrl('/surfboard-design-guide'),
              },
            ],
          },
        ]}
      />

      <ArticleHero
        eyebrow="Guide"
        title="Surfboard design, explained."
        lede="Every board is a balance of a handful of curves and dimensions. Here's what each one does — and how changing it changes the ride."
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
              A surfboard looks simple, but a shaper is juggling several curves at once: the{' '}
              <strong>outline</strong> you see from above, the <strong>rocker</strong> from the
              side, the <strong>rails</strong> along the edge, the <strong>foil</strong> through the
              thickness, and the <strong>bottom contours</strong> underneath. Get the blend right
              for a given surfer and wave, and the board comes alive. Below is what each element
              controls.
            </p>
            <Figure
              src="/images/guides/openshaper-editor-quad-view.webp"
              alt="Surfboard design software showing a board's outline, cross-section, rocker and 3D views with a live spec panel"
              width={1600}
              height={1000}
              caption="The four curves of a surfboard, side by side: outline, cross-section, rocker and the lofted 3D shape."
            />

            <h2 id="outline">Outline (planshape)</h2>
            <p>
              The outline — or planshape — is the board&apos;s silhouette seen from above. Its{' '}
              <strong>width</strong> and where the <strong>wide point</strong> sits drive paddling,
              stability and how the board turns. A wider board with more planing area paddles and
              catches waves more easily; a narrower, drawn-out outline is more responsive and holds
              better in powerful surf.
            </p>
            <p>
              The nose matters too: a fuller, rounder nose adds paddle power and float up front,
              while a pulled-in nose fits steeper wave faces. Move the wide point forward for an
              easy, drivey feel; move it back for a board that pivots off the tail.
            </p>

            <h2 id="tail">Tail shapes</h2>
            <p>
              The tail is the last part of the board the water touches, so its shape decides how
              water releases and how tightly the board pivots. Corners release flow cleanly for
              quick, snappy direction changes; curves hold water longer for smoother, drawn-out
              turns.
            </p>
            <ul>
              <li>
                <strong>Squash</strong> — the all-rounder: a squared-off tail with soft corners,
                balancing release and hold.
              </li>
              <li>
                <strong>Round</strong> — more curve, more hold; smooth, carving turns.
              </li>
              <li>
                <strong>Pin</strong> — narrow and drawn out for maximum hold in big, powerful surf.
              </li>
              <li>
                <strong>Swallow</strong> — keeps width for small-wave speed while the two points
                bite like twin pins; the classic fish tail.
              </li>
              <li>
                <strong>Square</strong> — hard corners and full width; skatey, instant release.
              </li>
            </ul>
            <Figure
              src="/images/guides/paulownia-fish-swallow-tail.webp"
              alt="Swallow tail of a hand-built hollow wooden fish surfboard in Paulownia"
              width={1280}
              height={1600}
              caption="A swallow tail keeps width for speed while each point bites like a narrow pin — the signature fish tail."
            />
            <p>
              Tail width interacts with everything else: wider tails plane earlier and feel loose,
              narrower tails hold in when the wave has push. In OpenShaper you can reshape the tail
              — including swallow and fish cuts — and watch the outline and volume update live.
            </p>

            <h2 id="rocker">Rocker</h2>
            <p>
              Rocker is the curve from nose to tail viewed side-on, and it&apos;s one of the most
              feel-defining numbers on the board. <strong>Nose rocker</strong> (entry rocker)
              governs how the board handles steep drops and chop without pearling;{' '}
              <strong>tail rocker</strong> (exit rocker) governs how tightly it turns off the tail.
            </p>
            <p>
              More rocker means tighter turning and better steep-wave control, at the cost of paddle
              speed and down-the-line drive. A flatter rocker is faster and paddles more easily,
              ideal for small, weak waves, but can feel stiff and catchy when the wave stands up.
              Rocker can be <strong>continuous</strong> (a single smooth arc, predictable and
              drivey) or <strong>staged</strong> (flatter through the middle with kick in the tail,
              for a livelier pivot).
            </p>
            <Figure
              src="/images/guides/openshaper-rocker-editor.webp"
              alt="Surfboard deck and bottom rocker curves being edited with control points in design software"
              width={1600}
              height={1000}
              caption="Deck and bottom rocker edited as two curves — the gap between them is the foil."
            />

            <h2 id="rails">Rails</h2>
            <p>
              Rails are the edges where deck meets bottom, and their fullness and shape decide how
              the board bites or releases. A <strong>soft, full (50/50) rail</strong> is forgiving
              and holds the board in the face of the wave — common on longboards and beginner
              boards. A <strong>hard, tucked-under edge (down rail)</strong> releases water cleanly
              for speed and bite, typical toward the tail of performance shortboards.
            </p>
            <Figure
              src="/images/guides/openshaper-cross-section-rail.webp"
              alt="A surfboard cross-section in design software showing the rail profile between deck and bottom"
              width={1600}
              height={1000}
              caption="A cross-section is the rail's fingerprint: this profile — soft above, tucked edge below — is what your hand feels."
            />
            <p>
              Most boards blend the two: softer and fuller through the nose for forgiveness, harder
              and lower toward the tail for drive and release. Thinner rails sink and grip in steep
              waves; fuller rails plane and forgive.
            </p>

            <h2 id="foil">Foil &amp; volume distribution</h2>
            <p>
              Foil is how thickness flows from nose to tail — the board&apos;s profile. It&apos;s
              not just <em>how much</em> volume a board has, but <em>where</em> that volume sits.
              Volume carried forward helps early paddle entry and small-wave performance; volume
              kept under the chest with a thinner, foiled-out tail lets a board sink its rail and
              turn hard.
            </p>
            <p>
              Thickness through the centre is where most of the float lives, so small changes there
              move the litres a lot. In OpenShaper the cross-section and rocker views let you shape
              the foil while the <strong>live volume readout</strong> tells you what it costs.
            </p>
            <Figure
              src="/images/guides/openshaper-outline-volume-distribution.webp"
              alt="Surfboard outline with a volume-distribution curve and centre-of-mass marker in design software"
              width={1600}
              height={1000}
              caption="The volume-distribution curve under the outline shows where the foam sits; the CoM line marks its balance point."
            />

            <h2 id="bottom">Bottom contours</h2>
            <p>The shape of the underside steers how water flows beneath the board:</p>
            <ul>
              <li>
                <strong>Flat</strong> — direct and fast in small waves, simple and lively.
              </li>
              <li>
                <strong>Single concave</strong> — channels water nose-to-tail for lift and
                straight-line speed.
              </li>
              <li>
                <strong>Double concave</strong> — often set inside a single concave through the tail
                to add control and rail-to-rail response.
              </li>
              <li>
                <strong>Vee</strong> — makes rolling from rail to rail easier, popular through the
                tail of all-rounders and longboards.
              </li>
            </ul>
            <p>
              Many modern boards blend these: single concave up front rolling into vee or double off
              the tail.
            </p>

            <h2 id="dimensions">Dimensions &amp; volume (litres)</h2>
            <p>
              The three headline numbers — <strong>length</strong>, <strong>width</strong> and{' '}
              <strong>thickness</strong> — combine into <strong>volume</strong>, measured in litres,
              which is the single best proxy for how easily a board floats and paddles you. A useful
              starting point is to scale volume to body weight and ability:
            </p>
            <table>
              <thead>
                <tr>
                  <th>Ability</th>
                  <th>Volume factor</th>
                  <th>75&nbsp;kg surfer</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Beginner</td>
                  <td>0.9 – 1.0+ × weight (kg)</td>
                  <td>~68 – 75&nbsp;L</td>
                </tr>
                <tr>
                  <td>Intermediate</td>
                  <td>0.5 – 0.6 × weight (kg)</td>
                  <td>~38 – 45&nbsp;L</td>
                </tr>
                <tr>
                  <td>Advanced (shortboard)</td>
                  <td>0.35 – 0.40 × weight (kg)</td>
                  <td>~26 – 30&nbsp;L</td>
                </tr>
              </tbody>
            </table>
            <p>
              These are starting points, not rules — wave size and power, fitness and board type all
              shift them, and many surfers happily ride more volume than the &ldquo;advanced&rdquo;
              row suggests. One nuance: the factors assume a standard PU build. An EPS/epoxy board
              floats noticeably more for the same litres, so riders often drop 2–3&nbsp;L when
              switching — the <Link to="/surfboard-construction-methods">construction guide</Link>{' '}
              covers how the builds differ. For a personalised number, try the{' '}
              <Link to="/surfboard-volume-calculator">surfboard volume calculator</Link>. The value
              of designing your own board is that you can dial litres deliberately instead of
              guessing; OpenShaper recalculates volume as you shape.
            </p>

            <h2 id="fins">Fin setups</h2>
            <p>
              Fins convert the board&apos;s shape into hold, drive and release. The common layouts:
            </p>
            <ul>
              <li>
                <strong>Single fin</strong> — smooth, drawn-out turns; classic longboard and retro
                feel.
              </li>
              <li>
                <strong>Twin</strong> — loose, fast and skatey, especially in small waves and fish.
              </li>
              <li>
                <strong>Thruster (tri-fin)</strong> — the all-round standard: drive, control and
                predictable release.
              </li>
              <li>
                <strong>Quad</strong> — fast down the line with hold in hollow waves; less pivot
                than a thruster.
              </li>
              <li>
                <strong>2+1</strong> — a centre fin with side bites, common on longboards and
                mid-lengths.
              </li>
            </ul>
            <p>
              Fin choice interacts with everything above: a looser tail outline pairs naturally with
              a thruster or quad, while a drawn-out pin and single fin reward a smoother, more
              committed turn.
            </p>

            <p className="mt-8">
              Ready to put it together? Read up on{' '}
              <Link to="/surfboard-construction-methods">construction methods</Link> next, or jump
              straight into the editor and start shaping.
            </p>

            <Faq items={FAQ} />

            <Sources
              items={[
                {
                  label: 'Surf Simply — Surfboard design & construction research',
                  href: 'https://surfsimply.com/magazine/surfboard-construction-part-1',
                },
                {
                  label: 'Surfertoday — Surfboard design fundamentals',
                  href: 'https://www.surfertoday.com/surfing/the-anatomy-of-a-surfboard',
                },
                {
                  label: 'BoardCAD — open-source surfboard CAD/CAM',
                  href: 'https://www.boardcad.com/',
                },
              ]}
            />
          </article>
        </div>
      </Container>

      <CtaBand
        heading="Try it on a real shape"
        body="Open the editor and watch volume, rocker and outline update as you design."
      />
      <div className="h-20" />
    </>
  );
}
