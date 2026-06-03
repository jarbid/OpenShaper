import { Button } from '@openshaper/ui';
import { ChevronLeft, ChevronRight, ClipboardPaste, Copy, Plus, Trash2 } from 'lucide-react';

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
}

/**
 * Compact cross-section management cluster for the cross-section pane header (quad +
 * standalone). Icon buttons keep it small enough for the quad-view cell. Mirrors the
 * legacy BoardCAD-LE Cross-sections menu: navigate, add, delete, copy, paste.
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
}: CrossSectionControlsProps) {
  const icon = 'h-7 w-7 p-0';
  return (
    <div className="flex items-center gap-0.5">
      <Button
        size="sm"
        variant="ghost"
        className={icon}
        disabled={index <= 1}
        onClick={onPrev}
        aria-label="Previous cross-section"
        title="Previous cross-section ( [ )"
      >
        <ChevronLeft />
      </Button>
      <span className="min-w-10 px-0.5 text-center text-xs tabular-nums text-muted-foreground">
        {index}/{total}
      </span>
      <Button
        size="sm"
        variant="ghost"
        className={icon}
        disabled={index >= total}
        onClick={onNext}
        aria-label="Next cross-section"
        title="Next cross-section ( ] )"
      >
        <ChevronRight />
      </Button>
      <span className="mx-0.5 h-5 w-px bg-border" />
      <Button
        size="sm"
        variant="ghost"
        className={icon}
        onClick={onAdd}
        aria-label="Add cross-section"
        title="Add a cross-section here"
      >
        <Plus />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className={icon}
        disabled={total <= 1}
        onClick={onDelete}
        aria-label="Delete cross-section"
        title="Delete this cross-section"
      >
        <Trash2 />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className={icon}
        onClick={onCopy}
        aria-label="Copy cross-section"
        title="Copy this cross-section"
      >
        <Copy />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className={icon}
        disabled={!canPaste}
        onClick={onPaste}
        aria-label="Paste cross-section"
        title="Paste the copied cross-section shape here"
      >
        <ClipboardPaste />
      </Button>
    </div>
  );
}
