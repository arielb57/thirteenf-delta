import type { Filing, NormalisedFiling } from "./types.js";

/**
 * Filings accepted on or after this date report <value> in dollars; earlier ones in
 * thousands of dollars. The switch follows the filing, not the quarter: a 13F-HR for
 * 2022-12-31 accepted in February 2023 is in dollars, and so is a 2023 amendment to a
 * 2022 quarter.
 */
export const UNIT_CUTOVER = "2023-01-03";

export function expectedMultiplier(acceptanceDateTime: string): number {
  return acceptanceDateTime.slice(0, 10) < UNIT_CUTOVER ? 1000 : 1;
}

/** Median implied price per CUSIP (dollars per share) in a filing, using a given multiplier. */
function impliedPrices(f: Filing, multiplier: number): Map<string, number> {
  const totals = new Map<string, { value: number; shares: number }>();
  for (const r of f.rows) {
    if (r.sshPrnamtType !== "SH" || r.sshPrnamt <= 0) continue;
    const t = totals.get(r.cusip) ?? { value: 0, shares: 0 };
    t.value += r.value * multiplier;
    t.shares += r.sshPrnamt;
    totals.set(r.cusip, t);
  }
  const out = new Map<string, number>();
  for (const [cusip, t] of totals) if (t.value > 0) out.set(cusip, t.value / t.shares);
  return out;
}

export function filingOrder(a: Filing | NormalisedFiling, b: Filing | NormalisedFiling): number {
  if (a.acceptanceDateTime !== b.acceptanceDateTime) {
    return a.acceptanceDateTime < b.acceptanceDateTime ? -1 : 1;
  }
  return a.accessionNumber < b.accessionNumber ? -1 : a.accessionNumber > b.accessionNumber ? 1 : 0;
}

function median(xs: number[]): number {
  const s = [...xs].sort((x, y) => x - y);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Converts every row's value to dollars.
 *
 * The acceptance date gives the expected unit. Filers sometimes use the other one, so each
 * pair of filings from the same manager whose periods are at most one quarter apart is
 * compared: the median log10 ratio of implied prices over shared CUSIPs, rounded to the
 * nearest multiple of 3, is their relative unit offset (0 or ±3 when prices move by far
 * less than 30x a quarter). Offsets are propagated over each connected group of filings,
 * and the offset shared by the most filings is taken as correct; the rest are rescaled by
 * exactly 1000x. A filing that shares no CUSIP with a neighbour keeps its expected unit.
 */
export function normalise(filings: readonly Filing[]): NormalisedFiling[] {
  const expected = filings.map((f) => expectedMultiplier(f.acceptanceDateTime));
  const prices = filings.map((f, i) => impliedPrices(f, expected[i]));
  const periods = [...new Set(filings.map((f) => f.periodOfReport))].sort();
  const periodIndex = new Map(periods.map((p, i) => [p, i]));

  const edges: { to: number; offset: number }[][] = filings.map(() => []);
  for (let i = 0; i < filings.length; i++) {
    for (let j = i + 1; j < filings.length; j++) {
      if (filings[i].cik !== filings[j].cik) continue;
      const gap = Math.abs(
        (periodIndex.get(filings[i].periodOfReport) ?? 0) -
          (periodIndex.get(filings[j].periodOfReport) ?? 0),
      );
      if (gap > 1) continue;
      const logs: number[] = [];
      for (const [cusip, pi] of prices[i]) {
        const pj = prices[j].get(cusip);
        if (pj !== undefined) logs.push(Math.log10(pi / pj));
      }
      if (logs.length === 0) continue;
      const offset = 3 * Math.round(median(logs) / 3);
      edges[i].push({ to: j, offset });
      edges[j].push({ to: i, offset: -offset });
    }
  }

  const offsetOf: (number | undefined)[] = filings.map(() => undefined);
  const correction = filings.map(() => 0);
  for (let root = 0; root < filings.length; root++) {
    if (offsetOf[root] !== undefined) continue;
    offsetOf[root] = 0;
    const component = [root];
    for (let q = 0; q < component.length; q++) {
      const node = component[q];
      for (const e of edges[node]) {
        if (offsetOf[e.to] === undefined) {
          offsetOf[e.to] = (offsetOf[node] ?? 0) - e.offset;
          component.push(e.to);
        }
      }
    }
    const counts = new Map<number, number>();
    for (const n of component)
      counts.set(offsetOf[n] ?? 0, (counts.get(offsetOf[n] ?? 0) ?? 0) + 1);
    // On a tie, trust the earliest-accepted filing so the answer never depends on input order.
    const earliest = component.reduce((x, y) => (filingOrder(filings[y], filings[x]) < 0 ? y : x));
    let baseline = offsetOf[earliest] ?? 0;
    let best = counts.get(baseline) ?? 0;
    for (const [off, count] of counts) {
      if (count > best) {
        best = count;
        baseline = off;
      }
    }
    for (const n of component) correction[n] = (offsetOf[n] ?? 0) - baseline;
  }

  return filings.map((f, i) => {
    // offsetOf is log10(price_i / price_root): a filing whose prices look 1000x too high
    // must be scaled down.
    const c = correction[i];
    const multiplier = c >= 0 ? expected[i] / 10 ** c : expected[i] * 10 ** -c;
    return {
      ...f,
      unit: {
        expectedMultiplier: expected[i],
        multiplier,
        misreported: correction[i] !== 0,
      },
      rows: f.rows.map((r) => ({
        ...r,
        unitMultiplier: multiplier,
        valueUsd: Math.round(r.value * multiplier),
      })),
    };
  });
}
