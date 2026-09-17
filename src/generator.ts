import { positionKey } from "./fold.js";
import { SPLIT_RATIOS } from "./rational.js";
import type {
  AmendmentType,
  DeltaLabel,
  EconomicLabel,
  Filing,
  InfoRow,
  PositionKey,
  PutCall,
  Ratio,
  SshPrnamtType,
} from "./types.js";
import { expectedMultiplier } from "./units.js";

export type ArtefactTag =
  | "split"
  | "split-with-trade"
  | "multi-row"
  | "option-and-stock"
  | "unit-cutover"
  | "unit-misreport"
  | "restatement"
  | "new-holdings"
  | "confidential-reveal"
  | "clean";

export const ARTEFACT_TAGS: readonly ArtefactTag[] = [
  "clean",
  "split",
  "split-with-trade",
  "multi-row",
  "option-and-stock",
  "unit-cutover",
  "unit-misreport",
  "restatement",
  "new-holdings",
  "confidential-reveal",
];

/** The correct classification of one position between two consecutive quarters. */
export interface TruthCell {
  key: PositionKey;
  cusip: string;
  prevPeriod: string;
  period: string;
  label: DeltaLabel;
  economic: EconomicLabel;
  prevShares: number;
  shares: number;
  splitRatio: Ratio;
  shareDelta: number;
  tags: ArtefactTag[];
}

export interface GeneratedFiling extends Filing {
  /** Multiplier the generator really used for <value>. */
  actualMultiplier: number;
}

export interface GeneratedHistory {
  seed: number;
  cik: string;
  periods: string[];
  filings: GeneratedFiling[];
  truth: TruthCell[];
}

