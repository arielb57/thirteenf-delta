import { generateHistory } from "../src/generator.js";
import { naiveDiff } from "../src/naive.js";
import { parseFiling } from "../src/parse.js";
import { classify } from "../src/pipeline.js";
import { ratioToString } from "../src/rational.js";
import { renderFiling } from "../src/render.js";

/**
 * Prints, for one generated history, every cell where the naive diff and the classified
 * diff disagree, next to the ground truth. With no seed, picks the seed in 1..500 whose
 * history exercises the most distinct artefacts.
 */
const arg = process.argv[2];
let seed = Number(arg);
if (arg === undefined) {
  let best = -1;
  for (let s = 1; s <= 500; s++) {
    const tags = new Set(generateHistory(s).truth.flatMap((t) => t.tags));
    if (tags.size > best) {
      best = tags.size;
      seed = s;
    }
  }
}

const h = generateHistory(seed);
const filings = h.filings.map((f) => parseFiling(renderFiling(f)));
const classified = new Map(classify(filings).map((d) => [`${d.key}@${d.period}`, d]));
const naive = new Map(naiveDiff(filings).map((d) => [`${d.cusip}@${d.period}`, d]));

const typeOf = (key: string) => {
  const [, putCall, type] = key.split("|");
  return putCall === "-" ? type : putCall;
};

console.log(
  `Seed ${seed}: manager ${h.cik}, ${h.periods[0]} to ${h.periods[h.periods.length - 1]}, ${h.filings.length} filings\n`,
);
console.log("| Quarter | CUSIP | Type | Naive diff | thirteenf-delta | Truth | Artefacts |");
console.log("|---|---|---|---|---|---|---|");
let shown = 0;
for (const t of h.truth) {
  const d = classified.get(`${t.key}@${t.period}`);
  const n = naive.get(`${t.cusip}@${t.period}`);
  if (n?.label === d?.label) continue;
  shown++;
  const naiveText = n
    ? `${n.label} ${n.shares - n.prevShares >= 0 ? "+" : ""}${(n.shares - n.prevShares).toLocaleString("en-US")}${n.valueRatio !== null && (n.valueRatio > 100 || n.valueRatio < 0.01) ? ` (value x${Math.round(n.valueRatio)})` : ""}`
    : "(missing)";
  const split =
    d && d.splitRatio.n !== d.splitRatio.d ? ` split ${ratioToString(d.splitRatio)}` : "";
  const ours = d
    ? `${d.label} ${d.shareDelta >= 0 ? "+" : ""}${d.shareDelta.toLocaleString("en-US")}${split}`
    : "(missing)";
  console.log(
    `| ${t.period} | ${t.cusip} | ${typeOf(t.key)} | ${naiveText} | ${ours} | ${t.label} | ${t.tags.join(", ")} |`,
  );
}
console.log(`\n${shown} of ${h.truth.length} position-quarters differ between the two diffs.`);
