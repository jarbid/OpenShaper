import { buttonVariants, cn } from '@openshaper/ui';
import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { BoardOutline } from '../components/marks';
import { Container, CtaBand, Eyebrow, Faq } from '../components/content';
import { JsonLd } from '../seo/JsonLd';
import { Seo } from '../seo/Seo';
import { absUrl, GITHUB_URL, OG_IMAGE, SITE_NAME, SITE_TAGLINE } from '../seo/site';

const FEATURES = [
  {
    title: 'Outline, rocker & cross-sections',
    body: 'Draw the planshape, tune the rocker, and sculpt rail-to-rail cross-sections with bézier control points — the three views every shape is built from.',
  },
  {
    title: 'Live volume & weight',
    body: 'Volume in litres and an estimated blank weight update as you shape, so you can dial a board to your weight and ability without guesswork.',
  },
  {
    title: 'Real-time 3D preview',
    body: 'A lofted 3D model rebuilds as you edit. Spin it, check the foil, and catch problems before they reach foam or timber.',
  },
  {
    title: 'Export STL, DXF & PDF',
    body: 'Send an STL to a CNC machine or 3D printer, DXF outlines to a cutter, or print 1:1 PDF templates for hand-shaping.',
  },
  {
    title: 'Runs on your machine',
    body: 'No account, no upload, no server. Your designs never leave the browser — open it on a plane, in the shaping bay, anywhere.',
  },
  {
    title: 'Free & open-source',
    body: 'Released under the GPL-3.0. Every feature is free, the source is on GitHub, and it always will be.',
  },
];

const STEPS = [
  {
    n: '01',
    title: 'Sketch the outline',
    body: 'Start from a template or a blank, then pull the curve to your length, width and tail.',
  },
  {
    n: '02',
    title: 'Refine rocker & rails',
    body: 'Adjust the rocker profile and cross-sections while volume and weight track every move.',
  },
  {
    n: '03',
    title: 'Export & build',
    body: 'Send G-code-ready geometry to a CNC, or print templates and shape it by hand.',
  },
];

const AUDIENCE = [
  'Backyard & garage shapers cutting their first blanks',
  'Hollow-wooden & timber builders planning frames and panels',
  'Students and tinkerers learning how board design works',
  'Working shapers who want a free second tool for quick ideas',
];

const FAQ = [
  {
    q: 'Is OpenShaper really free?',
    a: (
      <>
        Yes — completely. It&apos;s open-source under the GPL-3.0 with no paywall, no tiers and no
        account. <Link to="/about">Read why</Link>.
      </>
    ),
    text: 'Yes. OpenShaper is free and open-source under the GPL-3.0 licence. There is no paywall, no subscription tier and no account required.',
  },
  {
    q: 'Do I need to install anything?',
    a: <>No. It runs in any modern browser. There is also an optional desktop build.</>,
    text: 'No. OpenShaper runs entirely in a modern web browser. An optional desktop build is also available.',
  },
  {
    q: 'Can I use it to drive a CNC machine?',
    a: (
      <>
        Export an STL for CAM software or a 3D printer, DXF outlines for a cutter, or 1:1 PDF
        templates for hand-shaping. See the{' '}
        <Link to="/surfboard-construction-methods">construction guide</Link>.
      </>
    ),
    text: 'Yes. OpenShaper exports STL meshes for CAM software and 3D printers, DXF outlines for cutters, and 1:1 PDF templates for hand-shaping.',
  },
  {
    q: 'Where is my design stored?',
    a: <>On your own device. Nothing is uploaded — the whole app runs client-side.</>,
    text: 'Your designs stay on your own device. OpenShaper runs entirely client-side and never uploads your files to a server.',
  },
];