/** mulberry32: small, fast, and identical on every platform. */
export function rngFromSeed(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALNUM = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** The standard CUSIP modulus-10 "double-add-double" check digit. */
export function cusipCheckDigit(base8: string): string {
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    let v = ALNUM.indexOf(base8[i]);
    if (i % 2 === 1) v *= 2;
    sum += Math.floor(v / 10) + (v % 10);
  }
  return String((10 - (sum % 10)) % 10);
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

interface Security {
  cusip: string;
  name: string;
  isBond: boolean;
  /** Price per share, or per unit of principal for bonds, by period. */
  price: number[];
  /** Split ratio applied between period t-1 and t. */
  split: Ratio[];
}

interface KeySpec {
  key: PositionKey;
  sec: Security;
  putCall: PutCall;
  type: SshPrnamtType;
  core: boolean;
  shares: number[];
}

type FilingRole = "original" | "restatement" | "new-holdings" | "reveal";

interface Draft {
  role: FilingRole;
  period: number;
  accepted: string;
  /** Shares per key as they appear in this filing. */
  content: Map<KeySpec, number>;
}

const NAME_PARTS = [
  ["NORTH", "ATLAS", "BLUE", "IRON", "SILVER", "CEDAR", "POLAR", "SUMMIT", "HARBOR", "VECTOR"],
  ["ROBOTICS", "BANCORP", "ENERGY", "FOODS", "SEMICONDUCTOR", "HEALTH", "LOGISTICS", "SOFTWARE"],
];

export function generateHistory(seed: number): GeneratedHistory {
  const rnd = rngFromSeed(seed);
  const uniform = (a: number, b: number) => a + (b - a) * rnd();
  const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
  const chance = (p: number) => rnd() < p;
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];

  const cik = String(int(1_000_000, 1_999_999)).padStart(10, "0");
  const startQuarter = int(0, 11);
  const nPeriods = int(6, 9);
  const periods: string[] = [];
  for (let i = 0; i < nPeriods; i++) {
    const q = 2 + startQuarter + i; // quarter 0 is 2020Q1
    const year = 2020 + Math.floor(q / 4);
    periods.push(`${year}-${["03-31", "06-30", "09-30", "12-31"][q % 4]}`);
  }

  // Securities and their price paths.
  const used = new Set<string>();
  const newSecurity = (isBond: boolean): Security => {
    let cusip = "";
    do {
      let base = "";
      for (let i = 0; i < 6; i++) base += ALNUM[int(0, 35)];
      base += isBond ? "AB" : "10";
      cusip = base + cusipCheckDigit(base);
    } while (used.has(cusip));
    used.add(cusip);
    const name = `${pick(NAME_PARTS[0])} ${pick(NAME_PARTS[1])} ${isBond ? "CORP" : "INC"}`;
    return { cusip, name, isBond, price: [], split: [] };
  };
  const stocks = Array.from({ length: int(4, 10) }, () => newSecurity(false));
  const bonds = Array.from({ length: int(0, 2) }, () => newSecurity(true));

  const keys: KeySpec[] = [];
  const addKey = (sec: Security, putCall: PutCall, type: SshPrnamtType, core: boolean) =>
    keys.push({ key: positionKey(sec.cusip, putCall, type), sec, putCall, type, core, shares: [] });
  stocks.forEach((s, i) => {
    addKey(s, null, "SH", i < 3);
    if (chance(0.3)) addKey(s, chance(0.5) ? "CALL" : "PUT", "SH", false);
  });
  for (const b of bonds) addKey(b, null, "PRN", false);

  const lot = (k: KeySpec, t: number, minUsd: number, maxUsd: number): number => {
    const step = k.type === "PRN" ? 1000 : 100;
    return Math.max(step, Math.round(uniform(minUsd, maxUsd) / k.sec.price[t] / step) * step);
  };

  for (let t = 0; t < nPeriods; t++) {
    for (const s of [...stocks, ...bonds]) {
      if (t === 0) {
        s.price.push(s.isBond ? uniform(0.9, 1.1) : uniform(20, 400));
        s.split.push({ n: 1, d: 1 });
        continue;
      }
      let k: Ratio = { n: 1, d: 1 };
      if (!s.isBond && chance(0.1)) {
        const cand = pick(SPLIT_RATIOS);
        const divisible = keys
          .filter((x) => x.sec === s)
          .every((x) => (x.shares[t - 1] * cand.n) % cand.d === 0);
        if (divisible) k = cand;
      }
      s.split.push(k);
      const drift = s.isBond ? uniform(0.99, 1.01) : uniform(0.97, 1.03);
      s.price.push((s.price[t - 1] * drift * k.d) / k.n);
    }
    for (const k of keys) {
      const minUsd = 2e6;
      if (t === 0) {
        k.shares.push(k.core || chance(0.6) ? lot(k, 0, minUsd, 2e7) : 0);
        continue;
      }
      const split = k.sec.split[t];
      const adj = (k.shares[t - 1] * split.n) / split.d;
      const step = k.type === "PRN" ? 1000 : 1;
      if (adj === 0) {
        k.shares.push(chance(0.25) ? lot(k, t, minUsd, 2e7) : 0);
        continue;
      }
      const r = rnd();
      let next = adj;
      if (!k.core && r < 0.1) next = 0;
      else if (r < 0.3)
        next = adj + Math.max(step, Math.round((adj * uniform(0.02, 0.6)) / step) * step);
      else if (r < 0.5) {
        const trimmed = adj - Math.max(step, Math.round((adj * uniform(0.05, 0.5)) / step) * step);
        if (trimmed * k.sec.price[t] >= 1e6) next = trimmed;
      }
      k.shares.push(next);
    }
  }

  const held = (k: KeySpec, t: number) => t >= 0 && t < nPeriods && k.shares[t] > 0;
  const heldAt = (t: number) => keys.filter((k) => held(k, t));
  const randomTime = () =>
    `${String(int(6, 21)).padStart(2, "0")}:${String(int(0, 59)).padStart(2, "0")}:${String(int(0, 59)).padStart(2, "0")}`;

  // Artefacts per period.
  const drafts: Draft[] = [];
  const conf: Set<KeySpec>[] = periods.map(() => new Set());
  const errorKeys: Set<KeySpec>[] = periods.map(() => new Set());
  const missingKeys: Set<KeySpec>[] = periods.map(() => new Set());
  const sources: Map<KeySpec, Draft>[] = periods.map(() => new Map());

  for (let t = 0; t < nPeriods; t++) {
    const h = heldAt(t);
    const original: Draft = {
      role: "original",
      period: t,
      accepted: `${addDays(periods[t], int(20, 44))}T${randomTime()}`,
      content: new Map(h.map((k) => [k, k.shares[t]])),
    };
    drafts.push(original);

    if (t < nPeriods - 1 && chance(0.15)) {
      const cands = h.filter(
        (k) => !k.core && k.type === "SH" && held(k, t + 1) && !(t > 0 && conf[t - 1].has(k)),
      );
      if (cands.length > 0) {
        const k = pick(cands);
        conf[t].add(k);
        original.content.delete(k);
        drafts.push({
          role: "reveal",
          period: t,
          accepted: `${addDays(original.accepted, int(170, 200))}T${randomTime()}`,
          content: new Map([[k, k.shares[t]]]),
        });
      }
    }

    const r = rnd();
    if (r < 0.15) {
      const restated = new Map([...original.content]);
      for (const k of conf[t]) restated.delete(k);
      for (const k of h) if (!conf[t].has(k)) restated.set(k, k.shares[t]);
      const kind = pick(["phantom", "stale", "wrong-shares", "missing"] as const);
      const nonConfHeld = h.filter((k) => !conf[t].has(k));
      const stale = keys.filter((k) => held(k, t - 1) && !held(k, t) && k.type === "SH");
      const phantom = keys.filter((k) => !held(k, t - 1) && !held(k, t) && k.type === "SH");
      const missing = nonConfHeld.filter((k) => !k.core);
      let target: KeySpec;
      if (kind === "stale" && stale.length > 0) {
        target = pick(stale);
        original.content.set(target, target.shares[t - 1]);
      } else if (kind === "phantom" && phantom.length > 0) {
        target = pick(phantom);
        original.content.set(target, lot(target, t, 2e6, 1e7));
      } else if (kind === "missing" && missing.length > 0) {
        target = pick(missing);
        original.content.delete(target);
      } else {
        target = pick(nonConfHeld);
        const wrong = Math.round(target.shares[t] * uniform(1.1, 2));
        original.content.set(target, wrong === target.shares[t] ? wrong + 1 : wrong);
      }
      errorKeys[t].add(target);
      drafts.push({
        role: "restatement",
        period: t,
        accepted: `${addDays(original.accepted, int(5, 120))}T${randomTime()}`,
        content: restated,
      });
    } else if (r < 0.27) {
      const cands = h.filter(
        (k) => !k.core && k.type === "SH" && !conf[t].has(k) && (held(k, t - 1) || held(k, t + 1)),
      );
      if (cands.length > 0) {
        const k = pick(cands);
        missingKeys[t].add(k);
        original.content.delete(k);
        drafts.push({
          role: "new-holdings",
          period: t,
          accepted: `${addDays(original.accepted, int(5, 120))}T${randomTime()}`,
          content: new Map([[k, k.shares[t]]]),
        });
      }
    }

    const restatement = drafts.find((d) => d.period === t && d.role === "restatement");
    for (const k of h) {
      const d = conf[t].has(k)
        ? drafts.find((x) => x.period === t && x.role === "reveal")
        : missingKeys[t].has(k)
          ? drafts.find((x) => x.period === t && x.role === "new-holdings")
          : (restatement ?? original);
      sources[t].set(k, d as Draft);
    }
  }

  drafts.sort((a, b) => (a.accepted < b.accepted ? -1 : a.accepted > b.accepted ? 1 : 0));

  // Unit misreporting: a filer that kept using thousands after the cutover, or one
  // filing in the wrong unit.
  const misreportWindows: [string, string][] = [];
  const plan = rnd();
  const originalsAfter = drafts.filter((d) => d.role === "original" && d.accepted >= "2023-01-03");
  if (plan < 0.2 && originalsAfter.length > 0) {
    const last = originalsAfter[Math.min(originalsAfter.length, int(1, 2)) - 1];
    misreportWindows.push(["2023-01-03", addDays(last.accepted, 1)]);
  } else if (plan < 0.32) {
    const originals = drafts.filter((d) => d.role === "original");
    const victim = pick(originals);
    misreportWindows.push([victim.accepted.slice(0, 10), addDays(victim.accepted, 1)]);
  }
  const inWindow = (accepted: string) =>
    misreportWindows.some(([from, to]) => accepted >= from && accepted < to);
  if (drafts.filter((d) => inWindow(d.accepted)).length * 5 >= drafts.length * 2) {
    misreportWindows.length = 0;
  }
  const multiplierOf = (d: Draft) => {
    const expected = expectedMultiplier(d.accepted);
    return inWindow(d.accepted) ? (expected === 1000 ? 1 : 1000) : expected;
  };

  const rowCounts = new Map<Draft, Map<KeySpec, number>>();
  const filings: GeneratedFiling[] = drafts.map((d, seq) => {
    const mult = multiplierOf(d);
    const rows: InfoRow[] = [];
    const counts = new Map<KeySpec, number>();
    for (const [k, shares] of d.content) {
      const n = Math.min(shares, chance(0.25) ? int(2, 3) : 1);
      counts.set(k, n);
      const cuts = new Set<number>();
      while (cuts.size < n - 1) cuts.add(int(1, shares - 1));
      const bounds = [0, ...[...cuts].sort((a, b) => a - b), shares];
      const managers = ["", "1", "2", "3"].sort(() => rnd() - 0.5);
      for (let i = 0; i < n; i++) {
        const part = bounds[i + 1] - bounds[i];
        rows.push({
          nameOfIssuer: k.sec.name,
          titleOfClass: k.type === "PRN" ? "NOTE 2.500% 2030" : (k.putCall ?? "COM"),
          cusip: k.sec.cusip,
          value: Math.round((part * k.sec.price[d.period]) / mult),
          sshPrnamt: part,
          sshPrnamtType: k.type,
          putCall: k.putCall,
          investmentDiscretion: i === 0 ? "SOLE" : pick(["SHARED", "DFND"]),
          otherManager: n === 1 ? "" : managers[i],
        });
      }
    }
    for (let i = rows.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [rows[i], rows[j]] = [rows[j], rows[i]];
    }
    rowCounts.set(d, counts);
    const amendmentType: AmendmentType | null =
      d.role === "restatement" ? "RESTATEMENT" : d.role === "original" ? null : "NEW HOLDINGS";
    return {
      accessionNumber: `${cik}-${d.accepted.slice(2, 4)}-${String(seq + 1).padStart(6, "0")}`,
      cik,
      submissionType: d.role === "original" ? "13F-HR" : "13F-HR/A",
      periodOfReport: periods[d.period],
      acceptanceDateTime: d.accepted,
      amendmentType,
      confDeniedExpired: d.role === "reveal",
      rows,
      actualMultiplier: mult,
    };
  });

  // Ground truth, derived from the share paths and the artefact bookkeeping above.
  const originalOf = (t: number) =>
    drafts.find((d) => d.period === t && d.role === "original") as Draft;
  const truth: TruthCell[] = [];
  for (let t = 1; t < nPeriods; t++) {
    const cells = keys
      .filter((k) => held(k, t - 1) || held(k, t))
      .sort((a, b) => (a.key < b.key ? -1 : 1));
    for (const k of cells) {
      const prevShares = k.shares[t - 1];
      const shares = k.shares[t];
      const both = prevShares > 0 && shares > 0;
      const splitRatio = both && k.type === "SH" ? k.sec.split[t] : { n: 1, d: 1 };
      const shareDelta = shares - (prevShares * splitRatio.n) / splitRatio.d;
      const economic: EconomicLabel =
        prevShares === 0
          ? "NEW"
          : shares === 0
            ? "EXIT"
            : shareDelta > 0
              ? "ADD"
              : shareDelta < 0
                ? "TRIM"
                : "HOLD";
      const amended =
        (originalOf(t - 1).content.get(k) ?? 0) !== prevShares ||
        (originalOf(t).content.get(k) ?? 0) !== shares;
      const srcPrev = sources[t - 1].get(k);
      const srcCur = sources[t].get(k);
      const unitsDiffer = !!srcPrev && !!srcCur && multiplierOf(srcPrev) !== multiplierOf(srcCur);
      const isSplit = splitRatio.n !== splitRatio.d;

      let label: DeltaLabel;
      if (conf[t].has(k)) label = "LATE_REVEAL";
      else if (economic !== "HOLD") label = economic;
      else if (isSplit) label = "SPLIT_ONLY";
      else if (amended) label = "AMENDMENT_CORRECTION";
      else if (unitsDiffer) label = "UNIT_ARTEFACT";
      else label = "HOLD";

      const tags: ArtefactTag[] = [];
      if (isSplit) tags.push(shareDelta !== 0 ? "split-with-trade" : "split");
      const sides: [Draft | undefined, number][] = [
        [srcPrev, t - 1],
        [srcCur, t],
      ];
      if (sides.some(([d]) => d && (rowCounts.get(d)?.get(k) ?? 1) > 1)) tags.push("multi-row");
      if (keys.some((o) => o !== k && o.sec === k.sec && (held(o, t - 1) || held(o, t)))) {
        tags.push("option-and-stock");
      }
      if (
        srcPrev &&
        srcCur &&
        expectedMultiplier(srcPrev.accepted) !== expectedMultiplier(srcCur.accepted)
      ) {
        tags.push("unit-cutover");
      }
      if (sides.some(([d]) => d && inWindow(d.accepted))) tags.push("unit-misreport");
      if (errorKeys[t].has(k) || errorKeys[t - 1].has(k)) tags.push("restatement");
      if (missingKeys[t].has(k) || missingKeys[t - 1].has(k)) tags.push("new-holdings");
      if (conf[t].has(k) || conf[t - 1].has(k)) tags.push("confidential-reveal");
      if (tags.length === 0) tags.push("clean");

      truth.push({
        key: k.key,
        cusip: k.sec.cusip,
        prevPeriod: periods[t - 1],
        period: periods[t],
        label,
        economic,
        prevShares,
        shares,
        splitRatio,
        shareDelta,
        tags,
      });
    }
  }

  return { seed, cik, periods, filings, truth };
}
