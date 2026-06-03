/**
 * Technical line-art motifs — thin "construction line" drawings of a surfboard
 * outline and rocker curve, echoing the CAD editor. Used as hero art, section
 * dividers and footer ornament. Pure SVG, no runtime cost.
 */

interface MarkProps {
  className?: string;
  /** Animate the stroke drawing in on mount (hero use). */
  animate?: boolean;
  /**
   * Preserve the board's true length:width aspect (xMidYMid meet) instead of
   * stretching to the container. Use where the planshape should read at real
   * proportions (e.g. the hero live preview); leave off for thin ornaments.
   */
  fit?: boolean;
}

/**
 * Real shortboard planshape, sampled from the bundled standard Shortboard
 * template (`sample-board.brd`) via the kernel outline spline. Nose at left,
 * tail at right; `TOP`/`BOTTOM` are the two rails about the centreline (y=99)
 * in a 0–680 × 0–198 viewBox scaled to the true length:width aspect
 * (19.75"/68"). Regenerate with `scripts/extract-outline.mjs` (run from apps/web).
 */
const OUTLINE_TOP =
  'M2 99 L2 96.7 L2 94.5 L2.1 92.5 L2.1 90.6 L2.2 88.8 L2.4 87.1 L11.8 70.1 L18.2 64.8 L26.1 59.2 L35.8 53.2 L47.4 47.1 L60.9 41 L76.4 34.8 L94.2 28.9 L114.1 23.2 L136.5 18 L161.3 13.2 L188.7 9 L218.8 5.6 L251.7 3 L287.4 1.4 L326.2 0.8 L352.3 1.2 L378.2 2.2 L403.7 3.9 L428.8 6.3 L453.5 9.5 L477.6 13.4 L501.2 18 L524.2 23.4 L546.4 29.7 L567.9 36.7 L588.6 44.6 L608.5 53.3 L627.4 62.9 L645.3 73.3 L662.2 84.7 L678 96.9';
const OUTLINE_BOTTOM =
  'M2 99 L2 101.3 L2 103.5 L2.1 105.5 L2.1 107.4 L2.2 109.2 L2.4 110.9 L11.8 127.9 L18.2 133.2 L26.1 138.8 L35.8 144.8 L47.4 150.9 L60.9 157 L76.4 163.2 L94.2 169.1 L114.1 174.8 L136.5 180 L161.3 184.8 L188.7 189 L218.8 192.4 L251.7 195 L287.4 196.6 L326.2 197.2 L352.3 196.8 L378.2 195.8 L403.7 194.1 L428.8 191.7 L453.5 188.5 L477.6 184.6 L501.2 180 L524.2 174.6 L546.4 168.3 L567.9 161.3 L588.6 153.4 L608.5 144.7 L627.4 135.1 L645.3 124.7 L662.2 113.3 L678 101.1';

/**
 * Real shortboard silhouette as a closed unit path: nose at v=0 (top), tail at
 * v=1 (bottom), rails at u=±1 (half-width). Scale/rotate into place. Same source
 * as the outline above.
 */
const BOARD_SILHOUETTE =
  'M0 0 L0 0 L0.0236 0 L0.0458 0 L0.0665 0.0001 L0.0859 0.0002 L0.1041 0.0003 L0.1211 0.0005 L0.2943 0.0145 L0.3479 0.0239 L0.4056 0.0357 L0.4661 0.05 L0.5284 0.0671 L0.5913 0.0871 L0.6535 0.1101 L0.7141 0.1363 L0.7718 0.1659 L0.8256 0.1989 L0.8741 0.2357 L0.9165 0.2762 L0.9513 0.3207 L0.9776 0.3693 L0.9943 0.4222 L1 0.4795 L0.9966 0.5182 L0.9862 0.5565 L0.9688 0.5942 L0.9441 0.6314 L0.912 0.6679 L0.8724 0.7036 L0.8249 0.7385 L0.7696 0.7724 L0.7062 0.8054 L0.6344 0.8372 L0.5543 0.8678 L0.4656 0.8972 L0.3681 0.9251 L0.2616 0.9517 L0.1461 0.9766 L0.0213 1 L-0.0213 1 L-0.1461 0.9766 L-0.2616 0.9517 L-0.3681 0.9251 L-0.4656 0.8972 L-0.5543 0.8678 L-0.6344 0.8372 L-0.7062 0.8054 L-0.7696 0.7724 L-0.8249 0.7385 L-0.8724 0.7036 L-0.912 0.6679 L-0.9441 0.6314 L-0.9688 0.5942 L-0.9862 0.5565 L-0.9966 0.5182 L-1 0.4795 L-0.9943 0.4222 L-0.9776 0.3693 L-0.9513 0.3207 L-0.9165 0.2762 L-0.8741 0.2357 L-0.8256 0.1989 L-0.7718 0.1659 L-0.7141 0.1363 L-0.6535 0.1101 L-0.5913 0.0871 L-0.5284 0.0671 L-0.4661 0.05 L-0.4056 0.0357 L-0.3479 0.0239 L-0.2943 0.0145 L-0.1211 0.0005 L-0.1041 0.0003 L-0.0859 0.0002 L-0.0665 0.0001 L-0.0458 0 L-0.0236 0 L0 0 Z';

/**
 * Layered ocean-swell lines — the decorative divider motif for header & footer.
 * Three offset sine swells (smooth quadratic `T` chain) fading back for depth,
 * echoing swell sets / bathymetric contours. Stretches full-width via
 * `preserveAspectRatio="none"`; colour via `currentColor`.
 *
 * Each swell gently bobs up and down with a slight sway, slightly out of phase —
 * like small waves on a calm day (see `.wave-bob` in marketing.css). The path is
 * drawn past both edges of the viewBox so the small sway never reveals an end;
 * the svg clips the overhang. Honours `prefers-reduced-motion`.
 */
