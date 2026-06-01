/**
 * Technical line-art motifs — thin "construction line" drawings of a surfboard
 * outline and rocker curve, echoing the CAD editor. Used as hero art, section
 * dividers and footer ornament. Pure SVG, no runtime cost.
 */

interface MarkProps {
  className?: string;
  /** Animate the stroke drawing in on mount (hero use). */
  animate?: boolean;
}

/** A symmetric surfboard planshape (outline), nose at left, tail at right. */
export function BoardOutline({ className, animate = false }: MarkProps) {
  // Half-outline as a smooth bezier; mirrored to make a closed planshape.
  const top = 'M8 60 C 120 30, 360 18, 560 40 C 720 56, 800 58, 872 60';
  const bottom = 'M8 60 C 120 90, 360 102, 560 80 C 720 64, 800 62, 872 60';
  return (
    <svg
      viewBox="0 0 880 120"
      fill="none"
      className={className}
      aria-hidden="true"
      preserveAspectRatio="none"
    >
      {/* stringer / centre line */}
      <line
        x1="8"
        y1="60"
        x2="872"
        y2="60"
        stroke="currentColor"
        strokeWidth="1"
        strokeDasharray="2 6"
        opacity="0.55"
      />
      <path
        d={top}
        stroke="currentColor"
        strokeWidth="1.5"
        className={animate ? 'draw-line' : undefined}
        style={animate ? ({ ['--len' as string]: 1000 } as React.CSSProperties) : undefined}
      />
      <path
        d={bottom}
        stroke="currentColor"
        strokeWidth="1.5"
        className={animate ? 'draw-line' : undefined}
        style={animate ? ({ ['--len' as string]: 1000 } as React.CSSProperties) : undefined}
      />
      {/* a few cross-section station marks */}
      {[180, 360, 560, 720].map((x) => (
        <line
          key={x}
          x1={x}
          y1="44"
          x2={x}
          y2="76"
          stroke="currentColor"
          strokeWidth="0.75"
          opacity="0.4"
        />
      ))}
    </svg>
  );
}

/** A rocker profile curve (side-on), nose lift at left, tail kick at right. */
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
        d="M8 20 C 180 70, 360 76, 460 76 C 620 76, 760 64, 872 22"
        stroke="currentColor"
        strokeWidth="1.5"
        className={animate ? 'draw-line' : undefined}
        style={animate ? ({ ['--len' as string]: 1100 } as React.CSSProperties) : undefined}
      />
    </svg>
  );
}
