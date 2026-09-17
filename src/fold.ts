import type {
  EvidenceRow,
  FoldedPeriod,
  NormalisedFiling,
  NormalisedRow,
  Position,
  PositionKey,
  PutCall,
  SshPrnamtType,
} from "./types.js";
import { filingOrder } from "./units.js";

export function positionKey(cusip: string, putCall: PutCall, type: SshPrnamtType): PositionKey {
  return `${cusip}|${putCall ?? "-"}|${type}`;
}

function evidence(f: NormalisedFiling, r: NormalisedRow): EvidenceRow {
  return {
    accessionNumber: f.accessionNumber,
    submissionType: f.submissionType,
    amendmentType: f.amendmentType,
    acceptanceDateTime: f.acceptanceDateTime,
    confDeniedExpired: f.confDeniedExpired,
    otherManager: r.otherManager,
    investmentDiscretion: r.investmentDiscretion,
    sshPrnamt: r.sshPrnamt,
    reportedValue: r.value,
    unitMultiplier: r.unitMultiplier,
    valueUsd: r.valueUsd,
  };
}

/**
 * Sums rows sharing (CUSIP, putCall, sshPrnamtType) across otherManager and
 * investmentDiscretion, so a call option, a principal amount and common shares on the
 * same CUSIP stay three separate positions.
 */
export function aggregateRows(
  f: NormalisedFiling,
  into: Map<PositionKey, Position> = new Map(),
): Map<PositionKey, Position> {
  for (const r of f.rows) {
    const key = positionKey(r.cusip, r.putCall, r.sshPrnamtType);
    let p = into.get(key);
    if (!p) {
      p = {
        key,
        cusip: r.cusip,
        putCall: r.putCall,
        sshPrnamtType: r.sshPrnamtType,
        nameOfIssuer: r.nameOfIssuer,
        shares: 0,
        valueUsd: 0,
        rows: [],
      };
      into.set(key, p);
    }
    p.shares += r.sshPrnamt;
    p.valueUsd += r.valueUsd;
    p.rows.push(evidence(f, r));
  }
  return into;
}

/**
 * Folds one manager's filings into a holdings set per period of report.
 *
 * Filings for a period are applied in acceptance order (ties broken by accession number).
 * The first one is the base. A RESTATEMENT replaces the entire holdings set. A NEW HOLDINGS
 * amendment adds its rows to the current set; when it discloses holdings whose confidential
 * treatment ended, the keys it brings in are remembered as revealed. Because the amendment
 * carries the original period of report, a late reveal lands in the quarter the position
 * was actually held, not the quarter the amendment was accepted.
 */
export function foldFilings(filings: readonly NormalisedFiling[]): FoldedPeriod[] {
  const ciks = new Set(filings.map((f) => f.cik));
  if (ciks.size > 1) {
    throw new Error(`foldFilings expects one manager, got ${ciks.size}: ${[...ciks].join(", ")}`);
  }
  const byPeriod = new Map<string, NormalisedFiling[]>();
  for (const f of filings) {
    const list = byPeriod.get(f.periodOfReport) ?? [];
    list.push(f);
    byPeriod.set(f.periodOfReport, list);
  }
  const out: FoldedPeriod[] = [];
  for (const period of [...byPeriod.keys()].sort()) {
    const list = [...(byPeriod.get(period) ?? [])].sort(filingOrder);
    let holdings = new Map<PositionKey, Position>();
    let revealed = new Set<PositionKey>();
    const originalShares = new Map<PositionKey, number>();
    list.forEach((f, i) => {
      if (i === 0) {
        aggregateRows(f, holdings);
        for (const [k, p] of holdings) originalShares.set(k, p.shares);
        if (f.confDeniedExpired) revealed = new Set(holdings.keys());
      } else if (f.amendmentType === "NEW HOLDINGS") {
        const added = aggregateRows(f);
        for (const [k, p] of added) {
          const existing = holdings.get(k);
          if (existing) {
            existing.shares += p.shares;
            existing.valueUsd += p.valueUsd;
            existing.rows.push(...p.rows);
          } else {
            holdings.set(k, p);
          }
          if (f.confDeniedExpired) revealed.add(k);
        }
      } else {
        holdings = aggregateRows(f);
        revealed = new Set([...revealed].filter((k) => holdings.has(k)));
      }
    });
    out.push({
      cik: list[0].cik,
      periodOfReport: period,
      holdings,
      originalShares,
      revealedKeys: new Set([...revealed].filter((k) => holdings.has(k))),
      applied: list.map((f) => f.accessionNumber),
    });
  }
  return out;
}
