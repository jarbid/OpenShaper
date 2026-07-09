import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArticleHero, Container, CtaBand, Faq, Sources, Toc } from '../components/content';
import { JsonLd } from '../seo/JsonLd';
import { Seo } from '../seo/Seo';
import { absUrl, AUTHOR_NAME, OG_IMAGE, SITE_NAME } from '../seo/site';

const TOC = [
  { id: 'calculator', label: 'The calculator' },
  { id: 'chart', label: 'Volume chart' },
  { id: 'method', label: 'How it works' },
  { id: 'beyond', label: 'Beyond litres' },
];

interface Level {
  key: string;
  label: string;
  blurb: string;
  lo: number;
  hi: number;
}

/** Guild-Factor ability bands: litres per kilogram of body weight. */
const LEVELS: Level[] = [
  {
    key: 'beginner',
    label: 'Beginner',
    blurb: 'first seasons; still working on take-offs and trimming',
    lo: 0.9,
    hi: 1.0,
  },
  {
    key: 'intermediate',
    label: 'Intermediate',
    blurb: 'takes off cleanly and surfs the open face with turns',
    lo: 0.5,
    hi: 0.6,
  },
  {
    key: 'advanced',
    label: 'Advanced',
    blurb: 'confident in most conditions, surfs regularly',
    lo: 0.35,
    hi: 0.4,
  },
  {
    key: 'pro',
    label: 'Pro / expert',
    blurb: 'high-performance surfing at a competitive level',
    lo: 0.28,
    hi: 0.32,
  },
];

const LB_PER_KG = 2.20462;

/**
 * The interactive weight × ability → litres tool. Weight is entered in kg or lb
 * (body weight, not a board length, so it sits outside the editor length-unit
 * system); output is always litres, matching the app-wide volume convention.
 */
