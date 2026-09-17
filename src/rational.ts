import type { Ratio } from "./types.js";

/**
 * The simplest rational (smallest denominator, then smallest numerator) in the closed
 * interval [lo, hi], found by descending the Stern–Brocot tree. Requires 0 < lo <= hi.
 * Runs of identical moves are taken in one step, so the cost is logarithmic in the
 * size of the answer rather than linear.
 */
export function simplestRationalInInterval(lo: number, hi: number): Ratio {
  if (!(lo > 0) || !(hi >= lo) || !Number.isFinite(hi)) {
    throw new RangeError(`invalid interval [${lo}, ${hi}]`);
  }
  // Left bound a/b, right bound c/d; the mediant is (a+c)/(b+d).
  let a = 0;
  let b = 1;
  let c = 1;
  let d = 0;
  for (let iter = 0; iter < 10_000; iter++) {
    const n = a + c;
    const m = b + d;
    if (n < lo * m) {
      // Mediant below the interval: move right as far as stays below lo.
      // Largest k with (n + k*c)/(m + k*d) < lo, i.e. k*(c - lo*d) < lo*m - n.
      const denom = c - lo * d;
      const k = denom > 0 ? Math.max(0, Math.ceil((lo * m - n) / denom) - 1) : 0;
      a = n + k * c;
      b = m + k * d;
    } else if (n > hi * m) {
      const denom = hi * b - a;
      const k = denom > 0 ? Math.max(0, Math.ceil((n - hi * m) / denom) - 1) : 0;
      c = n + k * a;
      d = m + k * b;
    } else {
      return { n, d: m };
    }
  }
  throw new RangeError(`no simple rational found in [${lo}, ${hi}]`);
}

function gcd(x: number, y: number): number {
  while (y) [x, y] = [y, x % y];
  return x;
}

export function ratio(n: number, d: number): Ratio {
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}

export function ratioToString(r: Ratio): string {
  return r.d === 1 ? `${r.n}` : `${r.n}/${r.d}`;
}

/**
 * Split ratios recognised as corporate actions, as post-split shares per pre-split share.
 * Every entry is the simplest rational inside its own tolerance interval (see
 * `SPLIT_PRICE_TOLERANCE`), which a test checks exhaustively.
 */
export const SPLIT_RATIOS: readonly Ratio[] = [
  { n: 2, d: 1 },
  { n: 3, d: 1 },
  { n: 4, d: 1 },
  { n: 5, d: 1 },
  { n: 10, d: 1 },
  { n: 3, d: 2 },
  { n: 1, d: 2 },
  { n: 1, d: 3 },
  { n: 1, d: 4 },
  { n: 1, d: 5 },
  { n: 1, d: 10 },
  { n: 2, d: 3 },
];

/**
 * Largest quarter-on-quarter price move, as a fraction, that split inference tolerates
 * on top of the split itself. With 5% the interval around 10 excludes 9 and 11.
 */
export const SPLIT_PRICE_TOLERANCE = 0.05;

/**
 * Infers a split ratio from the implied price ratio (current price / previous price).
 * A split of k moves the price by 1/k; allowing a market move m within the tolerance,
 * k lies in [(1-t)/priceRatio, (1+t)/priceRatio]. The simplest rational there is the
 * candidate; it counts only if it is a recognised split ratio. Returns 1/1 otherwise.
 */
export function inferSplit(priceRatio: number, tolerance = SPLIT_PRICE_TOLERANCE): Ratio {
  if (!(priceRatio > 0) || !Number.isFinite(priceRatio)) return { n: 1, d: 1 };
  const k = simplestRationalInInterval((1 - tolerance) / priceRatio, (1 + tolerance) / priceRatio);
  if (k.n === k.d) return { n: 1, d: 1 };
  return SPLIT_RATIOS.some((s) => s.n === k.n && s.d === k.d) ? k : { n: 1, d: 1 };
}
