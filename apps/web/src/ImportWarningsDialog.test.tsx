import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ImportWarningsDialog } from './ImportWarningsDialog';

const dropped = [{ severity: 'dropped' as const, message: 'removed a flat section at 113.9 cm' }];
const info = [{ severity: 'info' as const, message: 'outline fell back to Top1' }];

describe('<ImportWarningsDialog />', () => {
  it('lists dropped and info messages', () => {
    render(
      <ImportWarningsDialog
        fileName="Go fish.s3dx"
        dropped={dropped}
        info={info}
        onImportAnyway={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText(/removed a flat section/)).toBeTruthy();
    expect(screen.getByText(/fell back to Top1/)).toBeTruthy();
    expect(screen.getByText(/Go fish\.s3dx/)).toBeTruthy();
  });

  it('wires both buttons', () => {
    const onImportAnyway = vi.fn();
    const onCancel = vi.fn();
    render(
      <ImportWarningsDialog
        fileName="x.s3dx"
        dropped={dropped}
        info={[]}
        onImportAnyway={onImportAnyway}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /import anyway/i }));
    expect(onImportAnyway).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
