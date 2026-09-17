import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { diffPeriods } from "./diff.js";
import { foldFilings } from "./fold.js";
import { parseFilingStream } from "./parse.js";
import type { Delta, Filing } from "./types.js";
import { normalise } from "./units.js";

/** Streams and parses every `.xml` file in a directory, recursively. */
export async function readFilingsDir(dir: string): Promise<Filing[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  const paths = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".xml"))
    .map((e) => join(e.parentPath ?? dir, e.name))
    .sort();
  const filings: Filing[] = [];
  for (const path of paths) {
    try {
      filings.push(await parseFilingStream(createReadStream(path, "utf8")));
    } catch (err) {
      throw new Error(`${path}: ${(err as Error).message}`);
    }
  }
  return filings;
}

/** Parse-free core: normalise units, fold amendments, classify. */
export function classify(filings: readonly Filing[]): Delta[] {
  return diffPeriods(foldFilings(normalise(filings)));
}
