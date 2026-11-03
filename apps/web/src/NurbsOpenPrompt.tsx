// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * "This board uses the NURBS engine" — what opening a NURBS document (an opened `.board` file, a share
 * link, a recent board) asks when the engine is off (docs/design/m2-editor.md §5). The document cannot be
 * edited by the classic editors, so there are two honest answers and a way out:
 *
 * - **Turn on and open.** The engine setting is saved and the document opens in the NURBS editors.
 * - **Open a classic copy.** The classic projection of the document opens in the classic editors. It is
 *   a copy: the file is not changed, saving writes a classic file, and what the classic model has no place
 *   for (the minus half of an asymmetric board, bottom features, the smooth blend between stations) is
 *   not in it.
 *
 * The board's name comes from a file or a stranger's link, so it renders as plain text.
 */
import { Button, Panel, PanelBody, PanelHeader, PanelTitle } from '@openshaper/ui';
import { Modal } from './components/modal';

export interface NurbsOpenPromptProps {
  /** The document's name, when it has one. */
  name?: string;
  onTurnOn: () => void;
  onOpenCopy: () => void;
  onCancel: () => void;
}

export function NurbsOpenPrompt({ name, onTurnOn, onOpenCopy, onCancel }: NurbsOpenPromptProps) {
  return (
    <Modal
      name="nurbs-open"
      label="Open NURBS board?"
      onClose={onCancel}
      closeOnBackdrop={false}
      className="ph-no-capture grid place-items-center p-4"
    >
      <Panel className="flex w-full max-w-md flex-col">
        <PanelHeader>
          <PanelTitle>This board uses the NURBS engine</PanelTitle>
        </PanelHeader>
        <PanelBody className="space-y-3 text-sm">
          <p>
            {name ? (
              <>
                <strong>{name}</strong> is
              </>
            ) : (
              'This file is'
            )}{' '}
            a NURBS board. The NURBS engine is experimental and is turned off.
          </p>
          <p className="text-muted-foreground">
            <strong>Turn on and open</strong> saves the setting and opens the board in the NURBS
            editors. <strong>Open a classic copy</strong> opens a copy in the classic editors,
            without the second half of an asymmetric board, its bottom features or the smooth blend
            between its stations. The file itself is not changed either way.
          </p>
        </PanelBody>
        <div className="flex flex-wrap justify-end gap-2 border-t border-border px-4 py-3">
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" variant="secondary" onClick={onOpenCopy}>
            Open a classic copy
          </Button>
          <Button size="sm" onClick={onTurnOn}>
            Turn on and open
          </Button>
        </div>
      </Panel>
    </Modal>
  );
}
