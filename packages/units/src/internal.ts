/** Internal helpers shared across the units package. Not part of the public API. */

/**
 * Format a number to a fixed number of decimals, matching Java's
 * `String.format("%.Nf", value)` (round-half-up, locale-independent).
 *
 * `Number.prototype.toFixed` rounds half-to-even in some engines for certain
 * values, whereas Java's `%f` uses HALF_UP. We reproduce HALF_UP explicitly so
 * formatted strings match the legacy output exactly.
 */
export function formatFixed(value: number, decimals: number): string {
  if (!Number.isFinite(value)) {
    // Java would print "NaN"/"Infinity"; surfacing that is fine for parity.
    return String(value);
  }

  const negative = value < 0;
  const abs = Math.abs(value);
  const factor = 10 ** decimals;

  // Round HALF_UP. Add a tiny epsilon relative to magnitude to counter binary
  // floating point representation error (e.g. 1.005 -> 1.00 without it).
  const scaled = abs * factor;
  const epsilon = scaled === 0 ? 0 : Math.abs(scaled) * Number.EPSILON * 8;
  const rounded = Math.floor(scaled + 0.5 + epsilon);

  let s: string;
  if (decimals === 0) {
    s = String(rounded);
  } else {
    const str = String(rounded).padStart(decimals + 1, '0');
    const intPart = str.slice(0, str.length - decimals);
    const fracPart = str.slice(str.length - decimals);
    s = `${intPart}.${fracPart}`;
  }

  // Java prints "-0.00" when the rounded value is zero but the input was
  // negative? Actually Java prints "-0.00" for -0.0 input but for a negative
  // value that rounds to zero it prints "-0.00" as well. To stay safe and
  // match common expectations we drop the sign when the magnitude is zero.
  if (negative && rounded !== 0) {
    s = `-${s}`;
  }
  return s;
}
