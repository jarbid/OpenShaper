// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Which store the editors edit, and the engines that fill the stores they might edit.
 *
 * With the NURBS engine off the classic store. With it on, the section store once the open board is
 * converted into it (`use-section-engine.ts`). With the rails switch on as well, the rails store once a
 * rails board is ready for the open document (`rails-engine.ts`): made from the section store's document
 * (or the classic board), or loaded whole. One place decides, here; `App` calls this once.
 *
 * While the rails store holds the open document and the rails switch is on, the section engine is
 * suspended: a rails board that arrived whole is not converted into a section document nobody is
 * editing. It resumes when the switch goes off, and shows what the section store held.
 */
import { useLayoutEffect } from 'react';
import { useRailsCurrent, useRailsEngine, type RailsEngine } from './rails-engine';
import { activeStore, docStore, railsStore, sectionStore, boardStore } from './store';
import { useSectionEngine, type SectionEngine } from './use-section-engine';
import type { NurbsIssue } from './workers/nurbs-protocol';

export type DocumentKind = 'classic' | 'sections' | 'rails';

export interface DocumentEngines {
  /** The store the editors edit. */
  readonly kind: DocumentKind;
  /** A NURBS document (of either kind) is the one being edited. */
  readonly ready: boolean;
  /** Why the open board was refused: the rails conversion's reasons first. */
  readonly refusal: { readonly error: string; readonly issues: readonly NurbsIssue[] } | null;
  readonly sections: SectionEngine;
  readonly rails: RailsEngine;
}

/**
 * @param nurbsOn "Engine: NURBS" is on.
 * @param railsOn "Rails engine" is on (it means nothing with the NURBS engine off).
 */
export function useDocumentEngines(nurbsOn: boolean, railsOn: boolean): DocumentEngines {
  const wantRails = nurbsOn && railsOn;
  const railsHeld = useRailsCurrent();
  const sections = useSectionEngine(nurbsOn && !(wantRails && railsHeld));
  const rails = useRailsEngine(wantRails, sections);

  const kind: DocumentKind = rails.ready ? 'rails' : sections.ready ? 'sections' : 'classic';
  useLayoutEffect(() => {
    activeStore.use(
      kind === 'rails' ? railsStore : kind === 'sections' ? sectionStore : boardStore,
    );
    docStore.use(kind === 'rails' ? railsStore : sectionStore);
  }, [kind]);

  return {
    kind,
    ready: kind !== 'classic',
    refusal: rails.refusal ?? sections.refusal,
    sections,
    rails,
  };
}
