import { classify } from "../src/pipeline.js";
import type {
  AmendmentType,
  Delta,
  Filing,
  InfoRow,
  PutCall,
  SshPrnamtType,
} from "../src/types.js";

export const CIK = "0001234567";
let seq = 0;

export interface RowSpec {
  cusip: string;
  shares: number;
  /** Dollars; rendered in the unit given to `filing`. */
  usd: number;
  putCall?: PutCall;
  type?: SshPrnamtType;
  otherManager?: string;
  discretion?: string;
}

export function filing(spec: {
  period: string;
  accepted: string;
  amendment?: AmendmentType;
  reveal?: boolean;
  /** Divisor applied to dollars; defaults to the correct unit for the acceptance date. */
  unit?: number;
  rows: RowSpec[];
}): Filing {
  const unit = spec.unit ?? (spec.accepted < "2023-01-03" ? 1000 : 1);
  seq++;
  return {
    accessionNumber: `${CIK}-00-${String(seq).padStart(6, "0")}`,
    cik: CIK,
    submissionType: spec.amendment ? "13F-HR/A" : "13F-HR",
    periodOfReport: spec.period,
    acceptanceDateTime: spec.accepted.length === 10 ? `${spec.accepted}T12:00:00` : spec.accepted,
    amendmentType: spec.amendment ?? null,
    confDeniedExpired: spec.reveal ?? false,
    rows: spec.rows.map(
      (r): InfoRow => ({
        nameOfIssuer: `ISSUER ${r.cusip}`,
        titleOfClass: r.putCall ?? "COM",
        cusip: r.cusip,
        value: Math.round(r.usd / unit),
        sshPrnamt: r.shares,
        sshPrnamtType: r.type ?? "SH",
        putCall: r.putCall ?? null,
        investmentDiscretion: r.discretion ?? "SOLE",
        otherManager: r.otherManager ?? "",
      }),
    ),
  };
}

/** A position worth `shares * price` dollars. */
export function pos(
  cusip: string,
  shares: number,
  price: number,
  extra: Partial<RowSpec> = {},
): RowSpec {
  return { cusip, shares, usd: shares * price, ...extra };
}

export function find(
  deltas: Delta[],
  cusip: string,
  period: string,
  putCall: PutCall = null,
): Delta {
  const d = deltas.find((x) => x.cusip === cusip && x.period === period && x.putCall === putCall);
  if (!d) throw new Error(`no delta for ${cusip} ${putCall ?? ""} at ${period}`);
  return d;
}

export { classify };

/** Filler holdings that give the unit check shared CUSIPs to compare. */
export function core(period: number): RowSpec[] {
  const drift = 1 + 0.01 * period;
  return [
    pos("037833100", 500_000, 150 * drift),
    pos("594918104", 300_000, 250 * drift),
    pos("88160R101", 100_000, 200 * drift),
  ];
}