function VolumeCalculator() {
  const [weightText, setWeightText] = useState('75');
  const [weightUnit, setWeightUnit] = useState<'kg' | 'lb'>('kg');
  const [levelKey, setLevelKey] = useState('intermediate');
  const [weakWaves, setWeakWaves] = useState(false);
  const [lowerFitness, setLowerFitness] = useState(false);
  const [epsBuild, setEpsBuild] = useState(false);

  const level = LEVELS.find((l) => l.key === levelKey) ?? LEVELS[1]!;
  const entered = Number.parseFloat(weightText);
  const kg = weightUnit === 'kg' ? entered : entered / LB_PER_KG;
  const valid = Number.isFinite(kg) && kg >= 20 && kg <= 200;

  const multiplier = (weakWaves ? 1.1 : 1) * (lowerFitness ? 1.1 : 1);
  const epsOffset = epsBuild ? 2 : 0;
  const lo = valid ? Math.max(0, Math.round(kg * level.lo * multiplier - epsOffset)) : 0;
  const hi = valid ? Math.max(0, Math.round(kg * level.hi * multiplier - epsOffset)) : 0;

  const toggleClass = (active: boolean) =>
    `rounded-md border px-3 py-1.5 text-sm transition-colors ${
      active
        ? 'border-primary bg-primary/10 text-foreground'
        : 'border-border text-muted-foreground hover:text-foreground'
    }`;

  return (
    <div className="not-prose rounded-2xl border border-border bg-card p-6 sm:p-8">
      <div className="grid gap-6 sm:grid-cols-2">
        <div>
          <label htmlFor="vc-weight" className="label-tech mb-2 block">
            Your weight
          </label>
          <div className="flex gap-2">
            <input
              id="vc-weight"
              type="number"
              inputMode="decimal"
              min={0}
              value={weightText}
              onChange={(e) => setWeightText(e.target.value)}
              className="w-28 rounded-md border border-border bg-background px-3 py-1.5 text-foreground"
            />
            {(['kg', 'lb'] as const).map((u) => (
              <button
                key={u}
                type="button"
                aria-pressed={weightUnit === u}
                onClick={() => setWeightUnit(u)}
                className={toggleClass(weightUnit === u)}
              >
                {u}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="label-tech mb-2">Ability</p>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Ability level">
            {LEVELS.map((l) => (
              <button
                key={l.key}
                type="button"
                aria-pressed={levelKey === l.key}
                onClick={() => setLevelKey(l.key)}
                className={toggleClass(levelKey === l.key)}
              >
                {l.label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            {level.label}: {level.blurb}.
          </p>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-sm">
        {(
          [
            ['Mostly small or weak waves', weakWaves, setWeakWaves],
            ['Over 50, or surfing less than weekly', lowerFitness, setLowerFitness],
            ['EPS/epoxy board', epsBuild, setEpsBuild],
          ] as const
        ).map(([label, value, set]) => (
          <label key={label} className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={value}
              onChange={(e) => set(e.target.checked)}
              className="accent-[--color-primary]"
            />
            <span className="text-muted-foreground">{label}</span>
          </label>
        ))}
      </div>

      <div className="mt-7 border-t border-border pt-6 text-center" aria-live="polite">
        {valid ? (
          <>
            <p className="label-tech">Suggested volume</p>
            <p className="font-display mt-1 text-4xl sm:text-5xl">
              {lo} – {hi} L
            </p>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
              A starting range, not a rule — if a board you already like sits outside it, trust the
              board.
            </p>
          </>
        ) : (
          <p className="text-muted-foreground">Enter your weight to get a litre range.</p>
        )}
      </div>
    </div>
  );
}

const CHART_WEIGHTS_KG = [50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100];

const FAQ = [
  {
    q: 'How accurate is a surfboard volume calculator?',
    a: (
      <>
        It gets you into the right neighbourhood — usually within a few litres. Weight and ability
        dominate the answer, but wave type, fitness, board style and construction all shift it. The
        best refinement is a board you already know: note its litres, decide whether you want more
        float or more sensitivity, and move from there.
      </>
    ),
    text: 'A volume calculator gets you within a few litres. Weight and ability dominate, but wave type, fitness, board style and construction shift the answer. The best refinement is comparing against the litres of a board you already know.',
  },
  {
    q: 'Is it bad to ride too much volume?',
    a: (
      <>
        Less harmful than too little. Extra litres paddle faster and catch more waves; the cost is a
        board that sits higher, is harder to sink into a rail, and can feel corky in steep surf. Too{' '}
        <em>little</em> volume is the classic progression-killer — you catch fewer waves, so you
        improve slower. When in doubt, round up.
      </>
    ),
    text: 'Too much volume is less harmful than too little. Extra litres paddle faster and catch more waves but feel corky and harder to put on rail. Too little volume means fewer waves and slower progression, so when in doubt round up.',
  },
  {
    q: 'Do EPS/epoxy boards need less volume?',
    a: (
      <>
        Slightly, yes. EPS foam is lighter and more buoyant than PU for the same litres, so many
        surfers drop 2–3&nbsp;L when switching to an{' '}
        <Link to="/surfboard-construction-methods">EPS/epoxy construction</Link> to keep the same
        feel in the water.
      </>
    ),
    text: 'Slightly, yes. EPS foam is more buoyant than PU at the same litres, so surfers typically drop 2–3 L when switching to an EPS/epoxy board to keep a similar feel.',
  },
];

export default function SurfboardVolumeCalculator() {
  return (
    <>
      <Seo
        title="Surfboard Volume Calculator: How Many Litres Do You Need?"
        path="/surfboard-volume-calculator"
        type="article"
        description="Free surfboard volume calculator — enter your weight and ability for a litre range, plus a volume chart and how wave type, fitness and EPS construction shift the number."
      />
      <JsonLd
        data={[
          {
            '@context': 'https://schema.org',
            '@type': 'Article',
            headline: 'Surfboard Volume Calculator: How Many Litres Do You Need?',
            description:
              'An interactive surfboard volume calculator and chart, with the reasoning behind the litres-per-kilogram guidelines.',
            image: absUrl(OG_IMAGE),
            author: { '@type': 'Person', name: AUTHOR_NAME, url: absUrl('/about') },
            publisher: { '@type': 'Organization', name: SITE_NAME },
            datePublished: '2026-07-09',
            dateModified: '2026-07-09',
            mainEntityOfPage: absUrl('/surfboard-volume-calculator'),
          },
          {
            '@context': 'https://schema.org',
            '@type': 'BreadcrumbList',
            itemListElement: [
              { '@type': 'ListItem', position: 1, name: 'Home', item: absUrl('/') },
              {
                '@type': 'ListItem',
                position: 2,
                name: 'Surfboard volume calculator',
                item: absUrl('/surfboard-volume-calculator'),
              },
            ],
          },
        ]}
      />

      <ArticleHero
        eyebrow="Tool"
        title="Surfboard volume calculator."
        lede="Volume — litres of foam — is the single best number for matching a board to a surfer. Enter your weight and ability for a starting range, then see what shifts it."
      />

      <Container className="py-14">
        <div className="grid gap-12 lg:grid-cols-[16rem_1fr]">
          <aside className="hidden lg:block">
            <div className="sticky top-24">
              <Toc items={TOC} />
            </div>
          </aside>

          <article className="prose-shaper">
            <h2 id="calculator">The calculator</h2>
            <VolumeCalculator />
            <p>
              The range comes from the widely used <strong>Guild Factor</strong> method — body
              weight in kilograms multiplied by an ability factor — with adjustments for weak waves,
              fitness and construction explained <a href="#method">below</a>.
            </p>

            <h2 id="chart">Surfboard volume chart</h2>
            <p>The same guideline as a quick-reference table, in litres:</p>
            <table>
              <thead>
                <tr>
                  <th>Weight</th>
                  <th>Beginner (0.9–1.0)</th>
                  <th>Intermediate (0.5–0.6)</th>
                  <th>Advanced (0.35–0.40)</th>
                </tr>
              </thead>
              <tbody>
                {CHART_WEIGHTS_KG.map((w) => (
                  <tr key={w}>
                    <td>
                      {w}&nbsp;kg / {Math.round(w * LB_PER_KG)}&nbsp;lb
                    </td>
                    <td>
                      {Math.round(w * 0.9)} – {Math.round(w * 1.0)}&nbsp;L
                    </td>
                    <td>
                      {Math.round(w * 0.5)} – {Math.round(w * 0.6)}&nbsp;L
                    </td>
                    <td>
                      {Math.round(w * 0.35)} – {Math.round(w * 0.4)}&nbsp;L
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h2 id="method">How the number is worked out</h2>
            <p>
              One litre of volume floats roughly one kilogram, which is why litres beat length as a
              sizing number: a 6&apos;2&quot; can be anywhere from a sub-30&nbsp;L blade to a
              45&nbsp;L small-wave board. The Guild Factor scales litres to body weight by ability —
              beginners near their full weight in litres for stability and paddle power, advanced
              surfers closer to a third of it for sensitivity and rail control.
            </p>
            <p>Then the honest caveats, which the calculator applies as adjustments:</p>
            <ul>
              <li>
                <strong>Weak or small waves</strong> reward extra foam — add roughly 10% for a board
                you&apos;ll mostly ride in soft surf.
              </li>
              <li>
                <strong>Fitness and age</strong> matter as much as skill. Surfing once a fortnight
                on an &ldquo;advanced&rdquo; volume is a recipe for frustration — add foam.
              </li>
              <li>
                <strong>Construction</strong> shifts the feel: EPS/epoxy floats more per litre than
                PU, so drop 2–3&nbsp;L when switching. The{' '}
                <Link to="/surfboard-construction-methods">construction methods guide</Link>{' '}
                compares the builds.
              </li>
            </ul>

            <h2 id="beyond">Beyond litres: where the volume sits</h2>
            <p>
              Two boards with identical litres can ride nothing alike, because <em>where</em> the
              foam sits — the foil — matters as much as how much there is. Volume under the chest
              paddles; volume in the tail floats you through flat sections; thin rails and a
              foiled-out tail let a board bury into a turn. That&apos;s the point where a calculator
              stops helping and design starts: the{' '}
              <Link to="/surfboard-design-guide">surfboard design guide</Link> covers foil, outline
              and rocker, and in the <Link to="/app">OpenShaper editor</Link> the volume readout
              recalculates live as you move foam around — so you can hit your number exactly, on a
              shape you drew.
            </p>

            <Faq items={FAQ} />

            <Sources
              items={[
                {
                  label: 'Surfertoday — The surfboard volume calculator',
                  href: 'https://www.surfertoday.com/surfing/the-surfboard-volume-calculator',
                },
                {
                  label: "Lost Surfboards — What's your Guild Factor?",
                  href: 'https://lostsurfboards.net/whats-your-guild-factor-surfboard-volumes-explained/',
                },
              ]}
            />
          </article>
        </div>
      </Container>

      <CtaBand
        heading="Design a board to that exact volume"
        body="Open the editor, set your litres as the target, and shape an outline, rocker and foil that hit it."
      />
      <div className="h-20" />
    </>
  );
}
