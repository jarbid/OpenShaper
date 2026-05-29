/**
 * Numerical utilities ported from legacy `cadcore.MathUtils`.
 * Pure functions; the matrix helpers (for BezierFit) are ported separately.
 */

export type Fn = (x: number) => number;

export const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

/**
 * Composite Simpson's rule over [min, max] with `splits` panels.
 * Mirrors legacy `MathUtils.Integral.SimpsonsRuleIntegral` exactly, including its
 * NaN→0 guarding and the rolling reuse of the previous panel's right endpoint.
 */
export const simpsonIntegral = (func: Fn, min: number, max: number, splits: number): number => {
  let result = 0;
  const m = (max - min) / splits;
  let an = min;
  let x0 = func(an);
  for (let n = 0; n < splits; n++) {
    const am = an + m;
    let x1 = func((an + am) / 2);
    let x2 = func(am);
    if (Number.isNaN(x0)) x0 = 0;
    if (Number.isNaN(x1)) x1 = 0;
    if (Number.isNaN(x2)) x2 = 0;
    result += ((am - an) / 6) * (x0 + 4 * x1 + x2);
    an += m;
    x0 = x2;
  }
  return result;
};

/**
 * Trapezoid rule over a parametric XY curve (legacy
 * `MathUtils.Integral.TrapezoidRuleIntegral`): integrates y dx by summing
 * ((y0+y1)/2)·|x1-x0| over `splits` samples. Used for cross-section area.
 */
export const trapezoidIntegralXY = (
  func: (t: number) => { x: number; y: number },
  min: number,
  max: number,
  splits: number,
): number => {
  let result = 0;
  const m = (max - min) / splits;
  let an = min;
  let x0 = func(an);
  for (let n = 0; n < splits; n++) {
    an = an + m;
    const x1 = func(an);
    result += ((x0.y + x1.y) / 2) * Math.abs(x1.x - x0.x);
    x0 = x1;
  }
  return result;
};

const ROOT_VALUE_TOLERANCE = 0.005;

const secantRoot = (f: Fn, target: number, lo: number, hi: number): number => {
  const valAtMin = f(lo);
  const valAtMax = f(hi);
  let x = clamp((target - valAtMin) / (valAtMax - valAtMin), lo, hi);
  let lastX = x + (hi - lo) / 10;
  if (lastX > hi) lastX = x - (hi - lo) / 10;
  let curVal = f(x);
  let lastVal = f(lastX);
  let error = target - curVal;
  let n = 0;
  while (Math.abs(error) > ROOT_VALUE_TOLERANCE && n++ < 50 && curVal !== lastVal) {
    const d = ((x - lastX) / (curVal - lastVal)) * error;
    lastX = x;
    x = clamp(x + d, lo, hi);
    lastVal = curVal;
    curVal = f(x);
    error = target - curVal;
  }
  return x;
};

const bisectRoot = (f: Fn, target: number, lo: number, hi: number): number => {
  let lt = lo;
  let ht = hi;
  let lError = f(lt) - target;
  let curError = 1e8;
  let x = 0;
  let n = 0;
  while (Math.abs(curError) > ROOT_VALUE_TOLERANCE && n++ < 50 && ht - lt > 0.0001) {
    x = (ht + lt) / 2;
    curError = f(x) - target;
    if (curError * lError < 0) {
      ht = x;
    } else {
      lt = x;
      lError = curError;
    }
  }
  return x;
};

/** Secant root with bisection fallback (legacy RootFinder.getRoot). */
export const getRoot = (f: Fn, target: number, lo = 0, hi = 1): number => {
  const x = secantRoot(f, target, lo, hi);
  if (Math.abs(f(x) - target) > ROOT_VALUE_TOLERANCE) {
    const bx = bisectRoot(f, target, lo, hi);
    if (Math.abs(f(bx) - target) < Math.abs(f(x) - target)) return bx;
  }
  return x;
};