export function WaveLines({ className }: MarkProps) {
  // Swell extended past both edges so the gentle sway never exposes a path end.
  const swell = (cy: number) => {
    let d = `M-240 ${cy} Q -180 ${cy - 16} -120 ${cy}`;
    for (let x = -120; x < 1440; x += 120) d += ` T ${x + 120} ${cy}`;
    return d;
  };
  return (
    <svg
      viewBox="0 0 1200 48"
      fill="none"
      className={className}
      aria-hidden="true"
      preserveAspectRatio="none"
    >
      <g className="wave-bob">
        <path d={swell(31)} stroke="currentColor" strokeWidth="1.1" opacity="0.22" />
        <path d={swell(25)} stroke="currentColor" strokeWidth="1.3" opacity="0.45" />
        <path d={swell(18)} stroke="currentColor" strokeWidth="1.5" opacity="0.9" />
      </g>
    </svg>
  );
}

/**
 * The OpenShaper brandmark — the real Shortboard planshape silhouette, tilted on
 * a deep-navy tile with an electric-cyan board and a navy stringer line. Square;
 * size via `className` (e.g. `h-7 w-7`). Brand colours are baked in so it renders
 * correctly on any surface.
 */
export function Brandmark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} role="img" aria-label="OpenShaper" fill="none">
      <rect width="32" height="32" rx="8" fill="#0F1C30" />
      <rect
        x="0.6"
        y="0.6"
        width="30.8"
        height="30.8"
        rx="7.4"
        fill="none"
        stroke="#22D3EE"
        strokeOpacity="0.28"
      />
      <g transform="rotate(-26 16 16)">
        {/* real shortboard silhouette, nose up */}
        <g transform="translate(16 4.3) scale(4.5 23.4)">
          <path d={BOARD_SILHOUETTE} fill="#22D3EE" />
        </g>
        {/* stringer */}
        <line x1="16" y1="5.6" x2="16" y2="27.1" stroke="#0A1424" strokeWidth="0.9" />
      </g>
    </svg>
  );
}

/** The real Shortboard planshape (outline), nose at left, tail at right. */
export function BoardOutline({ className, animate = false, fit = false }: MarkProps) {
  const drawn = animate ? 'draw-line' : undefined;
  const len = animate ? ({ ['--len' as string]: 900 } as React.CSSProperties) : undefined;
  return (
    <svg
      viewBox="0 0 680 198"
      fill="none"
      className={className}
      aria-hidden="true"
      preserveAspectRatio={fit ? 'xMidYMid meet' : 'none'}
    >
      {/* stringer / centre line */}
      <line
        x1="2"
        y1="99"
        x2="678"
        y2="99"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeDasharray="3 9"
        opacity="0.55"
      />
      <path d={OUTLINE_TOP} stroke="currentColor" strokeWidth="2" className={drawn} style={len} />
      <path
        d={OUTLINE_BOTTOM}
        stroke="currentColor"
        strokeWidth="2"
        className={drawn}
        style={len}
      />
      {/* tail edge (the shortboard's squared tail width) */}
      <line x1="678" y1="96.9" x2="678" y2="101.1" stroke="currentColor" strokeWidth="2" />
      {/* a few cross-section station marks */}
      {[140, 290, 430, 560].map((x) => (
        <line
          key={x}
          x1={x}
          y1="71"
          x2={x}
          y2="127"
          stroke="currentColor"
          strokeWidth="1"
          opacity="0.4"
        />
      ))}
    </svg>
  );
}

/**
 * The real Shortboard rocker (board bottom, side-on), nose lift at left. Sampled
 * from the same template; a genuinely long, flat curve, so it reads correctly
 * when stretched full-width as a section divider. Regenerate with
 * `scripts/extract-outline.mjs`.
 */
const ROCKER =
  'M872 41.2 L864.7 42.3 L856.5 43.6 L847.6 45 L837.7 46.5 L827 48 L815.4 49.6 L802.9 51.3 L789.5 53 L775.2 54.7 L759.9 56.5 L743.7 58.2 L726.5 59.9 L708.3 61.5 L689.2 63.1 L669 64.6 L647.9 66 L625.7 67.3 L602.4 68.4 L578.1 69.5 L552.8 70.3 L526.3 71 L498.8 71.6 L470.1 71.9 L440.4 72 L415.4 71.9 L390.9 71.7 L367 71.3 L343.7 70.7 L320.9 69.9 L298.7 68.9 L277.1 67.7 L256.1 66.3 L235.7 64.7 L215.8 62.9 L196.7 60.8 L178.1 58.5 L160.2 55.9 L142.9 53 L126.3 49.9 L110.4 46.5 L95.1 42.8 L80.6 38.8 L66.7 34.5 L53.5 29.9 L41 24.9 L29.3 19.6 L18.3 14 L8 8';

export function RockerCurve({ className, animate = false }: MarkProps) {
  return (
    <svg
      viewBox="0 0 880 80"
      fill="none"
      className={className}
      aria-hidden="true"
      preserveAspectRatio="none"
    >
      <path
        d={ROCKER}
        stroke="currentColor"
        strokeWidth="1.5"
        className={animate ? 'draw-line' : undefined}
        style={animate ? ({ ['--len' as string]: 1100 } as React.CSSProperties) : undefined}
      />
    </svg>
  );
}
