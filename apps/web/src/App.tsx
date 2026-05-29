import { distance, vec2 } from '@board-studio/kernel';

/**
 * Placeholder shell. Phase 3 of the roadmap replaces this with the QuadView
 * (outline / rocker / cross-section / 3D) + spec sidebar. For now it proves the
 * web app builds and consumes the kernel package across the workspace.
 */
export function App() {
  const nose = vec2(0, 0);
  const tail = vec2(72, 0); // 6'0" in inches
  const length = distance(nose, tail);

  return (
    <main
      style={{
        display: 'grid',
        placeItems: 'center',
        height: '100%',
        gap: '0.5rem',
        textAlign: 'center',
      }}
    >
      <div>
        <h1 style={{ margin: 0 }}>Board Studio</h1>
        <p style={{ opacity: 0.7 }}>Modern surfboard CAD/CAM — rebuild in progress.</p>
        <p style={{ opacity: 0.5, fontSize: '0.85rem' }}>
          kernel sanity check: nose→tail = {length}&quot; ({length / 12}&#39;)
        </p>
      </div>
    </main>
  );
}
