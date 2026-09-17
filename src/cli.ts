#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { generateHistory } from "./generator.js";
import { naiveDiff } from "./naive.js";
import { classify, readFilingsDir } from "./pipeline.js";
import { ratioToString } from "./rational.js";
import { renderFiling } from "./render.js";
import type { Delta } from "./types.js";

const USAGE = `Usage:
  thirteenf-delta diff <dir> --manager <cik> [--format text|json] [--all] [--naive]
  thirteenf-delta generate <dir> [--seed <n>]

diff      Read every .xml filing under <dir>, fold amendments, normalise units,
          infer splits and print one classified change per position and quarter.
          HOLD rows are hidden unless --all is given. --naive prints the
          CUSIP-keyed, amendment-blind diff most trackers compute, for comparison.
generate  Write a synthetic fund history (filings plus truth.json) to <dir>.
`;

class UsageError extends Error {}

function positionType(d: Delta): string {
  return d.putCall ?? d.sshPrnamtType;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function signed(n: number): string {
  return n > 0 ? `+${fmt(n)}` : fmt(n);
}

function table(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i]))
      .join("  ")
      .trimEnd();
  return [line(header), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

async function runDiff(args: string[]): Promise<string> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      manager: { type: "string" },
      format: { type: "string", default: "text" },
      all: { type: "boolean", default: false },
      naive: { type: "boolean", default: false },
    },
  });
  if (positionals.length !== 1) throw new UsageError("diff needs exactly one directory");
  if (!values.manager) throw new UsageError("diff needs --manager <cik>");
  if (values.format !== "text" && values.format !== "json") {
    throw new UsageError(`unknown --format '${values.format}'`);
  }
  const cik = values.manager.padStart(10, "0");
  const all = await readFilingsDir(positionals[0]);
  const filings = all.filter((f) => f.cik === cik);
  if (filings.length === 0) {
    const found = [...new Set(all.map((f) => f.cik))].join(", ") || "none";
    throw new Error(
      `no filings for manager ${cik} in ${positionals[0]} (managers found: ${found})`,
    );
  }

  if (values.naive) {
    const deltas = naiveDiff(filings).filter((d) => values.all || d.label !== "HOLD");
    if (values.format === "json") return JSON.stringify(deltas, null, 2);
    return table(
      ["PERIOD", "CUSIP", "LABEL", "PREV SHARES", "SHARES", "VALUE RATIO"],
      deltas.map((d) => [
        d.period,
        d.cusip,
        d.label,
        fmt(d.prevShares),
        fmt(d.shares),
        d.valueRatio === null ? "" : `${d.valueRatio.toFixed(3)}x`,
      ]),
    );
  }

  const deltas = classify(filings).filter((d) => values.all || d.label !== "HOLD");
  if (values.format === "json") return JSON.stringify(deltas, null, 2);
  return table(
    [
      "PERIOD",
      "CUSIP",
      "TYPE",
      "ISSUER",
      "LABEL",
      "PREV SHARES",
      "SHARES",
      "SPLIT",
      "TRADE",
      "VALUE USD",
      "ROWS",
    ],
    deltas.map((d) => [
      d.period,
      d.cusip,
      positionType(d),
      d.nameOfIssuer,
      d.label,
      fmt(d.prevShares),
      fmt(d.shares),
      d.splitRatio.n === d.splitRatio.d ? "" : ratioToString(d.splitRatio),
      signed(d.shareDelta),
      fmt(d.valueUsd),
      `${d.evidence.prev.length}/${d.evidence.cur.length}`,
    ]),
  );
}

async function runGenerate(args: string[]): Promise<string> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { seed: { type: "string", default: "1" } },
  });
  if (positionals.length !== 1) throw new UsageError("generate needs exactly one directory");
  const seed = Number(values.seed);
  if (!Number.isInteger(seed) || seed < 0) throw new UsageError(`invalid --seed '${values.seed}'`);
  const dir = positionals[0];
  const history = generateHistory(seed);
  await mkdir(dir, { recursive: true });
  for (const f of history.filings) {
    const { actualMultiplier: _unused, ...filing } = f;
    await writeFile(join(dir, `${f.accessionNumber}.xml`), renderFiling(filing));
  }
  await writeFile(join(dir, "truth.json"), `${JSON.stringify(history.truth, null, 2)}\n`);
  return `wrote ${history.filings.length} filings for manager ${history.cik} (${history.periods[0]} to ${history.periods[history.periods.length - 1]}) and truth.json to ${dir}`;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    let out: string;
    if (command === "diff") out = await runDiff(rest);
    else if (command === "generate") out = await runGenerate(rest);
    else if (command === undefined || command === "--help" || command === "-h") {
      process.stdout.write(USAGE);
      return command === undefined ? 2 : 0;
    } else throw new UsageError(`unknown command '${command}'`);
    process.stdout.write(`${out}\n`);
    return 0;
  } catch (err) {
    if (
      err instanceof UsageError ||
      (err as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")
    ) {
      process.stderr.write(`error: ${(err as Error).message}\n\n${USAGE}`);
      return 2;
    }
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
