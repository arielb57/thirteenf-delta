import { cpus } from "node:os";
import { generateHistory } from "../src/generator.js";
import { scoreHistories, type Tally } from "./score.js";

const HISTORIES = Number(process.env.BENCH_HISTORIES ?? 2000);

const pct = (n: number, d: number) => (d === 0 ? "-" : `${((100 * n) / d).toFixed(1)}%`);
const row = (name: string, t: Tally) =>
  `| ${name} | ${t.cells} | ${pct(t.naive, t.cells)} | ${pct(t.classified, t.cells)} |`;

const started = performance.now();
const score = scoreHistories(
  (function* () {
    for (let seed = 1; seed <= HISTORIES; seed++) yield generateHistory(seed);
  })(),
);
const seconds = (performance.now() - started) / 1000;

console.log(
  `${score.histories} generated fund histories (seeds 1..${HISTORIES}), ${score.filings} filings\n`,
);
console.log("| Cells | Count | Naive diff | thirteenf-delta |");
console.log("|---|---:|---:|---:|");
console.log(row("**All CUSIP-period deltas**", score.overall));
console.log("\nBy artefact present in the cell (a cell can carry several):\n");
console.log("| Artefact | Cells | Naive diff | thirteenf-delta |");
console.log("|---|---:|---:|---:|");
for (const [tag, t] of score.byTag) console.log(row(tag, t));
console.log("\nBy true label:\n");
console.log("| True label | Cells | Naive diff | thirteenf-delta |");
console.log("|---|---:|---:|---:|");
for (const [label, t] of [...score.byLabel].sort()) console.log(row(label, t));
console.log(
  `\nSpurious deltas (reported for a position and quarter with no true change record): naive ${score.spurious.naive}, thirteenf-delta ${score.spurious.classified}`,
);
console.log(
  `\nRender + parse + classify + score: ${seconds.toFixed(1)} s on ${cpus()[0]?.model ?? "unknown CPU"}, Node ${process.version}`,
);
