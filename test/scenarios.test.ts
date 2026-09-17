import assert from "node:assert/strict";
import { test } from "node:test";
import { foldFilings, positionKey } from "../src/fold.js";
import { naiveDiff } from "../src/naive.js";
import { normalise } from "../src/units.js";
import { classify, core, filing, find, pos } from "./helpers.js";

const X = "46625H100";

test("a RESTATEMENT that removes a row turns into EXIT, not a stale hold", () => {
  const filings = [
    filing({
      period: "2021-03-31",
      accepted: "2021-05-01",
      rows: [...core(0), pos(X, 10_000, 100)],
    }),
    // The original still lists X; the restatement drops it.
    filing({
      period: "2021-06-30",
      accepted: "2021-08-01",
      rows: [...core(1), pos(X, 10_000, 101)],
    }),
    filing({
      period: "2021-06-30",
      accepted: "2021-09-15",
      amendment: "RESTATEMENT",
      rows: core(1),
    }),
  ];
  const d = find(classify(filings), X, "2021-06-30");
  assert.equal(d.label, "EXIT");
  assert.equal(d.shareDelta, -10_000);
  assert.equal(d.evidence.cur.length, 0);
  assert.equal(naiveDiff(filings).find((n) => n.cusip === X)?.label, "HOLD");
});

test("NEW HOLDINGS amendments fold correctly in both orders relative to a RESTATEMENT", () => {
  const period = "2021-06-30";
  const prev = filing({
    period: "2021-03-31",
    accepted: "2021-05-01",
    rows: [...core(0), pos(X, 1000, 100)],
  });
  const original = filing({ period, accepted: "2021-08-01", rows: [...core(1), pos(X, 999, 100)] });
  const addY = (accepted: string) =>
    filing({ period, accepted, amendment: "NEW HOLDINGS", rows: [pos("30303M102", 4000, 300)] });
  const restate = (accepted: string) =>
    filing({ period, accepted, amendment: "RESTATEMENT", rows: [...core(1), pos(X, 1000, 100)] });

  // Restatement first, then the new holdings add on top of it.
  const a = classify([prev, original, restate("2021-08-10"), addY("2021-08-20")]);
  assert.equal(find(a, X, period).label, "AMENDMENT_CORRECTION");
  assert.equal(find(a, "30303M102", period).label, "NEW");

  // New holdings first: the later restatement replaces everything, including them.
  const b = classify([prev, original, addY("2021-08-10"), restate("2021-08-20")]);
  assert.equal(find(b, X, period).label, "AMENDMENT_CORRECTION");
  assert.equal(
    b.some((d) => d.cusip === "30303M102"),
    false,
  );

  // File order on disk is irrelevant; acceptance order decides.
  assert.deepEqual(
    classify([restate("2021-08-10"), addY("2021-08-20"), original, prev]).map((d) => d.label),
    classify([prev, original, restate("2021-08-10"), addY("2021-08-20")]).map((d) => d.label),
  );
});

test("a position split across three otherManager rows is summed", () => {
  const filings = [
    filing({
      period: "2021-03-31",
      accepted: "2021-05-01",
      rows: [...core(0), pos(X, 30_000, 50)],
    }),
    filing({
      period: "2021-06-30",
      accepted: "2021-08-01",
      rows: [
        ...core(1),
        pos(X, 10_000, 50, { otherManager: "1", discretion: "SHARED" }),
        pos(X, 15_000, 50, { otherManager: "2", discretion: "DFND" }),
        pos(X, 5_000, 50, { otherManager: "3", discretion: "SOLE" }),
      ],
    }),
  ];
  const d = find(classify(filings), X, "2021-06-30");
  assert.equal(d.label, "HOLD");
  assert.equal(d.shares, 30_000);
  assert.equal(d.evidence.cur.length, 3);
});

