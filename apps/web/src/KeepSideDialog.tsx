// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Asked when an asymmetric NURBS board goes back to mirror symmetry: the board keeps one half's outline
 * and sections and mirrors it, so the other half is dropped (undo brings it back). The sides are named
 * as the outline view draws them (docs/design/m2-editor.md §2).
 */
import { Button, Panel, PanelBody, PanelHeader, PanelTitle } from '@openshaper/ui';
import type { KeepSide } from '@openshaper/store/sections';
import { Modal } from './components/modal';

export interface KeepSideDialogProps {
  onKeep: (side: KeepSide) => void;
  onCancel: () => void;
}

export function KeepSideDialog({ onKeep, onCancel }: KeepSideDialogProps) {
  return (
    <Modal
      name="keep-side"
      label="Make the board symmetric"
      onClose={onCancel}
      className="grid place-items-center p-4"
    >
      <Panel className="flex w-full max-w-sm flex-col" onClick={(e) => e.stopPropagation()}>
        <PanelHeader>
          <PanelTitle>Make the board symmetric</PanelTitle>
        </PanelHeader>
        <PanelBody className="space-y-4 text-sm">
          <p className="text-muted-foreground">
            The board is mirrored from one half, so the other half&rsquo;s outline and
            cross-sections are dropped. Which half do you keep? You can undo this.
          </p>
          <div className="flex flex-col gap-2">
            <Button onClick={() => onKeep('plus')}>Keep the upper rail</Button>
            <Button onClick={() => onKeep('minus')}>Keep the lower rail</Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Upper and lower are as the outline view draws them, with the nose to the right.
          </p>
          <div className="flex justify-end">
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </PanelBody>
      </Panel>
    </Modal>
  );
}
