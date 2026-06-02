import { Link } from 'react-router-dom';
import { ArticleHero, Container, CtaBand } from '../components/content';
import { SupportCallout } from '../components/Support';
import { SUPPORT_URL } from '../support';
import { JsonLd } from '../seo/JsonLd';
import { Seo } from '../seo/Seo';
import { absUrl, AUTHOR_NAME, GITHUB_URL, SITE_NAME } from '../seo/site';

export default function About() {
  return (
    <>
      <Seo
        title="About"
        path="/about"
        type="article"
        description="The story behind OpenShaper — a free, open-source surfboard design app built by a technical designer, maker and surfer who builds his own hollow timber boards."
      />
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'AboutPage',
          name: `About ${SITE_NAME}`,
          url: absUrl('/about'),
          mainEntity: {
            '@type': 'Person',
            name: AUTHOR_NAME,
            jobTitle: 'Technical Designer',
            description:
              'Technical designer, maker and surfer who designs and builds hollow timber surfboards and created OpenShaper.',
            knowsAbout: [
              'Surfboard design',
              'Surfboard shaping',
              'Hollow wooden surfboards',
              'CAD',
            ],
          },
        }}
      />

      <ArticleHero
        eyebrow="About the project"
        title="Made by a surfer who loves building things."
        lede="OpenShaper started as a tool for my own shaping bay. It grew into something I wanted to share — free, open-source, for anyone who likes making their own boards."
      />

      <Container className="py-14">
        <div className="prose-shaper reveal">
          <p>
            Hi — I&apos;m a technical designer by trade. My day job is taking concepts and bringing
            them from the digital world into real, physical things, so I spend a lot of my time
            living in that gap between a screen and a workshop. I&apos;m a maker and a tinkerer at
            heart: I&apos;m always pulled toward a new project, a new material, or a new bit of tech
            to play with.
          </p>
          <p>
            The other half of my life is the ocean. I surf, and somewhere along the way I fell hard
            for surfboard <em>design</em> — not just riding boards, but understanding why they ride
            the way they do. That curiosity turned into sawdust. I started designing and building my
            own <strong>hollow timber surfboards</strong>, and my daily driver right now is a{' '}
            <strong>5&apos;8&quot; fish I made from Paulownia</strong> — light, lively, and a
            constant reminder of how good it feels to ride something you built with your own hands.
          </p>

          <blockquote className="my-8 border-l-2 border-primary pl-5 font-display text-xl italic leading-snug text-foreground">
            “There&apos;s nothing quite like paddling out on a board you drew, shaped and glassed
            yourself.”
          </blockquote>

          <h2>Why I built OpenShaper</h2>
          <p>
            I wanted a design tool that fit the way I actually work — quick to open, honest about
            the numbers (volume and weight matter a lot when you&apos;re building in timber), and
            able to export clean geometry for templates and CNC. Naturally, testing out some
            vibe-coding with a surfboard CAD turned into a genuinely fun project. It became the tool
            I now reach for in my own board-design workflow.
          </p>
          <p>
            OpenShaper is a from-scratch, modern rebuild in the spirit of the original open-source{' '}
            <a href="https://www.boardcad.com/" target="_blank" rel="noopener noreferrer nofollow">
              BoardCAD
            </a>{' '}
            — rewritten to run entirely in your browser, with a live 3D preview and a clean export
            path. It stands on that project&apos;s shoulders, and like BoardCAD it&apos;s released
            under the GPL so it stays free and open.
          </p>

          <h2>What I believe about it</h2>
          <ul>
            <li>
              <strong>Free, for everyone.</strong> No accounts, no tiers, no paywall — every feature
              is free, and it always will be.
            </li>
            <li>
              <strong>Yours, on your machine.</strong> There&apos;s no server. Your designs never
              leave your browser.
            </li>
            <li>
              <strong>Open by default.</strong> The full source lives on{' '}
              <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
                GitHub
              </a>{' '}
              under the GPL-3.0 — fork it, learn from it, improve it.
            </li>
          </ul>
          <p>
            If you like making things as much as I do, I hope it helps you build something
            you&apos;re proud to paddle out on. It&apos;s free and always will be — but if it earns
            a spot in your shaping bay, you can{' '}
            <a href={SUPPORT_URL} target="_blank" rel="noopener noreferrer">
              buy me a coffee
            </a>{' '}
            to keep it growing. New to all this? Start with the{' '}
            <Link to="/surfboard-design-guide">surfboard design guide</Link> or read up on{' '}
            <Link to="/surfboard-construction-methods">construction methods</Link>.
          </p>
        </div>

        <SupportCallout />
      </Container>

      <CtaBand
        heading="Build your own board"
        body="Open the app and start shaping — then take it to foam, foil or timber."
      />
      <div className="h-20" />
    </>
  );
}