test("a call option and the common stock on the same CUSIP stay separate", () => {
  const filings = [
    filing({
      period: "2021-03-31",
      accepted: "2021-05-01",
      rows: [...core(0), pos(X, 20_000, 80), pos(X, 5_000, 80, { putCall: "CALL" })],
    }),
    filing({
      period: "2021-06-30",
      accepted: "2021-08-01",
      rows: [...core(1), pos(X, 15_000, 80), pos(X, 10_000, 80, { putCall: "CALL" })],
    }),
  ];
  const deltas = classify(filings);
  assert.equal(find(deltas, X, "2021-06-30").label, "TRIM");
  assert.equal(find(deltas, X, "2021-06-30").shareDelta, -5_000);
  assert.equal(find(deltas, X, "2021-06-30", "CALL").label, "ADD");
  assert.equal(find(deltas, X, "2021-06-30", "CALL").shareDelta, 5_000);
  // Summed by CUSIP alone, the naive diff sees 25,000 then 25,000: no change at all.
  assert.equal(naiveDiff(filings).find((n) => n.cusip === X)?.label, "HOLD");
  const folded = foldFilings(normalise(filings));
  assert.ok(folded[1].holdings.has(positionKey(X, "CALL", "SH")));
  assert.ok(folded[1].holdings.has(positionKey(X, null, "SH")));
});

test("a 3:2 split alongside a 5% real add reports ADD of the right size", () => {
  const filings = [
    filing({
      period: "2021-03-31",
      accepted: "2021-05-01",
      rows: [...core(0), pos(X, 20_000, 90)],
    }),
    // 20,000 pre-split = 30,000 post-split; 5% more is 31,500 at $60 * 1.02 market move.
    filing({
      period: "2021-06-30",
      accepted: "2021-08-01",
      rows: [...core(1), pos(X, 31_500, 61.2)],
    }),
  ];
  const d = find(classify(filings), X, "2021-06-30");
  assert.equal(d.label, "ADD");
  assert.deepEqual(d.splitRatio, { n: 3, d: 2 });
  assert.equal(d.adjustedPrevShares, 30_000);
  assert.equal(d.shareDelta, 1_500);

  const pure = [
    filings[0],
    filing({
      period: "2021-06-30",
      accepted: "2021-08-01",
      rows: [...core(1), pos(X, 30_000, 58.9)],
    }),
  ];
  const s = find(classify(pure), X, "2021-06-30");
  assert.equal(s.label, "SPLIT_ONLY");
  assert.equal(s.shareDelta, 0);
  assert.equal(naiveDiff(pure).find((n) => n.cusip === X)?.label, "ADD");
});

test("a real doubling without a split is an ADD, not a 2:1 split", () => {
  const filings = [
    filing({
      period: "2021-03-31",
      accepted: "2021-05-01",
      rows: [...core(0), pos(X, 20_000, 90)],
    }),
    filing({
      period: "2021-06-30",
      accepted: "2021-08-01",
      rows: [...core(1), pos(X, 40_000, 91)],
    }),
  ];
  const d = find(classify(filings), X, "2021-06-30");
  assert.equal(d.label, "ADD");
  assert.deepEqual(d.splitRatio, { n: 1, d: 1 });
  assert.equal(d.shareDelta, 20_000);
});

test("a quarter straddling 2023-01-03 is a UNIT_ARTEFACT, not a 1000x buy", () => {
  const filings = [
    filing({
      period: "2022-09-30",
      accepted: "2022-11-10",
      rows: [...core(0), pos(X, 10_000, 100)],
    }),
    filing({
      period: "2022-12-31",
      accepted: "2023-02-10",
      rows: [...core(1), pos(X, 10_000, 102)],
    }),
  ];
  assert.equal(filings[0].rows[3].value, 1_000);
  assert.equal(filings[1].rows[3].value, 1_020_000);
  const d = find(classify(filings), X, "2022-12-31");
  assert.equal(d.label, "UNIT_ARTEFACT");
  assert.equal(d.prevValueUsd, 1_000_000);
  assert.equal(d.valueUsd, 1_020_000);
  assert.ok((naiveDiff(filings).find((n) => n.cusip === X)?.valueRatio ?? 0) > 1000);
});

