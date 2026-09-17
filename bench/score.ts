import { ARTEFACT_TAGS, type ArtefactTag, type GeneratedHistory } from "../src/generator.js";
import { naiveDiff } from "../src/naive.js";
import { parseFiling } from "../src/parse.js";
import { classify } from "../src/pipeline.js";
import { renderFiling } from "../src/render.js";
import type { DeltaLabel } from "../src/types.js";

export interface Tally {
  cells: number;
  naive: number;
  classified: number;
}

export interface Score {
  histories: number;
  filings: number;
  overall: Tally;
  byTag: Map<ArtefactTag, Tally>;
  byLabel: Map<DeltaLabel, Tally>;
  /** Deltas reported for a (position, quarter) that has no true counterpart. */
  spurious: { naive: number; classified: number };
}

const empty = (): Tally => ({ cells: 0, naive: 0, classified: 0 });

/**
 * Renders every generated filing to XML, parses it back, and scores both diffs against
 * ground truth. The classified diff is correct when label, split ratio and split-adjusted
 * share delta all match. The naive diff keys by CUSIP, so it is judged on label alone.
 */
export function scoreHistories(histories: Iterable<GeneratedHistory>): Score {
  const score: Score = {
    histories: 0,
    filings: 0,
    overall: empty(),
    byTag: new Map(ARTEFACT_TAGS.map((t) => [t, empty()])),
    byLabel: new Map(),
    spurious: { naive: 0, classified: 0 },
  };
  for (const h of histories) {
    score.histories++;
    score.filings += h.filings.length;
    const filings = h.filings.map((f) => parseFiling(renderFiling(f)));
    const classified = new Map(classify(filings).map((d) => [`${d.key}@${d.period}`, d]));
    const naive = new Map(naiveDiff(filings).map((d) => [`${d.cusip}@${d.period}`, d]));
    const seenNaive = new Set<string>();
    for (const t of h.truth) {
      const ck = `${t.key}@${t.period}`;
      const nk = `${t.cusip}@${t.period}`;
      const d = classified.get(ck);
      classified.delete(ck);
      seenNaive.add(nk);
      const okClassified =
        !!d &&
        d.label === t.label &&
        d.shareDelta === t.shareDelta &&
        d.splitRatio.n === t.splitRatio.n &&
        d.splitRatio.d === t.splitRatio.d;
      const okNaive = naive.get(nk)?.label === t.label;
      const tallies = [score.overall, ...t.tags.map((tag) => score.byTag.get(tag) as Tally)];
      let byLabel = score.byLabel.get(t.label);
      if (!byLabel) {
        byLabel = empty();
        score.byLabel.set(t.label, byLabel);
      }
      tallies.push(byLabel);
      for (const tally of tallies) {
        tally.cells++;
        if (okClassified) tally.classified++;
        if (okNaive) tally.naive++;
      }
    }
    score.spurious.classified += classified.size;
    for (const k of naive.keys()) if (!seenNaive.has(k)) score.spurious.naive++;
  }
  return score;
}
