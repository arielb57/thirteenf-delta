import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { generateHistory, type TruthCell } from "../src/generator.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
const dir = mkdtempSync(join(tmpdir(), "thirteenf-delta-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function run(...args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
}

test("generate then diff --format json reproduces the ground truth", () => {
  const seed = 42;
  const gen = run("generate", dir, "--seed", String(seed));
  assert.equal(gen.status, 0, gen.stderr);
  const { cik, filings } = generateHistory(seed);
  assert.equal(readdirSync(dir).filter((f) => f.endsWith(".xml")).length, filings.length);

  const out = run("diff", dir, "--manager", cik, "--format", "json", "--all");
  assert.equal(out.status, 0, out.stderr);
  const deltas = JSON.parse(out.stdout) as { key: string; period: string; label: string }[];
  const truth = JSON.parse(readFileSync(join(dir, "truth.json"), "utf8")) as TruthCell[];
  assert.deepEqual(
    deltas.map((d) => `${d.key}@${d.period}=${d.label}`).sort(),
    truth.map((t) => `${t.key}@${t.period}=${t.label}`).sort(),
  );
});

test("text output hides HOLD rows and shows a table", () => {
  const { cik } = generateHistory(42);
  const out = run("diff", dir, "--manager", cik.replace(/^0+/, ""));
  assert.equal(out.status, 0, out.stderr);
  const lines = out.stdout.trim().split("\n");
  assert.match(lines[0], /^PERIOD\s+CUSIP\s+TYPE\s+ISSUER\s+LABEL/);
  assert.ok(lines.length > 3);
  assert.ok(!lines.slice(2).some((l) => /\sHOLD\s/.test(l)));

  const naive = run("diff", dir, "--manager", cik, "--naive");
  assert.equal(naive.status, 0, naive.stderr);
  assert.match(naive.stdout, /VALUE RATIO/);
});

test("usage and input errors exit non-zero with a message", () => {
  assert.equal(run().status, 2);
  const noManager = run("diff", dir);
  assert.equal(noManager.status, 2);
  assert.match(noManager.stderr, /--manager/);
  const wrongManager = run("diff", dir, "--manager", "999");
  assert.equal(wrongManager.status, 1);
  assert.match(wrongManager.stderr, /no filings for manager 0000000999/);
  assert.equal(run("diff", dir, "--manager", "1", "--format", "yaml").status, 2);
  const missing = run("diff", join(dir, "nope"), "--manager", "1");
  assert.equal(missing.status, 1);
  assert.equal(run("frobnicate").status, 2);
});
