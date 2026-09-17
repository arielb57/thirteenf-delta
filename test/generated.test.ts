import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { scoreHistories } from "../bench/score.js";
import { diffPeriods } from "../src/diff.js";
import { foldFilings } from "../src/fold.js";
import { generateHistory } from "../src/generator.js";
import { parseFiling } from "../src/parse.js";
import { classify } from "../src/pipeline.js";
import { renderFiling } from "../src/render.js";
import type { Filing, FoldedPeriod, NormalisedFiling } from "../src/types.js";
import { normalise } from "../src/units.js";

const SEEDS = 3000;

function* histories(from: number, to: number) {
  for (let seed = from; seed <= to; seed++) yield generateHistory(seed);
}

test(`classified diff matches ground truth exactly on ${SEEDS} generated histories`, () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const h = generateHistory(seed);
    const filings = h.filings.map((f) => parseFiling(renderFiling(f)));
    const got = classify(filings).map((d) => ({
      key: d.key,
      period: d.period,
      label: d.label,
      shareDelta: d.shareDelta,
      split: `${d.splitRatio.n}/${d.splitRatio.d}`,
    }));
    const want = h.truth.map((t) => ({
      key: t.key,
      period: t.period,
      label: t.label,
      shareDelta: t.shareDelta,
      split: `${t.splitRatio.n}/${t.splitRatio.d}`,
    }));
    const order = (a: { key: string; period: string }, b: { key: string; period: string }) =>
      a.period === b.period ? (a.key < b.key ? -1 : 1) : a.period < b.period ? -1 : 1;
    assert.deepEqual(got.sort(order), want.sort(order), `seed ${seed}`);
  }
});

test("generated histories contain every artefact, and the naive diff is fooled by each", () => {
  const score = scoreHistories(histories(1, 300));
  for (const [tag, tally] of score.byTag) {
    assert.ok(tally.cells > 20, `too few '${tag}' cells: ${tally.cells}`);
    assert.equal(tally.classified, tally.cells, tag);
    if (tag !== "clean" && tag !== "multi-row") {
      assert.ok(tally.naive < tally.cells * 0.9, `naive diff is not fooled by '${tag}'`);
    }
  }
  for (const label of [
    "SPLIT_ONLY",
    "UNIT_ARTEFACT",
    "LATE_REVEAL",
    "AMENDMENT_CORRECTION",
  ] as const) {
    assert.ok((score.byLabel.get(label)?.cells ?? 0) > 20, label);
  }
});

test("each stage is necessary: removing unit checks or amendments breaks agreement", () => {
  let unitMisses = 0;
  let amendmentMisses = 0;
  for (const h of histories(1, 300)) {
    const truth = new Map(h.truth.map((t) => [`${t.key}@${t.period}`, t.label]));
    const miss = (history: FoldedPeriod[]) =>
      diffPeriods(history).filter((d) => truth.get(`${d.key}@${d.period}`) !== d.label).length;
    const dateOnly: NormalisedFiling[] = normalise(h.filings).map((f) => ({
      ...f,
      rows: f.rows.map((r) => ({
        ...r,
        unitMultiplier: f.unit.expectedMultiplier,
        valueUsd: r.value * f.unit.expectedMultiplier,
      })),
    }));
    unitMisses += miss(foldFilings(dateOnly));
    const originalsOnly = normalise(h.filings.filter((f: Filing) => f.submissionType === "13F-HR"));
    amendmentMisses += miss(foldFilings(originalsOnly));
  }
  assert.ok(unitMisses > 50, `date-only units should mislabel cells, got ${unitMisses}`);
  assert.ok(
    amendmentMisses > 50,
    `ignoring amendments should mislabel cells, got ${amendmentMisses}`,
  );
});

test("folding any acceptance-order-preserving interleaving gives identical holdings", () => {
  const snapshot = (history: FoldedPeriod[]) =>
    history.map((p) => ({
      period: p.periodOfReport,
      holdings: [...p.holdings.values()]
        .map((x) => [x.key, x.shares, x.valueUsd, x.rows.map((r) => r.accessionNumber).sort()])
        .sort(),
      original: [...p.originalShares].sort(),
      revealed: [...p.revealedKeys].sort(),
    }));
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 1_000_000 }),
      fc.infiniteStream(fc.nat()),
      (seed, stream) => {
        const h = generateHistory(seed);
        const byPeriod = new Map<string, Filing[]>();
        for (const f of h.filings)
          byPeriod.set(f.periodOfReport, [...(byPeriod.get(f.periodOfReport) ?? []), f]);
        // Randomly interleave the per-period queues, each kept in acceptance order.
        const queues = [...byPeriod.values()];
        const merged: Filing[] = [];
        const it = stream[Symbol.iterator]();
        while (queues.some((q) => q.length > 0)) {
          const live = queues.filter((q) => q.length > 0);
          merged.push(live[it.next().value % live.length].shift() as Filing);
        }
        const expected = snapshot(foldFilings(normalise(h.filings)));
        assert.deepEqual(snapshot(foldFilings(normalise(merged))), expected);
        assert.deepEqual(snapshot(foldFilings(normalise([...merged].reverse()))), expected);
      },
    ),
    { numRuns: 200, endOnFailure: true },
  );
});
