// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Shared shell for the `/docs` pages: hero, sibling navigation, and the prose
 * styling the guide pages already use.
 *
 * Reference documentation, not marketing — these pages answer "what does this do"
 * for someone already in the editor, so they are deliberately terse and have no
 * calls to action. They are prerendered like every other route and precached by
 * the service worker, so they stay readable with no connection (see
 * docs/design/offline.md).
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArticleHero, Container, Toc } from '../../components/content';
import { Seo } from '../../seo/Seo';
import { DOCS_ROUTES, type DocsRoute } from '../../docs/registry';

/** Nav labels for the sibling list, in reading order. */
export const DOCS_NAV: Record<DocsRoute, string> = {
  '/docs': 'Overview',
  '/docs/editing': 'Editing a board',
  '/docs/specs': 'Specs & measurements',
  '/docs/fins': 'Fins',
  '/docs/construction': 'Construction templates',
  '/docs/export': 'Exporting',
  '/docs/files': 'Files & templates',
  '/docs/offline': 'Offline & installing',
  '/docs/shortcuts': 'Keyboard shortcuts',
};

export interface DocsPageProps {
  route: DocsRoute;
  title: string;
  lede: string;
  /** In-page anchors. Ids must match the `<Section>` ids used below. */
  toc?: { id: string; label: string }[];
  children: ReactNode;
}

/** A titled documentation section with a stable anchor. */
export function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24">
      <h2 className="font-display mt-12 text-2xl first:mt-0">{title}</h2>
      <div className="mt-4 space-y-4 leading-relaxed text-muted-foreground">{children}</div>
    </section>
  );
}

/** Definition row — the workhorse for "this control does this". */
export function Term({ name, children }: { name: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-1 border-t border-border py-3 sm:grid-cols-[minmax(0,14rem)_1fr] sm:gap-4">
      <dt className="font-medium text-foreground">{name}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function Terms({ children }: { children: ReactNode }) {
  return <dl className="mt-2">{children}</dl>;
}

export function DocsPage({ route, title, lede, toc, children }: DocsPageProps) {
  return (
    <>
      <Seo title={title} description={lede} path={route} />
      <ArticleHero eyebrow="Documentation" title={title} lede={lede} />
      <Container className="grid gap-12 py-12 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <aside className="lg:sticky lg:top-24 lg:self-start">
          <nav aria-label="Documentation" className="text-sm">
            <p className="label-tech mb-3">Documentation</p>
            <ul className="space-y-2 border-l border-border">
              {DOCS_ROUTES.map((r) => (
                <li key={r}>
                  <Link
                    to={r}
                    className={
                      r === route
                        ? '-ml-px block border-l border-primary pl-4 text-foreground'
                        : '-ml-px block border-l border-transparent pl-4 text-muted-foreground transition-colors hover:border-primary hover:text-foreground'
                    }
                  >
                    {DOCS_NAV[r]}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          {toc && toc.length > 0 && (
            <div className="mt-8">
              <Toc items={toc} />
            </div>
          )}
        </aside>
        <article className="min-w-0 max-w-2xl">{children}</article>
      </Container>
    </>
  );
}