test("a filer who kept reporting in thousands after the cutover is detected and rescaled", () => {
  const periods = [
    "2022-06-30",
    "2022-09-30",
    "2022-12-31",
    "2023-03-31",
    "2023-06-30",
    "2023-09-30",
  ];
  const accepted = [
    "2022-08-10",
    "2022-11-10",
    "2023-02-10",
    "2023-05-10",
    "2023-08-10",
    "2023-11-10",
  ];
  // Thousands throughout, but only the first two filings were entitled to use them.
  const filings = periods.map((period, i) =>
    filing({
      period,
      accepted: accepted[i],
      unit: i < 4 ? 1000 : 1,
      rows: [...core(i), pos(X, 10_000, 100)],
    }),
  );
  const norm = normalise(filings);
  assert.deepEqual(
    norm.map((f) => [f.unit.expectedMultiplier, f.unit.multiplier, f.unit.misreported]),
    [
      [1000, 1000, false],
      [1000, 1000, false],
      [1, 1000, true],
      [1, 1000, true],
      [1, 1, false],
      [1, 1, false],
    ],
  );
  const deltas = classify(filings);
  // The thousands-to-thousands step looks continuous; the real unit change is 2023-06-30.
  assert.equal(find(deltas, X, "2022-12-31").label, "HOLD");
  assert.equal(find(deltas, X, "2023-06-30").label, "UNIT_ARTEFACT");
  for (const d of deltas) assert.ok(Math.abs(d.valueUsd / d.prevValueUsd - 1) < 0.05, d.key);
});

test("a confidential position revealed two quarters late lands in its own quarter", () => {
  const H = "38141G104";
  const filings = [
    filing({ period: "2021-03-31", accepted: "2021-05-01", rows: core(0) }),
    // H bought in Q2 but kept confidential.
    filing({ period: "2021-06-30", accepted: "2021-08-01", rows: core(1) }),
    filing({
      period: "2021-09-30",
      accepted: "2021-11-01",
      rows: [...core(2), pos(H, 50_000, 300)],
    }),
    filing({
      period: "2021-12-31",
      accepted: "2022-02-01",
      rows: [...core(3), pos(H, 50_000, 303)],
    }),
    // Accepted after two more quarterly filings, carrying the original period.
    filing({
      period: "2021-06-30",
      accepted: "2022-02-05",
      amendment: "NEW HOLDINGS",
      reveal: true,
      rows: [pos(H, 50_000, 297)],
    }),
  ];
  const deltas = classify(filings);
  const reveal = find(deltas, H, "2021-06-30");
  assert.equal(reveal.label, "LATE_REVEAL");
  assert.equal(reveal.economic, "NEW");
  assert.equal(reveal.evidence.cur[0].confDeniedExpired, true);
  // The quarter where it first appeared in an original filing is not a new buy.
  assert.equal(find(deltas, H, "2021-09-30").label, "AMENDMENT_CORRECTION");
  assert.equal(find(deltas, H, "2021-09-30").economic, "HOLD");
  assert.equal(naiveDiff(filings).find((n) => n.cusip === H)?.label, "NEW");
  assert.equal(naiveDiff(filings).find((n) => n.cusip === H)?.period, "2021-09-30");
});

test("principal amounts never merge with shares and are never split-adjusted", () => {
  const B = "912828ZT0";
  const filings = [
    filing({
      period: "2021-03-31",
      accepted: "2021-05-01",
      rows: [
        ...core(0),
        { cusip: B, shares: 2_000_000, usd: 2_000_000, type: "PRN" },
        pos(B, 1_000, 2000),
      ],
    }),
    filing({
      period: "2021-06-30",
      accepted: "2021-08-01",
      rows: [
        ...core(1),
        { cusip: B, shares: 2_000_000, usd: 1_000_000, type: "PRN" },
        pos(B, 1_000, 2000),
      ],
    }),
  ];
  const deltas = classify(filings);
  const prn = deltas.find((d) => d.cusip === B && d.sshPrnamtType === "PRN");
  assert.equal(prn?.label, "HOLD");
  assert.deepEqual(prn?.splitRatio, { n: 1, d: 1 });
  assert.equal(deltas.filter((d) => d.cusip === B).length, 2);
});

test("folding refuses to mix managers", () => {
  const a = filing({ period: "2021-03-31", accepted: "2021-05-01", rows: core(0) });
  const b = {
    ...filing({ period: "2021-03-31", accepted: "2021-05-02", rows: core(0) }),
    cik: "0000000001",
  };
  assert.throws(() => foldFilings(normalise([a, b])), /one manager/);
});
