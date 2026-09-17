import type { EconomicLabel, Filing } from "./types.js";
import { filingOrder } from "./units.js";

export interface NaiveDelta {
  cusip: string;
  prevPeriod: string;
  period: string;
  label: EconomicLabel;
  prevShares: number;
  shares: number;
  /** Ratio of reported values as filed, with no unit handling. */
  valueRatio: number | null;
}

/**
 * The diff most trackers compute: take each quarter's original 13F-HR, ignore amendments,
 * key rows by CUSIP alone, compare raw share counts and raw values.
 */
export function naiveDiff(filings: readonly Filing[]): NaiveDelta[] {
  const originals = new Map<string, Filing>();
  for (const f of [...filings].sort(filingOrder)) {
    if (f.submissionType === "13F-HR" && !originals.has(f.periodOfReport)) {
      originals.set(f.periodOfReport, f);
    }
  }
  const periods = [...originals.keys()].sort();
  const totals = (f: Filing) => {
    const m = new Map<string, { shares: number; value: number }>();
    for (const r of f.rows) {
      const t = m.get(r.cusip) ?? { shares: 0, value: 0 };
      t.shares += r.sshPrnamt;
      t.value += r.value;
      m.set(r.cusip, t);
    }
    return m;
  };
  const out: NaiveDelta[] = [];
  for (let i = 1; i < periods.length; i++) {
    const prev = totals(originals.get(periods[i - 1]) as Filing);
    const cur = totals(originals.get(periods[i]) as Filing);
    for (const cusip of [...new Set([...prev.keys(), ...cur.keys()])].sort()) {
      const p = prev.get(cusip);
      const c = cur.get(cusip);
      let label: EconomicLabel;
      if (!p) label = "NEW";
      else if (!c) label = "EXIT";
      else if (c.shares > p.shares) label = "ADD";
      else if (c.shares < p.shares) label = "TRIM";
      else label = "HOLD";
      out.push({
        cusip,
        prevPeriod: periods[i - 1],
        period: periods[i],
        label,
        prevShares: p?.shares ?? 0,
        shares: c?.shares ?? 0,
        valueRatio: p && c && p.value > 0 ? c.value / p.value : null,
      });
    }
  }
  return out;
}
