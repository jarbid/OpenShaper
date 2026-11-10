import { cn } from '@openshaper/ui';
import type { ReactNode } from 'react';
import { WaveLines } from './marks';

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
      <WaveLines className="absolute -bottom-1 left-0 h-14 w-full text-primary/25" />
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
