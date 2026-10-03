// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * "Open shared board?" — the one gate between a link and someone's own work.
 *
 * Only shown when there *is* work to lose: a shared link opened into an empty
 * browser opens straight away. The shared board is not in the editor yet when
 * this appears — it is held in memory, undecoded into the store — so **Keep
 * current** is genuinely a no-op and nothing needs undoing.
 *
 * The board name comes from a stranger's metadata, so it renders as plain text
 * in a fixed sentence and the dialog is excluded from replay capture along with
 * the rest of the share feature.
 */
import { Button, Panel, PanelBody, PanelHeader, PanelTitle } from '@openshaper/ui';
import { Modal } from './components/modal';

export interface SharedBoardPromptProps {
  /** The shared board's model name, when it has one. */
  model?: string;
  onKeepCurrent: () => void;
  onOpenShared: () => void;
}

export function SharedBoardPrompt({ model, onKeepCurrent, onOpenShared }: SharedBoardPromptProps) {
  return (
    <Modal
      name="shared-board"
      label="Open shared board?"
      onClose={onKeepCurrent}
      closeOnBackdrop={false}
      className="ph-no-capture grid place-items-center p-4"
    >
      <Panel className="flex w-full max-w-md flex-col">
        <PanelHeader>
          <PanelTitle>Open shared board?</PanelTitle>
        </PanelHeader>
        <PanelBody className="space-y-3 text-sm">
          <p>
            You followed a share link
            {model ? (
              <>
                {' '}
                for <strong>{model}</strong>
              </>
            ) : null}
            , but this browser already has a board open.
          </p>
          <p className="text-muted-foreground">
            Opening the shared board replaces your current work, including its undo history. Nothing
            is uploaded either way.
          </p>
        </PanelBody>
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <Button size="sm" variant="ghost" onClick={onKeepCurrent}>
            Keep current
          </Button>
          <Button size="sm" onClick={onOpenShared}>
            Open shared board
          </Button>
        </div>
      </Panel>
    </Modal>
  );
}
