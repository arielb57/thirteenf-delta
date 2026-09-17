import { inferSplit, ratioToString } from "./rational.js";
import type {
  Delta,
  DeltaLabel,
  EconomicLabel,
  FoldedPeriod,
  Position,
  PositionKey,
  Ratio,
} from "./types.js";

export interface DiffOptions {
  /** Tolerated market move on top of a split; see SPLIT_PRICE_TOLERANCE. */
  splitTolerance?: number;
}

function unitSignature(p: Position | undefined): string {
  if (!p) return "";
  return [...new Set(p.rows.map((r) => r.unitMultiplier))].sort((a, b) => a - b).join(",");
}

/**
 * Labels every position that is held in either of two consecutive folded periods.
 *
 * The economic change is measured in split-adjusted shares. When both sides hold the
 * position and it is not a principal amount, the implied price ratio is searched for a
 * split (see `inferSplit`), and the previous share count is restated in post-split shares.
 *
 * Label precedence, first match wins:
 *   LATE_REVEAL           the position entered this period through a confidential reveal
 *   NEW/EXIT/ADD/TRIM     a real split-adjusted change in shares
 *   SPLIT_ONLY            a split and nothing else
 *   AMENDMENT_CORRECTION  an amendment changed the share count on either side
 *   UNIT_ARTEFACT         the two sides were reported in different value units
 *   HOLD                  nothing happened
 */
export function diffPair(
  prev: FoldedPeriod,
  cur: FoldedPeriod,
  options: DiffOptions = {},
): Delta[] {
  const keys = new Set<PositionKey>([...prev.holdings.keys(), ...cur.holdings.keys()]);
  const deltas: Delta[] = [];
  for (const key of [...keys].sort()) {
    const p = prev.holdings.get(key);
    const c = cur.holdings.get(key);
    const any = (c ?? p) as Position;
    const prevShares = p?.shares ?? 0;
    const shares = c?.shares ?? 0;
    const notes: string[] = [];

    let split: Ratio = { n: 1, d: 1 };
    if (p && c && any.sshPrnamtType === "SH" && prevShares > 0 && shares > 0) {
      if (p.valueUsd > 0 && c.valueUsd > 0) {
        const priceRatio = c.valueUsd / shares / (p.valueUsd / prevShares);
        split = inferSplit(priceRatio, options.splitTolerance);
        if (split.n !== split.d) {
          notes.push(
            `implied price moved by ${priceRatio.toPrecision(4)}x; simplest split ratio in tolerance is ${ratioToString(split)}`,
          );
        }
      }
    }
    const adjustedPrevShares = Math.round((prevShares * split.n) / split.d);
    const shareDelta = shares - adjustedPrevShares;

    let economic: EconomicLabel;
    if (!p) economic = "NEW";
    else if (!c) economic = "EXIT";
    else if (shareDelta > 0) economic = "ADD";
    else if (shareDelta < 0) economic = "TRIM";
    else economic = "HOLD";

    const amended =
      (prev.originalShares.get(key) ?? 0) !== prevShares ||
      (cur.originalShares.get(key) ?? 0) !== shares;
    if ((prev.originalShares.get(key) ?? 0) !== prevShares) {
      notes.push(
        `an amendment changed ${prev.periodOfReport} shares from ${prev.originalShares.get(key) ?? 0} to ${prevShares}`,
      );
    }
    if ((cur.originalShares.get(key) ?? 0) !== shares) {
      notes.push(
        `an amendment changed ${cur.periodOfReport} shares from ${cur.originalShares.get(key) ?? 0} to ${shares}`,
      );
    }
    const unitsDiffer = !!p && !!c && unitSignature(p) !== unitSignature(c);
    if (unitsDiffer) {
      notes.push(`value units differ: x${unitSignature(p)} then x${unitSignature(c)}`);
    }
    const revealed = cur.revealedKeys.has(key);
    if (revealed) notes.push("position disclosed late by a confidential-treatment amendment");

    let label: DeltaLabel;
    if (revealed) label = "LATE_REVEAL";
    else if (economic !== "HOLD") label = economic;
    else if (split.n !== split.d) label = "SPLIT_ONLY";
    else if (amended) label = "AMENDMENT_CORRECTION";
    else if (unitsDiffer) label = "UNIT_ARTEFACT";
    else label = "HOLD";

    deltas.push({
      key,
      cusip: any.cusip,
      putCall: any.putCall,
      sshPrnamtType: any.sshPrnamtType,
      nameOfIssuer: any.nameOfIssuer,
      prevPeriod: prev.periodOfReport,
      period: cur.periodOfReport,
      label,
      economic,
      prevShares,
      shares,
      splitRatio: split,
      adjustedPrevShares,
      shareDelta,
      prevValueUsd: p?.valueUsd ?? 0,
      valueUsd: c?.valueUsd ?? 0,
      evidence: { prev: p?.rows ?? [], cur: c?.rows ?? [], notes },
    });
  }
  return deltas;
}

/** Classified deltas for every pair of consecutive periods in a folded history. */
export function diffPeriods(history: readonly FoldedPeriod[], options: DiffOptions = {}): Delta[] {
  const sorted = [...history].sort((a, b) => (a.periodOfReport < b.periodOfReport ? -1 : 1));
  const out: Delta[] = [];
  for (let i = 1; i < sorted.length; i++) out.push(...diffPair(sorted[i - 1], sorted[i], options));
  return out;
}
