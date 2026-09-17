export type { DiffOptions } from "./diff.js";
export { diffPair, diffPeriods } from "./diff.js";
export { aggregateRows, foldFilings, positionKey } from "./fold.js";
export type { ArtefactTag, GeneratedFiling, GeneratedHistory, TruthCell } from "./generator.js";
export { ARTEFACT_TAGS, cusipCheckDigit, generateHistory, rngFromSeed } from "./generator.js";
export type { NaiveDelta } from "./naive.js";
export { naiveDiff } from "./naive.js";
export { FilingParseError, parseFiling, parseFilingStream } from "./parse.js";
export { classify, readFilingsDir } from "./pipeline.js";
export {
  inferSplit,
  SPLIT_PRICE_TOLERANCE,
  SPLIT_RATIOS,
  simplestRationalInInterval,
} from "./rational.js";
export { renderFiling } from "./render.js";
export type * from "./types.js";
export { expectedMultiplier, normalise, UNIT_CUTOVER } from "./units.js";
export { XmlError, XmlTokenizer } from "./xml.js";
