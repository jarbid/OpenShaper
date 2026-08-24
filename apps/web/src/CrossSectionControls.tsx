import { Button, Tooltip } from '@openshaper/ui';
import { ChevronLeft, ChevronRight, ClipboardPaste, Copy, Plus, Trash2 } from 'lucide-react';
import { SectionPositionEditor } from './SectionPositionEditor';
import type { LengthUnit } from './format';
import { shortcutKeys } from './shortcuts';

export interface CrossSectionControlsProps {
  index: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  onAdd: () => void;
  onDelete: () => void;
  onCopy: () => void;
  onPaste: () => void;
  canPaste: boolean;
  /** Length position of the current station, or null before a board loads. */
  positionCm: number | null;
  units: LengthUnit;
  onMoveTo: (cm: number) => void;
}

/**
 * Compact cross-section management cluster for the cross-section pane header (quad +
 * standalone). Icon buttons keep it small enough for the quad-view cell. Mirrors the
 * legacy BoardCAD-LE Cross-sections menu: navigate, add, delete, copy, paste.
 *
 * Every button is icon-only, so each is wrapped in a `Tooltip` — `aria-label` alone
 * covers screen readers but leaves sighted users guessing at a glyph.
 */
export function CrossSectionControls({
  index,
  total,
  onPrev,
  onNext,
  onAdd,
  onDelete,
  onCopy,
  onPaste,
  canPaste,
  positionCm,
  units,
  onMoveTo,
}: CrossSectionControlsProps) {
  const icon = 'h-7 w-7 p-0';
  return (
    <div className="flex items-center gap-0.5">
      <Tooltip label="Previous cross-section" shortcut={shortcutKeys('cross-section-prev')}>
        <Button
          size="sm"
          variant="ghost"
          className={icon}
          disabled={index <= 1}
          onClick={onPrev}
          aria-label="Previous cross-section"
        >
          <ChevronLeft />
        </Button>
      </Tooltip>
      <span className="min-w-10 px-0.5 text-center text-xs tabular-nums text-muted-foreground">
        {index}/{total}
      </span>
      <Tooltip label="Next cross-section" shortcut={shortcutKeys('cross-section-next')}>
        <Button
          size="sm"
          variant="ghost"
          className={icon}
          disabled={index >= total}
          onClick={onNext}
          aria-label="Next cross-section"
        >
          <ChevronRight />
        </Button>
      </Tooltip>
      <span className="mx-0.5 h-5 w-px bg-border" />
      {positionCm !== null && (
        <>
          <SectionPositionEditor valueCm={positionCm} units={units} onCommit={onMoveTo} />
          <span className="mx-0.5 h-5 w-px bg-border" />
        </>
      )}
      <Tooltip label="Add a cross-section here">
        <Button
          size="sm"
          variant="ghost"
          className={icon}
          onClick={onAdd}
          aria-label="Add cross-section"
        >
          <Plus />
        </Button>
      </Tooltip>
      <Tooltip label="Delete this cross-section">
        <Button
          size="sm"
          variant="ghost"
          className={icon}
          disabled={total <= 1}
          onClick={onDelete}
          aria-label="Delete cross-section"
        >
          <Trash2 />
        </Button>
      </Tooltip>
      <Tooltip label="Copy this cross-section">
        <Button
          size="sm"
          variant="ghost"
          className={icon}
          onClick={onCopy}
          aria-label="Copy cross-section"
        >
          <Copy />
        </Button>
      </Tooltip>
      <Tooltip label="Paste the copied cross-section shape here">
        <Button
          size="sm"
          variant="ghost"
          className={icon}
          disabled={!canPaste}
          onClick={onPaste}
          aria-label="Paste cross-section"
        >
          <ClipboardPaste />
        </Button>
      </Tooltip>
    </div>
  );
}
