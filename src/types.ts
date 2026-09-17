export type SubmissionType = "13F-HR" | "13F-HR/A";
export type AmendmentType = "RESTATEMENT" | "NEW HOLDINGS";
export type PutCall = "PUT" | "CALL" | null;
export type SshPrnamtType = "SH" | "PRN";

/** One <infoTable> element, exactly as reported. `value` is in whatever unit the filer used. */
export interface InfoRow {
  nameOfIssuer: string;
  titleOfClass: string;
  cusip: string;
  value: number;
  sshPrnamt: number;
  sshPrnamtType: SshPrnamtType;
  putCall: PutCall;
  investmentDiscretion: string;
  otherManager: string;
}

export interface Filing {
  accessionNumber: string;
  cik: string;
  submissionType: SubmissionType;
  /** ISO date, YYYY-MM-DD. */
  periodOfReport: string;
  /** ISO date-time, YYYY-MM-DDTHH:MM:SS. */
  acceptanceDateTime: string;
  amendmentType: AmendmentType | null;
  /** True when the amendment discloses holdings whose confidential treatment was denied or expired. */
  confDeniedExpired: boolean;
  rows: InfoRow[];
}

export interface NormalisedRow extends InfoRow {
  /** Multiplier that converts the reported `value` into US dollars (1 or 1000). */
  unitMultiplier: number;
  valueUsd: number;
}

export interface UnitDecision {
  /** Multiplier implied by the acceptance date alone. */
  expectedMultiplier: number;
  /** Multiplier actually applied after the 1000x misreport check. */
  multiplier: number;
  /** True when the filer used the other unit from the one the date implies. */
  misreported: boolean;
}

export interface NormalisedFiling extends Omit<Filing, "rows"> {
  unit: UnitDecision;
  rows: NormalisedRow[];
}

/** (CUSIP, putCall, sshPrnamtType): the identity of a position. */
export type PositionKey = string;

export interface EvidenceRow {
  accessionNumber: string;
  submissionType: SubmissionType;
  amendmentType: AmendmentType | null;
  acceptanceDateTime: string;
  confDeniedExpired: boolean;
  otherManager: string;
  investmentDiscretion: string;
  sshPrnamt: number;
  reportedValue: number;
  unitMultiplier: number;
  valueUsd: number;
}

export interface Position {
  key: PositionKey;
  cusip: string;
  putCall: PutCall;
  sshPrnamtType: SshPrnamtType;
  nameOfIssuer: string;
  shares: number;
  valueUsd: number;
  rows: EvidenceRow[];
}

export interface FoldedPeriod {
  cik: string;
  periodOfReport: string;
  /** Holdings after every filing for the period has been applied in acceptance order. */
  holdings: Map<PositionKey, Position>;
  /** Shares per key in the first-accepted filing for the period, before any amendment. */
  originalShares: Map<PositionKey, number>;
  /** Keys that entered the holdings through a confidential-treatment reveal. */
  revealedKeys: Set<PositionKey>;
  /** Accession numbers applied, in acceptance order. */
  applied: string[];
}

export type DeltaLabel =
  | "NEW"
  | "EXIT"
  | "ADD"
  | "TRIM"
  | "HOLD"
  | "SPLIT_ONLY"
  | "UNIT_ARTEFACT"
  | "LATE_REVEAL"
  | "AMENDMENT_CORRECTION";

export type EconomicLabel = "NEW" | "EXIT" | "ADD" | "TRIM" | "HOLD";

export interface Ratio {
  n: number;
  d: number;
}

export interface Delta {
  key: PositionKey;
  cusip: string;
  putCall: PutCall;
  sshPrnamtType: SshPrnamtType;
  nameOfIssuer: string;
  prevPeriod: string;
  period: string;
  label: DeltaLabel;
  /** What happened to the split-adjusted position, ignoring every reporting artefact. */
  economic: EconomicLabel;
  prevShares: number;
  shares: number;
  /** Shares per pre-split share; 1/1 when no split was inferred. */
  splitRatio: Ratio;
  /**
   * How large a genuine quarterly price move would have to be to overturn
   * `splitRatio`, as a fraction. Undefined when there was no price evidence.
   *
   * A split reading is an inference from one number, and the assumption behind
   * it — that the market moved less than the tolerance on top of the split — is
   * the weakest thing in this tool. This says how much room the reading has: a
   * 2:1 that survives to 0.50 is safe against any plausible quarter, a 10:1
   * that breaks at 0.10 is not, and a no-split reading with a small margin is
   * one bad quarter away from being called a split.
   */
  splitHoldsUpTo?: number;
  /** What `splitRatio` becomes past `splitHoldsUpTo`. */
  splitBecomes?: Ratio;
  /** prevShares expressed in post-split shares. */
  adjustedPrevShares: number;
  /** shares - adjustedPrevShares: the real trade. */
  shareDelta: number;
  prevValueUsd: number;
  valueUsd: number;
  evidence: {
    prev: EvidenceRow[];
    cur: EvidenceRow[];
    notes: string[];
  };
}
