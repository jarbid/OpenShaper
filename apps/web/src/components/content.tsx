import { buttonVariants, cn } from '@openshaper/ui';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { JsonLd } from '../seo/JsonLd';
import { RockerCurve } from './marks';

/** Centered max-width container. */
export function Container({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mx-auto w-full max-w-6xl px-5', className)}>{children}</div>;
}

/** Small uppercase technical eyebrow label. */
export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="label-tech">{children}</p>;
}

/** Article / pillar-page hero: eyebrow, headline, lede. */
export function ArticleHero({
  eyebrow,
  title,
  lede,
}: {
  eyebrow: string;
  title: string;
  lede: ReactNode;
}) {
  return (
    <header className="relative overflow-hidden border-b border-border">
      <Container className="reveal py-16 sm:py-20">
        <Eyebrow>{eyebrow}</Eyebrow>
        <h1 className="font-display mt-4 max-w-3xl text-4xl leading-[1.05] sm:text-5xl">{title}</h1>
        <p className="mt-5 max-w-2xl text-lg leading-relaxed text-muted-foreground">{lede}</p>
      </Container>
      <RockerCurve className="absolute -bottom-2 left-0 h-16 w-full text-border" />
    </header>
  );
}

/** Sticky in-page table of contents for the long-form guides. */
export function Toc({ items }: { items: { id: string; label: string }[] }) {
  return (
    <nav aria-label="On this page" className="text-sm">
      <p className="label-tech mb-3">On this page</p>
      <ul className="space-y-2 border-l border-border">
        {items.map((it) => (
          <li key={it.id}>
            <a
              href={`#${it.id}`}
              className="-ml-px block border-l border-transparent pl-4 text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
            >
              {it.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export interface FaqItem {
  q: string;
  a: ReactNode;
  /** Plain-text answer for the JSON-LD FAQPage (rich-result eligibility). */
  text: string;
}

/** FAQ accordion-style list that also emits FAQPage structured data. */
export function Faq({ items }: { items: FaqItem[] }) {
  return (
    <section aria-labelledby="faq-heading" className="mt-12">
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          mainEntity: items.map((it) => ({
            '@type': 'Question',
            name: it.q,
            acceptedAnswer: { '@type': 'Answer', text: it.text },
          })),
        }}
      />
      <h2 id="faq-heading" className="font-display text-2xl sm:text-3xl">
        Frequently asked questions
      </h2>
      <div className="mt-5 divide-y divide-border border-y border-border">
        {items.map((it) => (
          <details key={it.q} className="group py-4">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium">
              {it.q}
              <span
                className="text-primary transition-transform group-open:rotate-45"
                aria-hidden="true"
              >
                +
              </span>
            </summary>
            <div className="mt-3 text-muted-foreground">{it.a}</div>
          </details>
        ))}
      </div>
    </section>
  );
}

/** Cited sources block for research-backed pages. */
export function Sources({ items }: { items: { label: string; href: string }[] }) {
  return (
    <section className="mt-12">
      <p className="label-tech mb-3">Sources &amp; further reading</p>
      <ul className="space-y-1.5 text-sm text-muted-foreground">
        {items.map((s) => (
          <li key={s.href}>
            <a
              href={s.href}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="underline underline-offset-2 hover:text-foreground"
            >
              {s.label}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Conversion band — the repeated "open the app" call to action. */
export function CtaBand({
  heading = 'Design your next board',
  body = 'Open the editor and start shaping — free, in your browser, nothing to install.',
}: {
  heading?: string;
  body?: string;
}) {
  return (
    <section className="mt-20">
      <Container>
        <div className="relative overflow-hidden rounded-2xl border border-border bg-card px-6 py-12 text-center sm:px-12">
          <RockerCurve className="absolute inset-x-0 top-0 h-10 w-full text-border" />
          <h2 className="font-display text-3xl sm:text-4xl">{heading}</h2>
          <p className="mx-auto mt-3 max-w-xl text-muted-foreground">{body}</p>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
            <Link to="/app" className={cn(buttonVariants({ size: 'lg' }), 'shadow-sm')}>
              Open the design app
            </Link>
            <Link
              to="/surfboard-design-guide"
              className={cn(buttonVariants({ variant: 'outline', size: 'lg' }))}
            >
              Read the design guide
            </Link>
          </div>
        </div>
      </Container>
    </section>
  );
}
