import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import {
  inferSplit,
  ratioToString,
  SPLIT_PRICE_TOLERANCE,
  SPLIT_RATIOS,
  simplestRationalInInterval,
  splitConfidence,
} from "../src/rational.js";
import type { Ratio } from "../src/types.js";

/** Brute force: smallest denominator, then smallest numerator, with n/d in [lo, hi]. */
function bruteSimplest(lo: number, hi: number): { n: number; d: number } {
  for (let d = 1; d < 5000; d++) {
    const n = Math.ceil(lo * d);
    if (n <= hi * d) return { n, d };
  }
  throw new Error("not found");
}

test("Stern–Brocot search finds known simplest rationals", () => {
  assert.deepEqual(simplestRationalInInterval(1.4, 1.6), { n: 3, d: 2 });
  assert.deepEqual(simplestRationalInInterval(0.3, 0.34), { n: 1, d: 3 });
  assert.deepEqual(simplestRationalInInterval(3.1, 3.2), { n: 16, d: 5 });
  assert.deepEqual(simplestRationalInInterval(9.5, 10.5), { n: 10, d: 1 });
  assert.deepEqual(simplestRationalInInterval(0.0932, 0.1072), { n: 1, d: 10 });
  assert.deepEqual(simplestRationalInInterval(1000.2, 1000.9), { n: 2001, d: 2 });
  assert.throws(() => simplestRationalInInterval(0, 1), RangeError);
  assert.throws(() => simplestRationalInInterval(2, 1), RangeError);
});

test("Stern–Brocot search agrees with brute force", () => {
  fc.assert(
    fc.property(
      fc.double({ min: 0.01, max: 50, noNaN: true }),
      fc.double({ min: 0.001, max: 0.3, noNaN: true }),
      (lo, width) => {
        const hi = lo * (1 + width);
        const got = simplestRationalInInterval(lo, hi);
        assert.deepEqual(got, bruteSimplest(lo, hi));
      },
    ),
    { numRuns: 2000, endOnFailure: true },
  );
});

test("every recognised split ratio is recovered for any market move inside the band", () => {
  // The generator's price drift is 3%; the detector tolerates 5%. Sweep the drift range
  // densely, including extremes, for every ratio.
  for (const k of SPLIT_RATIOS) {
    for (let i = 0; i <= 600; i++) {
      const move = 0.97 + (0.06 * i) / 600;
      const priceRatio = (move * k.d) / k.n;
      assert.deepEqual(inferSplit(priceRatio), k, `k=${k.n}/${k.d} move=${move}`);
    }
  }
  for (let i = 0; i <= 600; i++) {
    const move = 1 - SPLIT_PRICE_TOLERANCE + (2 * SPLIT_PRICE_TOLERANCE * i) / 600;
    assert.deepEqual(inferSplit(move), { n: 1, d: 1 }, `no split, move=${move}`);
  }
});

test("price moves that are not a recognised split are not reported as one", () => {
  // A 40% drop would be a 5:3 split, which is not in the recognised set.
  assert.deepEqual(inferSplit(0.6), { n: 1, d: 1 });
  assert.deepEqual(inferSplit(Number.NaN), { n: 1, d: 1 });
  assert.deepEqual(inferSplit(0), { n: 1, d: 1 });
  assert.deepEqual(inferSplit(1 / 7), { n: 1, d: 1 });
});

test("split confidence: says how far a reading can be pushed before it changes", () => {
  // A 2:1 split halves the price. Nothing simpler than 2 enters the interval
  // until the tolerance reaches 50%, which no plausible quarter does.
  const two = splitConfidence(0.5);
  assert.deepEqual(two.ratio, { n: 2, d: 1 });
  assert.ok(two.holdsUpTo > 0.45, `2:1 should be robust, got ${two.holdsUpTo}`);
});

test("split confidence: flags the ratio that has almost no room", () => {
  // Around 10 the interval reaches 9 at a 10% tolerance, and 9 is not a
  // recognised split, so the reading collapses to "no split".
  const ten = splitConfidence(0.1);
  assert.deepEqual(ten.ratio, { n: 10, d: 1 });
  assert.ok(ten.holdsUpTo < 0.12, `10:1 should be fragile, got ${ten.holdsUpTo}`);
  assert.deepEqual(ten.becomes, { n: 1, d: 1 });
});

test("split confidence: gives a no-split reading a margin too", () => {
  // The margin runs both ways: this is how big a fall would have to be
  // before a quarter with no corporate action gets called a split.
  const quiet = splitConfidence(0.98);
  assert.deepEqual(quiet.ratio, { n: 1, d: 1 });
  assert.ok(quiet.holdsUpTo > 0.5);

  const steep = splitConfidence(0.7);
  assert.deepEqual(steep.ratio, { n: 3, d: 2 });
  assert.ok(
    steep.holdsUpTo < 0.35,
    `a 30% fall reads as 3:2 with little room, got ${steep.holdsUpTo}`,
  );
});

test("split confidence: the margin is the point where the answer actually changes", () => {
  for (const priceRatio of [0.5, 0.1, 0.2, 0.25, 0.667, 0.7, 0.34, 2, 3, 0.98]) {
    const c = splitConfidence(priceRatio);
    const same = (a: Ratio, b: Ratio) => a.n === b.n && a.d === b.d;
    assert.ok(
      same(inferSplit(priceRatio, c.holdsUpTo), c.ratio),
      `still ${priceRatio} at the margin`,
    );
    if (!same(c.becomes, c.ratio)) {
      assert.ok(
        !same(inferSplit(priceRatio, c.holdsUpTo + 1e-6), c.ratio),
        `should have changed just past the margin at ${priceRatio}`,
      );
    }
  }
});

test("split confidence: every recognised ratio keeps its own reading at the default tolerance", () => {
  for (const s of SPLIT_RATIOS) {
    const c = splitConfidence(s.d / s.n);
    assert.deepEqual(c.ratio, s, `${ratioToString(s)} should infer itself`);
    assert.ok(c.holdsUpTo >= SPLIT_PRICE_TOLERANCE, ratioToString(s));
  }
});
