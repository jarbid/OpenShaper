/**
 * The right-hand sidebar: spec readout, resize, board info, fins, weight estimate,
 * trace-image controls, the control-point inspector, analysis toggles, and the
 * ghost comparison.
 *
 * Four tabs down a permanent 64px strip at the edge, drawn from the registry in
 * `sidebar-sections.ts`; each holds one to three tools as collapsible sections
 * (`Disclosure`). The strip is what stops the tool list being displaced by the tool you
 * have open. What is open is decided by the shell — the active and pinned tabs, per-view
 * relevance, the master collapse-all and the user's own toggles all flow through
 * `SidebarState` — so this file only renders it. On the desktop tier the panel folds
 * away and the strip alone remains, still carrying the board's headline dims.
 *
 * State is owned by the app shell and threaded in as props — this component is purely
 * presentational so the shell stays the single source of truth (several of these values
 * also drive the editor overlays).
 */
import { FIN_SETUP_LABELS } from '@openshaper/kernel';
import type { BoardSpecs } from '@openshaper/store';
import {
  Button,
  Checkbox,
  cn,
  Disclosure,
  Input,
  Panel,
  PanelBody,
  Textarea,
  Tooltip,
} from '@openshaper/ui';
import {
  Check,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  History as HistoryIcon,
  Layers,
  Pin,
  PinOff,
  Ruler,
  Spline,
  type LucideIcon,
} from 'lucide-react';
import {
  memo,
  useEffect,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { ControlPointInspector } from './ControlPointInspector';
import { CoffeeIcon } from './components/Support';
import { SUPPORT_URL } from './support';
import type { BoardMeta } from './file-io';
import { fmtDimsHeadline, fmtLen, fmtVol, parseLen, type LengthUnit } from './format';
import type { TraceView, UseTrace } from './use-trace';
import { FinPanel } from './FinPanel';
import {
  anyOpen,
  sectionsInTab,
  selectTab,
  setAll,
  setAllSpecGroups,
  shownTabs,
  SIDEBAR_TABS,
  tabById,
  toggleSection,
  togglePin,
  toggleSpecGroup,
  type SectionId,
  type SidebarState,
  type SpecGroupId,
  type TabId,
} from './sidebar-sections';
import { boardStore } from './store';
import { OverlayToggle, Sel, SpecRow, UnitSelect } from './view-toolkit';
import {
  fmtWeight,
  FOAM_TYPES,
  GLASS_SCHEDULES,
  type FoamType,
  type GlassSchedule,
  type WeightBreakdown,
} from './weights';

/** Signed length difference (current − ghost) in the active units. */
function diffLen(cur: number, ghost: number, units: LengthUnit): string {
  const d = cur - ghost;
  return `${d >= 0 ? '+' : '−'}${fmtLen(Math.abs(d), units)}`;
}

/** Signed volume difference (current − ghost) in liters. */
function diffVol(cur: number, ghost: number): string {
  const d = cur - ghost;
  return `${d >= 0 ? '+' : '−'}${fmtVol(Math.abs(d))}`;
}

/**
 * Strip icons, by tab.
 *
 * Here rather than in the registry so `sidebar-sections.ts` stays free of React and its
 * reducers stay testable without mounting anything.
 */
const TAB_ICONS: Record<TabId, LucideIcon> = {
  specs: Ruler,
  shape: Spline,
  build: Layers,
  reference: HistoryIcon,
};

/**
 * The sidebar's dimensions, in one place.
 *
 * These are the values most likely to be adjusted by eye — they were scattered across
 * four inline class lists, and finding them all again took a grep. Each is used exactly
 * once below; the point is that a nudge to the strip's width or a tab's height is a
 * one-line edit somebody can find, not an archaeology exercise.
 *
 * `pointer-coarse:` variants are the 44px ergonomic floor for a finger and should not be
 * tuned below it — `e2e/tap-targets.spec.ts` is the budget that enforces this.
 */
const SIZING = {
  /** Width of the vertical strip. Must fit the longest caption at 9px — "SHAPE". */
  strip: 'w-14',
  /** One vertical tab: a 16px icon over a 9px caption needs ~30px of the 44px floor. */
  tab: 'min-h-11 gap-0.5 px-0.5 py-1 pointer-coarse:min-h-12',
  /** Width of the panel beside the strip. With the strip, the sidebar's total. */
  panel: 'w-64',
  /** Ceiling on a pinned panel, which yields height to the one being worked in. */
  pinnedPanel: 'max-h-[45%]',
  /** The support bar across the bottom. */
  support: 'h-9 pointer-coarse:h-11',
} as const;

export interface ResizeFields {
  l: string;
  w: string;
  t: string;
}

export interface OverlayToggles {
  grid: boolean;
  comb: boolean;
  com: boolean;
  dist: boolean;
}

export interface SidebarProps {
  specs: BoardSpecs | null;
  units: LengthUnit;

  resize: ResizeFields;
  setResize: Dispatch<SetStateAction<ResizeFields>>;
  applyResize: () => void;

  meta: BoardMeta;
  setMeta: Dispatch<SetStateAction<BoardMeta>>;

  foamType: FoamType;
  glassSchedule: GlassSchedule;
  weight: WeightBreakdown | null;

  trace: UseTrace;
  /** Open the OS file picker for a given view's trace image. */
  onLoadTrace: (view: TraceView) => void;

  overlayToggles: OverlayToggles;
  /** Turn one overlay on or off (reported as `overlay_toggled`). */
  setOverlay: (key: keyof OverlayToggles, enabled: boolean) => void;

  ghost: boolean;
  ghostSpecs: BoardSpecs | null;

  /**
   * Which tab is active, which is pinned, which sections and spec bands are open, and
   * which of those the user has taken over from the per-view rule.
   */
  sidebar: SidebarState;
  onSidebarChange: (next: SidebarState) => void;
  /**
   * Desktop tier: lay the strip out vertically beside the panel and offer the fold.
   * In the sheet the tabs become a row and the snap points already are the collapse, so
   * a second fold control there would be one too many.
   */
  collapsible?: boolean;

  /**
   * Change the display unit. Supplied only when the toolbar has no room for the
   * picker (the phone tier), so exactly one of the two is ever mounted.
   */
  onUnitChange?: (key: string) => void;
}

/**
 * Memoized: every prop is stable while a point is dragged (specs come from the settled
 * board), so a drag re-renders only the parts that subscribe to the store themselves —
 * the control-point inspector, history — not the whole panel.
 */
export const Sidebar = memo(function Sidebar({
  specs,
  units,
  resize,
  setResize,
  applyResize,
  meta,
  setMeta,
  foamType,
  glassSchedule,
  weight,
  trace,
  onLoadTrace,
  overlayToggles,
  setOverlay,
  ghost,
  ghostSpecs,
  sidebar,
  onSidebarChange,
  collapsible = false,
  onUnitChange,
}: SidebarProps) {
  const past = useSyncExternalStore(boardStore.subscribe, () => boardStore.getState().past);
  const fins = useSyncExternalStore(
    boardStore.subscribe,
    () => boardStore.getState().board?.fins ?? null,
  );

  const overlaysOn = Object.values(overlayToggles).filter(Boolean).length;
  const hasTrace = Boolean(trace.traces.outline || trace.traces.rocker);

  /** Section bodies, keyed by id. A section absent here is not rendered at all. */
  const bodies: Partial<Record<SectionId, ReactNode>> = {
    // Rendered by the Specs tab itself, which owns the readout's collapsible bands.
    // Present here so the section still counts as visible for that tab.
    specs: (
      <SpecsSection
        specs={specs}
        units={units}
        sidebar={sidebar}
        onSidebarChange={onSidebarChange}
      />
    ),
    resize: (
      <ResizeSection
        specs={specs}
        units={units}
        resize={resize}
        setResize={setResize}
        applyResize={applyResize}
      />
    ),
    controlPoint: <ControlPointInspector store={boardStore} units={units} />,
    analysis: <AnalysisSection overlayToggles={overlayToggles} setOverlay={setOverlay} />,
    boardInfo: <BoardInfoSection meta={meta} setMeta={setMeta} />,
    fins: <FinPanel store={boardStore} units={units} />,
    weight: (
      <WeightSection
        foamType={foamType}
        glassSchedule={glassSchedule}
        weight={weight}
        setMeta={setMeta}
      />
    ),
    trace: <TraceSection trace={trace} onLoadTrace={onLoadTrace} units={units} />,
    // Both of these are conditional: an empty undo stack and a board with no ghost
    // have nothing to show, and a header promising otherwise is worse than no header.
    ...(past.length > 0 ? { history: <HistorySection past={past} /> } : {}),
    ...(ghost && specs && ghostSpecs
      ? { compare: <CompareSection specs={specs} ghostSpecs={ghostSpecs} units={units} /> }
      : {}),
  };

  /** Header digests — what a shut section is still worth reading. */
  const summaries: Partial<Record<SectionId, ReactNode>> = {
    specs: specs ? fmtVol(specs.volume) : undefined,
    analysis: overlaysOn > 0 ? `${overlaysOn} on` : undefined,
    boardInfo: meta.model || undefined,
    fins: fins ? FIN_SETUP_LABELS[fins.setup] : undefined,
    weight: weight ? fmtWeight(weight.total) : undefined,
    history: `${past.length} step${past.length === 1 ? '' : 's'}`,
  };

  const tabs = shownTabs(sidebar);

  return (
    <aside
      aria-label="Board panels"
      // A column in both mounts now, so the support bar can span the full width along
      // the bottom. Above it, the desktop tier puts the strip beside the panel while the
      // sheet stacks a row of tabs over it.
      className={cn('flex min-h-0 shrink-0 flex-col', collapsible ? '' : 'w-full')}
    >
      <div className={cn('flex min-h-0 flex-1 gap-2', collapsible ? 'flex-row' : 'flex-col')}>
        <TabStrip
          sidebar={sidebar}
          onSidebarChange={onSidebarChange}
          specs={specs}
          units={units}
          vertical={collapsible}
          hasTrace={hasTrace}
        />

        {!(collapsible && sidebar.collapsed) && (
          <div
            className={cn(
              'flex min-h-0 flex-col gap-2',
              collapsible ? `${SIZING.panel} flex-1` : 'w-full',
            )}
          >
            {/* First, deliberately: the sheet opens at `half` and everything past the
              first panel is already below the fold there, so a control banished from
              the toolbar must not land somewhere worse than where it came from. */}
            {onUnitChange && (
              <Panel>
                <PanelBody className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <span className="text-muted-foreground">Display units</span>
                  <UnitSelect value={units.key} onChange={onUnitChange} />
                </PanelBody>
              </Panel>
            )}

            {tabs.map((id, i) => {
              const isPinnedSlot = tabs.length === 2 && i === 0;
              return (
                <TabPanel
                  key={id}
                  tab={id}
                  sidebar={sidebar}
                  onSidebarChange={onSidebarChange}
                  bodies={bodies}
                  summaries={summaries}
                  hasTrace={hasTrace}
                  specs={specs}
                  units={units}
                  /* The pinned panel is a reference held on screen, so it yields height
                   to the one being worked in rather than splitting evenly. */
                  className={cn(
                    isPinnedSlot ? `${SIZING.pinnedPanel} shrink-0` : 'min-h-0 flex-1',
                    collapsible && 'overflow-hidden',
                  )}
                  /* A pinned panel taller than its slot was cutting a spec row in half,
                   which reads as broken rather than as "there is more below". Fading the
                   last few pixels says it continues; over content that already fits, it
                   falls on empty space and shows nothing. */
                  fade={isPinnedSlot}
                  collapsible={collapsible}
                  showFold={collapsible && !isPinnedSlot}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* Pinned across the bottom of the whole sidebar, not tucked into the strip:
          the ask is the same at every width, and it is the last thing left when
          everything else folds away. Narrow, it is the cup alone. */}
      <SupportFooter compact={collapsible && sidebar.collapsed} sticky={!collapsible} />
    </aside>
  );
});

/**
 * The permanent tab strip: four tools groups that no open panel can displace.
 *
 * This is the edge tab strip (JetBrains tool window bars, Blender's sidebar tabs). The
 * captions are upright rather than rotated on purpose: rotated labels are what Blender
 * ships and what its own users keep asking it to stop shipping, and the point here was
 * tabs you can read at a glance. Upright costs ~32px of width and buys that back.
 *
 * Vertical on the desktop, a horizontal row in the bottom sheet — where a 64px column of
 * tabs would eat a fifth of the sheet's height, which is the axis that is actually scarce
 * there.
 */
function TabStrip({
  sidebar,
  onSidebarChange,
  specs,
  units,
  vertical,
  hasTrace,
}: {
  sidebar: SidebarState;
  onSidebarChange: (next: SidebarState) => void;
  specs: BoardSpecs | null;
  units: LengthUnit;
  vertical: boolean;
  hasTrace: boolean;
}) {
  const shown = new Set(shownTabs(sidebar));
  return (
    <div
      className={cn(
        'flex shrink-0 gap-0.5',
        vertical
          ? `${SIZING.strip} flex-col rounded-lg border border-border bg-card py-0.5`
          : 'no-scrollbar w-full flex-row items-stretch overflow-x-auto',
      )}
    >
      <div
        role="tablist"
        aria-label="Sidebar tools"
        aria-orientation={vertical ? 'vertical' : 'horizontal'}
        className={cn('flex gap-0.5', vertical ? 'flex-col px-0.5' : 'flex-row')}
      >
        {SIDEBAR_TABS.map((tab) => {
          const Icon = TAB_ICONS[tab.id];
          const active = sidebar.activeTab === tab.id && !sidebar.collapsed;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              aria-label={tab.title}
              title={tab.title}
              onClick={() => onSidebarChange(selectTab(sidebar, tab.id))}
              className={cn(
                'relative flex items-center rounded-md transition-colors',
                vertical
                  ? // Tight on purpose: a 16px icon over a 9px caption needs ~30px, and
                    // the strip is chrome — every row it takes is a row of tools it is
                    // standing in for. The coarse floor still applies to a finger.
                    'min-h-11 flex-col justify-center gap-0.5 px-0.5 py-1 pointer-coarse:min-h-12'
                  : 'min-h-9 shrink-0 flex-row px-2.5 py-1 pointer-coarse:min-h-11',
                active
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
              )}
            >
              <Icon aria-hidden className="size-4 shrink-0" />
              <span
                className={cn(
                  'font-semibold uppercase tracking-wide',
                  vertical ? 'text-[9px] leading-none' : 'ml-1 text-[11px]',
                )}
              >
                {tab.label}
              </span>
              {/* A pinned tab that is not the active one is still on screen; without
                  this the strip claims otherwise. */}
              {shown.has(tab.id) && !active && (
                <span
                  aria-hidden
                  className={cn(
                    'absolute size-1.5 rounded-full bg-primary',
                    vertical ? 'right-1 top-1' : 'right-1 top-1',
                  )}
                />
              )}
              {/* Trace holds state you cannot otherwise see from a shut tab. */}
              {tab.id === 'reference' && hasTrace && !shown.has(tab.id) && (
                <span
                  aria-hidden
                  className="absolute right-1 top-1 size-1.5 rounded-full bg-muted-foreground"
                />
              )}
            </button>
          );
        })}
      </div>

      {vertical && (
        <>
          {/* The readout lives in the strip, so it is never the thing that goes away.
              Folded, it is all that is left, which is what issue #37 asked not to lose.
              Expanded, it is what makes exclusive tabs lossless: resizing happens in
              Shape and the result is a Specs number, and without this you would edit in
              one tab and have to change tabs to see what you did.

              Rotated, unlike the tab captions: 64px cannot hold "1879.6 mm" upright (it
              truncated to "1879.6 m…") while the strip has hundreds of pixels of unused
              height below the tabs. Captions are what you scan and stay upright; this is
              a number you glance at, and here the width is the binding constraint. */}
          <div className="flex min-h-0 flex-1 justify-center overflow-hidden py-2">
            {specs && (
              <span className="whitespace-nowrap font-mono text-[11px] tabular-nums text-muted-foreground [writing-mode:vertical-rl]">
                {fmtDimsHeadline(specs.length, specs.maxWidth, specs.thickness, units)}
                <span className="text-primary"> · {fmtVol(specs.volume)}</span>
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * One tab's panel: its sections as an accordion, under a header carrying the pin, the
 * master collapse and (for the working panel) the fold.
 */
function TabPanel({
  tab,
  sidebar,
  onSidebarChange,
  bodies,
  summaries,
  hasTrace,
  specs,
  units,
  className,
  collapsible,
  showFold,
  fade = false,
}: {
  tab: TabId;
  sidebar: SidebarState;
  onSidebarChange: (next: SidebarState) => void;
  bodies: Partial<Record<SectionId, ReactNode>>;
  summaries: Partial<Record<SectionId, ReactNode>>;
  hasTrace: boolean;
  specs: BoardSpecs | null;
  units: LengthUnit;
  className?: string;
  collapsible: boolean;
  showFold: boolean;
  fade?: boolean;
}) {
  const meta = tabById(tab);
  const sections = sectionsInTab(tab).filter((s) => bodies[s.id] !== undefined);
  const ids = sections.map((s) => s.id);
  const open = new Set(sidebar.open);
  const pinned = sidebar.pinnedTab === tab;

  // A tab that holds exactly one tool renders it bare: wrapping a lone section in its
  // own header, inside a panel that already names the tab, is a click that reveals
  // nothing — and on the Specs tab it would be an accordion nested in an accordion.
  //
  // Keyed on the registry, not on how many happen to be visible right now. Reference
  // holds three tools of which two are gated (an empty undo stack, no ghost board), and
  // a tab that renders headerless until you make an edit and then grows headers is a
  // panel that changes shape as you use it.
  const bare = sectionsInTab(tab).length === 1;

  // On the Specs tab the master toggle governs the readout's four bands; everywhere else
  // it governs that tab's sections. Either way it acts on what is actually on screen.
  const isSpecs = tab === 'specs';
  const expanded = isSpecs ? sidebar.specGroups.length > 0 : anyOpen(sidebar, ids);
  const toggleAll = () =>
    onSidebarChange(
      isSpecs ? setAllSpecGroups(sidebar, !expanded) : setAll(sidebar, !expanded, ids),
    );

  return (
    <section aria-label={meta.title} className={cn('flex flex-col', className)}>
      <div className="flex h-8 shrink-0 items-center gap-1 pointer-coarse:h-11">
        <h2 className="min-w-0 flex-1 truncate px-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
          {meta.title}
        </h2>
        <IconButton
          label={pinned ? `Unpin ${meta.title}` : `Pin ${meta.title} open`}
          onClick={() => onSidebarChange(togglePin(sidebar, tab))}
        >
          {pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
        </IconButton>
        {sections.length > 1 || isSpecs ? (
          <IconButton
            label={expanded ? 'Collapse all sections' : 'Expand all sections'}
            onClick={toggleAll}
          >
            {expanded ? (
              <ChevronsDownUp className="size-3.5" />
            ) : (
              <ChevronsUpDown className="size-3.5" />
            )}
          </IconButton>
        ) : null}
        {showFold && (
          <IconButton
            label="Hide board panels"
            onClick={() => onSidebarChange({ ...sidebar, collapsed: true })}
          >
            <ChevronRight className="size-3.5" />
          </IconButton>
        )}
      </div>

      <div
        className={cn(
          'flex min-h-0 flex-col gap-2 pb-2',
          // Only the desktop mount scrolls here; in the sheet the sheet body scrolls
          // and a bounded scroller would fight it.
          collapsible && 'flex-1 overflow-y-auto pr-0.5',
          fade && '[mask-image:linear-gradient(to_bottom,black_calc(100%-14px),transparent)]',
        )}
      >
        {bare
          ? sections.map((s) => (
              <div key={s.id}>
                {isSpecs ? (
                  <SpecsSection
                    specs={specs}
                    units={units}
                    sidebar={sidebar}
                    onSidebarChange={onSidebarChange}
                  />
                ) : (
                  bodies[s.id]
                )}
              </div>
            ))
          : sections.map((s) => (
              <Disclosure
                key={s.id}
                title={s.title}
                open={open.has(s.id)}
                onOpenChange={(v) => onSidebarChange(toggleSection(sidebar, s.id, v))}
                summary={summaries[s.id]}
                marked={s.id === 'trace' && hasTrace}
              >
                {bodies[s.id]}
              </Disclosure>
            ))}
      </div>
    </section>
  );
}

/** A square icon button sized for both pointer kinds. */
function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground pointer-coarse:size-11"
      >
        {children}
      </button>
    </Tooltip>
  );
}

/**
 * The support ask, a bar across the bottom of the sidebar.
 *
 * It used to be a three-line card at the bottom of an eleven-panel scroll, which in
 * practice meant it was never on screen at all. Pinned across the bottom it is a
 * smaller ask and a far louder one — outside every scroller, present at every tier, and
 * the last thing standing when the panel folds away.
 *
 * `compact` is the folded sidebar, where there is room for the cup and nothing else. The
 * label is dropped rather than truncated: "Buy me a c…" is worse than the icon alone,
 * and the icon still carries its title and accessible name.
 */
function SupportFooter({
  compact = false,
  sticky = false,
}: {
  compact?: boolean;
  sticky?: boolean;
}) {
  if (!SUPPORT_URL) return null;
  return (
    <a
      href={SUPPORT_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Buy me a coffee"
      title="Buy me a coffee — OpenShaper is free & open-source"
      className={cn(
        'mt-2 flex shrink-0 items-center gap-2 rounded-lg border border-border bg-card text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground',
        SIZING.support,
        compact ? 'justify-center px-0' : 'px-2.5',
        // In the sheet the sheet body is the scroller and the bar is inside it, so flex
        // alone would leave it at the end of a long scroll — which is exactly where this
        // ask used to go unseen. Sticky is safe at the bottom in a way it was not at the
        // top: the bar that had to stop being sticky was covering section headers that
        // scroll-into-view parks against the top edge.
        sticky && 'sticky bottom-0 z-10',
      )}
    >
      <CoffeeIcon className="size-4 shrink-0 text-primary" />
      {!compact && <span className="truncate">Buy me a coffee</span>}
    </a>
  );
}

/**
 * A band of the readout, collapsible.
 *
 * All four open is nineteen rows — roughly 600px, which filled the whole sidebar on a
 * laptop and is what sent every other tool off-screen. Shut, each header still carries
 * the one number that band is usually consulted for, so collapsing costs information
 * you wanted rather than information you had.
 */
function SpecBand({
  id,
  title,
  summary,
  sidebar,
  onSidebarChange,
  children,
}: {
  id: SpecGroupId;
  title: string;
  summary: ReactNode;
  sidebar: SidebarState;
  onSidebarChange: (next: SidebarState) => void;
  children: ReactNode;
}) {
  return (
    <Disclosure
      headingLevel={3}
      title={title}
      summary={summary}
      open={sidebar.specGroups.includes(id)}
      onOpenChange={(v) => onSidebarChange(toggleSpecGroup(sidebar, id, v))}
    >
      <div className="space-y-1">{children}</div>
    </Disclosure>
  );
}

function SpecsSection({
  specs,
  units,
  sidebar,
  onSidebarChange,
}: {
  specs: BoardSpecs | null;
  units: LengthUnit;
  sidebar: SidebarState;
  onSidebarChange: (next: SidebarState) => void;
}) {
  const interpolationType = useSyncExternalStore(
    boardStore.subscribe,
    () => boardStore.getState().board?.interpolationType ?? 'controlPoint',
  );
  // Brief confirmation after copying the dimensions headline; resets itself.
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(t);
  }, [copied]);

  if (!specs) return <p className="text-sm text-muted-foreground">Loading…</p>;

  return (
    <div className="space-y-2 text-sm">
      <Tooltip label={copied ? 'Copied' : 'Copy dimensions'}>
        <button
          type="button"
          aria-label="Copy dimensions"
          className="flex w-full items-center justify-between gap-2 rounded-md bg-muted/40 px-2 py-1.5 text-left hover:bg-muted pointer-coarse:min-h-11"
          onClick={() => {
            const text = fmtDimsHeadline(specs.length, specs.maxWidth, specs.thickness, units);
            void navigator.clipboard
              ?.writeText(text)
              ?.then(() => setCopied(true))
              ?.catch(() => {});
          }}
        >
          <span className="font-mono text-[13px] tabular-nums text-foreground">
            {fmtDimsHeadline(specs.length, specs.maxWidth, specs.thickness, units)}
          </span>
          {/* Copying changes nothing on screen, so without this the click reads
              as broken — people click again. It was one of the editor's
              most-repeated dead clicks before the tick was added. */}
          {copied ? (
            <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
          ) : (
            <Copy className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
        </button>
      </Tooltip>

      <SpecBand
        id="nose"
        title="Nose"
        summary={`rocker ${fmtLen(specs.noseRocker, units)}`}
        sidebar={sidebar}
        onSidebarChange={onSidebarChange}
      >
        <SpecRow label={'Width @ 12"'} value={fmtLen(specs.noseWidth, units)} />
        <SpecRow label={'Thickness @ 12"'} value={fmtLen(specs.noseThickness, units)} />
        <SpecRow label="Rocker" value={fmtLen(specs.noseRocker, units)} />
        <SpecRow label={'Rocker @ 12"'} value={fmtLen(specs.noseRocker1, units)} />
        {specs.length >= 121.92 && (
          <SpecRow label={'Rocker @ 24"'} value={fmtLen(specs.noseRocker2, units)} />
        )}
      </SpecBand>

      <SpecBand
        id="center"
        title="Center"
        summary={fmtLen(specs.maxWidth, units)}
        sidebar={sidebar}
        onSidebarChange={onSidebarChange}
      >
        <SpecRow label="Width" value={fmtLen(specs.maxWidth, units)} />
        <SpecRow label="Wide point" value={fmtLen(specs.maxWidthPos, units)} />
        <SpecRow label="Center width" value={fmtLen(specs.centerWidth, units)} />
        <SpecRow label="Thickness" value={fmtLen(specs.thickness, units)} />
        <SpecRow label="Max thickness" value={fmtLen(specs.maxThickness, units)} />
      </SpecBand>

      <SpecBand
        id="tail"
        title="Tail"
        summary={`rocker ${fmtLen(specs.tailRocker, units)}`}
        sidebar={sidebar}
        onSidebarChange={onSidebarChange}
      >
        <SpecRow label={'Width @ 12"'} value={fmtLen(specs.tailWidth, units)} />
        <SpecRow label={'Thickness @ 12"'} value={fmtLen(specs.tailThickness, units)} />
        <SpecRow label="Rocker" value={fmtLen(specs.tailRocker, units)} />
        <SpecRow label={'Rocker @ 12"'} value={fmtLen(specs.tailRocker1, units)} />
        {specs.length >= 121.92 && (
          <SpecRow label={'Rocker @ 24"'} value={fmtLen(specs.tailRocker2, units)} />
        )}
      </SpecBand>

      <SpecBand
        id="overall"
        title="Overall"
        summary={fmtVol(specs.volume)}
        sidebar={sidebar}
        onSidebarChange={onSidebarChange}
      >
        <SpecRow label="Length" value={fmtLen(specs.length, units)} />
        <SpecRow label="Length o/curve" value={fmtLen(specs.lengthOverCurve, units)} />
        <SpecRow label="Max rocker" value={fmtLen(specs.maxRocker, units)} />
        <SpecRow label="Volume" value={fmtVol(specs.volume)} />
        <SpecRow label="Center of mass" value={fmtLen(specs.centerOfMass, units)} />
      </SpecBand>

      <div className="flex items-center justify-between gap-2 pt-1">
        <span className="text-muted-foreground">Interpolation</span>
        <Sel
          value={interpolationType}
          onChange={(t) => boardStore.getState().setInterpolationType(t)}
          options={[
            { value: 'controlPoint', label: 'Control point' },
            { value: 'sLinear', label: 'S-blend' },
          ]}
          title="Cross-section interpolation model"
        />
      </div>
      <p className="pt-2 text-xs text-muted-foreground">
        Live from the kernel — every pane edits the same board, so changes sync across views and the
        specs update instantly.
      </p>
    </div>
  );
}

function ResizeSection({
  specs,
  units,
  resize,
  setResize,
  applyResize,
}: {
  specs: BoardSpecs | null;
  units: LengthUnit;
  resize: ResizeFields;
  setResize: Dispatch<SetStateAction<ResizeFields>>;
  applyResize: () => void;
}) {
  return (
    <div className="space-y-2 text-sm">
      {(
        [
          ['l', 'Length', specs?.length],
          ['w', 'Width', specs?.maxWidth],
          ['t', 'Thickness', specs?.thickness],
        ] as const
      ).map(([key, label, cur]) => (
        <label key={key} className="flex items-center gap-2">
          <span className="w-16 text-muted-foreground">{label}</span>
          <Input
            value={resize[key]}
            placeholder={cur != null ? fmtLen(cur, units) : ''}
            onChange={(e) => setResize((r) => ({ ...r, [key]: e.target.value }))}
          />
        </label>
      ))}
      <Button size="sm" variant="secondary" disabled={!specs} onClick={applyResize}>
        Apply
      </Button>
      <p className="text-xs text-muted-foreground">
        Blank fields keep that dimension; others scale to the target. Undoable.
      </p>
    </div>
  );
}

/**
 * The most recent labelled undo steps, newest first. Clicking a step reverts the
 * board to just before that action (everything jumped over becomes redoable).
 */
function HistorySection({ past }: { past: readonly { label: string }[] }) {
  const shown = past.slice(-10).reverse();
  return (
    <div className="space-y-0.5 text-sm">
      {shown.map((e, k) => {
        const index = past.length - 1 - k;
        return (
          <button
            key={index}
            type="button"
            title="Revert to before this step"
            className="flex min-h-8 w-full items-center justify-between rounded px-2 py-1 text-left transition-colors hover:bg-accent hover:text-accent-foreground pointer-coarse:min-h-11"
            onClick={() => boardStore.getState().jumpTo(index)}
          >
            <span>{e.label}</span>
            <span className="text-xs text-muted-foreground">#{index + 1}</span>
          </button>
        );
      })}
    </div>
  );
}

function BoardInfoSection({
  meta,
  setMeta,
}: {
  meta: BoardMeta;
  setMeta: Dispatch<SetStateAction<BoardMeta>>;
}) {
  return (
    <div className="space-y-2 text-sm">
      {(['designer', 'model', 'surfer'] as const).map((field) => (
        <label key={field} className="flex items-center gap-2">
          <span className="w-16 capitalize text-muted-foreground">{field}</span>
          <Input
            value={meta[field] ?? ''}
            placeholder="—"
            onChange={(e) => setMeta((m) => ({ ...m, [field]: e.target.value }))}
          />
        </label>
      ))}
      <Textarea
        value={meta.comments ?? ''}
        placeholder="Comments…"
        onChange={(e) => setMeta((m) => ({ ...m, comments: e.target.value }))}
        rows={2}
        className="resize-none"
      />
    </div>
  );
}

function WeightSection({
  foamType,
  glassSchedule,
  weight,
  setMeta,
}: {
  foamType: FoamType;
  glassSchedule: GlassSchedule;
  weight: WeightBreakdown | null;
  setMeta: Dispatch<SetStateAction<BoardMeta>>;
}) {
  return (
    <div className="space-y-2 text-sm">
      <div className="flex gap-2">
        <Sel
          value={foamType}
          onChange={(f) => setMeta((m) => ({ ...m, foamType: f }))}
          options={FOAM_TYPES.map((f) => ({ value: f, label: f }))}
          title="Foam type"
        />
        <Sel
          value={glassSchedule}
          onChange={(g) => setMeta((m) => ({ ...m, glassSchedule: g }))}
          options={GLASS_SCHEDULES.map((g) => ({ value: g, label: `${g} oz` }))}
          title="Glass schedule"
        />
      </div>
      {weight ? (
        <>
          <SpecRow label="Foam" value={fmtWeight(weight.foam)} />
          <SpecRow label="Glass" value={fmtWeight(weight.cloth)} />
          <SpecRow label="Resin" value={fmtWeight(weight.resin)} />
          <SpecRow label="Hardware" value={fmtWeight(weight.hardware)} />
          <div className="border-t border-border pt-1 font-semibold">
            <SpecRow label="Total" value={fmtWeight(weight.total)} />
          </div>
        </>
      ) : (
        <p className="text-muted-foreground">—</p>
      )}
    </div>
  );
}

const OVERLAYS: readonly { key: keyof OverlayToggles; label: string }[] = [
  { key: 'grid', label: 'Grid & guides' },
  { key: 'comb', label: 'Curvature comb' },
  { key: 'com', label: 'Center of mass' },
  { key: 'dist', label: 'Volume distribution' },
];

function AnalysisSection({
  overlayToggles,
  setOverlay,
}: {
  overlayToggles: OverlayToggles;
  setOverlay: (key: keyof OverlayToggles, enabled: boolean) => void;
}) {
  return (
    <div className="space-y-1 text-sm">
      {OVERLAYS.map(({ key, label }) => (
        <OverlayToggle
          key={key}
          label={label}
          checked={overlayToggles[key]}
          onChange={(v) => setOverlay(key, v)}
        />
      ))}
      <p className="pt-1 text-xs text-muted-foreground">
        Grid &amp; guides show in every pane (baseline + centerline emphasized); comb on the edited
        curves; CoM &amp; volume distribution on the outline and rocker.
      </p>
    </div>
  );
}

function CompareSection({
  specs,
  ghostSpecs,
  units,
}: {
  specs: BoardSpecs;
  ghostSpecs: BoardSpecs;
  units: LengthUnit;
}) {
  return (
    <div className="space-y-1 text-sm">
      <SpecRow label="Length" value={diffLen(specs.length, ghostSpecs.length, units)} />
      <SpecRow label="Width" value={diffLen(specs.maxWidth, ghostSpecs.maxWidth, units)} />
      <SpecRow label="Thickness" value={diffLen(specs.thickness, ghostSpecs.thickness, units)} />
      <SpecRow label="Volume" value={diffVol(specs.volume, ghostSpecs.volume)} />
      <p className="pt-1 text-xs text-muted-foreground">Dashed grey curves are the ghost board.</p>
    </div>
  );
}

/** Trace-image controls: per-view load/clear, opacity, mirror, and the two calibration flows. */
function TraceSection({
  trace,
  onLoadTrace,
  units,
}: {
  trace: UseTrace;
  onLoadTrace: (view: TraceView) => void;
  units: LengthUnit;
}) {
  const [lenText, setLenText] = useState('');
  const view = trace.activeView;
  const img = trace.traces[view];
  const submitLength = () => {
    trace.applyLength(parseLen(lenText, units));
    setLenText('');
  };
  return (
    <div className="space-y-2 text-sm">
      <div className="flex gap-1">
        {(['outline', 'rocker'] as TraceView[]).map((v) => (
          <Button
            key={v}
            size="sm"
            variant={view === v ? 'secondary' : 'ghost'}
            onClick={() => trace.setActiveView(v)}
          >
            {v === 'outline' ? 'Outline' : 'Rocker'}
            {trace.traces[v] ? ' ●' : ''}
          </Button>
        ))}
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="ghost" onClick={() => onLoadTrace(view)}>
          {img ? 'Replace…' : 'Load image…'}
        </Button>
        {img && (
          <Button size="sm" variant="ghost" onClick={() => trace.clear(view)}>
            Clear
          </Button>
        )}
      </div>
      {img && (
        <>
          {/* Visible, not loaded: the image stays in place either way, so a
              trace hidden to look at a shared board comes straight back. */}
          <label className="flex items-center gap-2">
            <Checkbox
              checked={trace.visible[view]}
              onChange={(e) => trace.setVisible(view, e.target.checked)}
            />
            <span className="text-muted-foreground">
              Show {view === 'outline' ? 'outline' : 'rocker'} trace
            </span>
          </label>
          <label className="flex items-center gap-2">
            <span className="w-14 text-muted-foreground">Opacity</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={img.opacity}
              onChange={(e) => trace.setOpacity(view, Number(e.target.value))}
              className="flex-1"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" onClick={() => trace.beginAlign(view)}>
              Align (4-click)
            </Button>
            <Button size="sm" variant="ghost" onClick={() => trace.beginLength(view)}>
              Set scale…
            </Button>
            <Button size="sm" variant="ghost" onClick={() => trace.flip(view)}>
              Flip
            </Button>
          </div>
          {trace.calibration && (
            // Escape was the ONLY way out of a calibration: `cancelCalibration` was
            // exported from the hook and called by nothing, so a phone user who
            // started one by mistake had to complete all four taps or reload the
            // page. The button is the escape hatch; the key still works for anyone
            // who has one.
            <div className="flex items-center justify-between gap-2">
              <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                Follow the prompts on the {view} view.
              </p>
              <Button
                size="sm"
                variant="ghost"
                className="shrink-0"
                onClick={trace.cancelCalibration}
              >
                Cancel
              </Button>
            </div>
          )}
          {trace.lengthPending && (
            <label className="flex items-center gap-2">
              <span className="shrink-0 text-muted-foreground">Distance</span>
              <Input
                autoFocus
                value={lenText}
                placeholder="e.g. 30in"
                onChange={(e) => setLenText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitLength();
                }}
              />
              <Button size="sm" variant="secondary" onClick={submitLength}>
                Set
              </Button>
            </label>
          )}
          <p className="text-xs text-muted-foreground">
            Drag the image to move, use the top handle to rotate. Align maps two image points onto
            two drawing points (auto-scales); Set scale uses a typed real-world distance.
          </p>
        </>
      )}
    </div>
  );
}
