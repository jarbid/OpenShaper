import { Button, ContextMenu, Tooltip, type MenuItem } from '@openshaper/ui';
import {
  ChevronLeft,
  ChevronRight,
  ClipboardPaste,
  Copy,
  MoreHorizontal,
  Plus,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { SectionPositionEditor } from './SectionPositionEditor';
import type { LengthUnit } from './format';
import { shortcutKeys } from './shortcuts';
import { useIsCoarsePointer } from './useMediaQuery';

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
  /** Marks a converted position (e.g. " o/c" when measured over the curve). */
  positionMark?: string;
  units: LengthUnit;
  onMoveTo: (cm: number) => void;
}

/**
 * Cross-section management cluster for the cross-section pane header (quad +
 * standalone). Mirrors the legacy BoardCAD-LE Cross-sections menu: navigate, add,
 * delete, copy, paste.
 *
 * **It does not all fit on a phone, and it never did.** Seven icon buttons plus the
 * position field measured 362px against a 334px header at 360px wide, so "Copy" and
 * "Paste" rendered from 341px to 399px — entirely off-screen, with nothing to scroll
 * and no sign they existed. Raising the buttons to the 44px touch floor would have
 * taken the row past 480px and pushed the whole document wider than the viewport.
 *
 * So on a coarse pointer the four *editing* actions collapse into one overflow menu
 * and the header keeps what a phone is actually for: step through the stations, read
 * and adjust where this one sits. Nothing is removed — the menu carries the same four
 * commands with real labels, which on touch is a gain in its own right, since
 * `Tooltip` suppresses itself for `pointerType === 'touch'` and left these glyphs
 * unexplained.
 *
 * The condition is the pointer, not the screen size, because it is the 44px targets
 * that stop the row fitting — and a tablet in quad view has both the coarse pointer
 * and a narrow pane.
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
  positionMark,
  units,
  onMoveTo,
}: CrossSectionControlsProps) {
  const coarse = useIsCoarsePointer();
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const icon = 'h-7 w-7 p-0';

  const editActions: { label: string; onSelect: () => void; disabled?: boolean }[] = [
    { label: 'Add cross-section here', onSelect: onAdd },
    { label: 'Delete this cross-section', onSelect: onDelete, disabled: total <= 1 },
    { label: 'Copy this cross-section', onSelect: onCopy },
    { label: 'Paste the copied shape here', onSelect: onPaste, disabled: !canPaste },
  ];

  const menuItems: MenuItem[] = editActions.map((a) => ({
    kind: 'action',
    label: a.label,
    onSelect: a.onSelect,
    disabled: a.disabled,
    // Say why a greyed row is greyed, rather than leaving a dead end.
    title: a.disabled
      ? a.label.startsWith('Delete')
        ? 'A board needs at least one cross-section'
        : 'Nothing copied yet'
      : undefined,
  }));

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
      <span className="min-w-10 px-0.5 text-center text-xs tabular-nums text-muted-foreground pointer-coarse:min-w-8">
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
          <SectionPositionEditor
            valueCm={positionCm}
            units={units}
            mark={positionMark}
            onCommit={onMoveTo}
          />
          <span className="mx-0.5 h-5 w-px bg-border" />
        </>
      )}
      {coarse ? (
        <>
          <Button
            size="sm"
            variant="ghost"
            className={icon}
            aria-label="More cross-section actions"
            aria-haspopup="menu"
            aria-expanded={menuAt !== null}
            onClick={(e) => {
              // Anchor under the button rather than at the pointer: a tap point is
              // wherever the fingertip landed, and the menu should not shift with it.
              const r = e.currentTarget.getBoundingClientRect();
              setMenuAt(menuAt ? null : { x: r.left, y: r.bottom + 4 });
            }}
          >
            <MoreHorizontal />
          </Button>
          {menuAt && (
            <ContextMenu
              x={menuAt.x}
              y={menuAt.y}
              items={menuItems}
              onClose={() => setMenuAt(null)}
            />
          )}
        </>
      ) : (
        <>
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
        </>
      )}
    </div>
  );
}