export default function Landing() {
  return (
    <>
      <Seo title={`${SITE_NAME} — ${SITE_TAGLINE.toLowerCase()}`} path="/" type="website" />
      <JsonLd
        data={[
          {
            '@context': 'https://schema.org',
            '@type': 'SoftwareApplication',
            name: SITE_NAME,
            applicationCategory: 'DesignApplication',
            applicationSubCategory: 'Surfboard CAD',
            operatingSystem: 'Web, Windows, macOS, Linux',
            offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
            url: absUrl('/'),
            image: absUrl(OG_IMAGE),
            description: SITE_TAGLINE,
            license: 'https://www.gnu.org/licenses/gpl-3.0.html',
            isAccessibleForFree: true,
          },
          {
            '@context': 'https://schema.org',
            '@type': 'WebSite',
            name: SITE_NAME,
            url: absUrl('/'),
          },
        ]}
      />

      {/* ---- Hero ---- */}
      <section className="relative overflow-hidden border-b border-border">
        {/* oversized faint blueprint plate index */}
        <span
          aria-hidden
          className="plate-index pointer-events-none absolute -right-6 -top-16 select-none text-[13rem] opacity-[0.07] sm:text-[20rem]"
        >
          01
        </span>

        <Container className="grid gap-12 py-16 sm:py-24 lg:grid-cols-[1.08fr_0.92fr] lg:items-center">
          <div className="stagger">
            <Eyebrow>Open-source surfboard CAD</Eyebrow>
            <h1 className="font-display mt-6 text-[3.25rem] leading-[0.92] sm:text-[4.75rem]">
              Design surfboards,
              <br />
              right in your{' '}
              <span className="relative whitespace-nowrap text-primary">
                browser
                <svg
                  className="absolute -bottom-1 left-0 h-2 w-full text-primary/70"
                  viewBox="0 0 200 8"
                  fill="none"
                  preserveAspectRatio="none"
                  aria-hidden
                >
                  <path
                    d="M1 5 C 40 2, 160 2, 199 5"
                    stroke="currentColor"
                    strokeWidth="2"
                    className="draw-line"
                    style={{ ['--len' as string]: 220 } as CSSProperties}
                  />
                </svg>
              </span>
              .
            </h1>
            <p className="mt-7 max-w-xl text-lg leading-relaxed text-muted-foreground">
              OpenShaper is a free, open-source design app for shaping surfboards — outline, rocker,
              cross-sections and a live 3D model, with volume and weight as you go. No account, no
              paywall, nothing to install.
            </p>
            <div className="mt-9 flex flex-wrap items-center gap-3">
              <Link to="/app" className={cn(buttonVariants({ size: 'lg' }), 'shadow-sm')}>
                Open the design app
              </Link>
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(buttonVariants({ variant: 'outline', size: 'lg' }))}
              >
                View source
              </a>
            </div>
            <p className="font-mono-tech mt-6 text-xs tracking-wider text-muted-foreground">
              FREE FOREVER · GPL-3.0 · RUNS 100% IN YOUR BROWSER
            </p>
          </div>

          {/* Hero blueprint "instrument" panel */}
          <div className="reveal" style={{ animationDelay: '0.5s' }}>
            <div className="glow-ocean crop-frame relative rounded-xl border border-border bg-card/85 p-6 backdrop-blur-sm sm:p-7">
              <div className="flex items-center justify-between">
                <span className="fig-label">FIG.01 — SHORTBOARD 5′8″</span>
                <span className="font-mono-tech flex items-center gap-1.5 text-[0.7rem] text-muted-foreground">
                  <span className="pulse-ocean inline-block h-1.5 w-1.5 rounded-full bg-primary" />
                  LIVE
                </span>
              </div>

              <BoardOutline className="mt-7 h-auto w-full text-primary" animate fit />

              {/* length dimension callout */}
              <div className="mt-3 flex items-center gap-3">
                <span className="dim-line flex-1" />
                <span className="font-mono-tech text-[0.7rem] text-muted-foreground">5′08″</span>
                <span className="dim-line flex-1" />
              </div>

              <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-border pt-6 sm:grid-cols-4">
                {[
                  ['Length', '5′08″'],
                  ['Width', '19¾″'],
                  ['Thick', '2¼″'],
                  ['Volume', '28.4 L'],
                ].map(([k, v]) => (
                  <div key={k}>
                    <dt className="font-mono-tech text-[0.62rem] uppercase tracking-wider text-muted-foreground">
                      {k}
                    </dt>
                    <dd className="font-display mt-1 text-xl tabular-nums">{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </Container>
      </section>

      {/* ---- Features ---- */}
      <section className="py-16 sm:py-20">
        <Container>
          <Eyebrow>What it does</Eyebrow>
          <h2 className="font-display mt-3 max-w-2xl text-3xl sm:text-4xl">
            Everything you need to take a board from idea to blank.
          </h2>
          <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <div
                key={f.title}
                className="group relative overflow-hidden bg-card p-6 transition-colors hover:bg-accent/30"
              >
                <span className="absolute inset-x-0 top-0 h-px origin-left scale-x-0 bg-primary transition-transform duration-300 group-hover:scale-x-100" />
                <h3 className="font-display text-lg">{f.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{f.body}</p>
              </div>
            ))}
          </div>
        </Container>
      </section>

      {/* ---- How it works ---- */}
      <section className="border-y border-border bg-secondary/40 py-16 sm:py-20">
        <Container>
          <Eyebrow>How it works</Eyebrow>
          <h2 className="font-display mt-3 text-3xl sm:text-4xl">Three views, one shape.</h2>
          <div className="mt-12 grid gap-8 md:grid-cols-3">
            {STEPS.map((s) => (
              <div key={s.n}>
                <span className="font-display text-4xl text-primary/70 tabular-nums">{s.n}</span>
                <div className="rule-tech my-4" />
                <h3 className="font-display text-xl">{s.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{s.body}</p>
              </div>
            ))}
          </div>
        </Container>
      </section>

      {/* ---- Who it's for ---- */}
      <section className="py-16 sm:py-20">
        <Container className="grid gap-12 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
          <div>
            <Eyebrow>Who it&apos;s for</Eyebrow>
            <h2 className="font-display mt-3 text-3xl sm:text-4xl">
              Built for people who make things.
            </h2>
            <p className="mt-4 text-muted-foreground">
              Whether you&apos;re gluing up a hollow timber frame or roughing out your first PU
              blank, OpenShaper gives you the numbers and the shape before you commit a cut.
            </p>
            <Link
              to="/about"
              className="mt-6 inline-block text-sm font-medium text-primary underline underline-offset-4"
            >
              The story behind the project →
            </Link>
          </div>
          <ul className="grid gap-3 sm:grid-cols-2">
            {AUDIENCE.map((a) => (
              <li
                key={a}
                className="rounded-xl border border-border bg-card p-4 text-sm leading-relaxed"
              >
                {a}
              </li>
            ))}
          </ul>
        </Container>
      </section>

      {/* ---- Learn / content cross-links ---- */}
      <section className="border-t border-border py-16 sm:py-20">
        <Container>
          <Eyebrow>Learn the craft</Eyebrow>
          <h2 className="font-display mt-3 text-3xl sm:text-4xl">New to board design?</h2>
          <div className="mt-10 grid gap-6 md:grid-cols-2">
            {[
              {
                to: '/surfboard-design-guide',
                kicker: 'Guide',
                title: 'Surfboard design explained',
                body: 'Outline, rocker, rails, foil, volume and fin setups — what each one does and how it changes the way a board rides.',
              },
              {
                to: '/surfboard-construction-methods',
                kicker: 'Guide',
                title: 'Construction methods compared',
                body: 'PU/PE, EPS/epoxy, hollow wooden, chambered and more — weight, feel, durability, cost and how to build each.',
              },
            ].map((c) => (
              <Link
                key={c.to}
                to={c.to}
                className="group rounded-2xl border border-border bg-card p-7 transition-colors hover:bg-accent/40"
              >
                <span className="label-tech">{c.kicker}</span>
                <h3 className="font-display mt-2 text-2xl">{c.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{c.body}</p>
                <span className="mt-4 inline-block text-sm font-medium text-primary">
                  Read more →
                </span>
              </Link>
            ))}
          </div>
          <div className="mt-12">
            <Faq items={FAQ} />
          </div>
        </Container>
      </section>

      <CtaBand />
      <div className="h-20" />
    </>
  );
}
