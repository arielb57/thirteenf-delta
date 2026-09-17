# thirteenf-delta

Finds the real quarter-to-quarter position changes in SEC 13F filings, and labels the changes that only come from amendments, value units or stock splits.

## The problem

13F trackers regularly say a fund "bought 1000x more" of a stock. Usually the fund did nothing. There are a few common causes:

- The SEC switched the `<value>` field from thousands of dollars to dollars in January 2023.
- A 13F-HR/A was a RESTATEMENT of the whole quarter, not an addition to it.
- The stock split.
- One position was spread across several rows by other-manager or investment-discretion codes, or its call options were summed with the common stock.
- A position with confidential treatment appeared quarters later and looked like a new buy.

Every tracker has to fold these cases the same way, but nobody publishes the rules as code, so each one reinvents them, often incorrectly. thirteenf-delta is those rules as a small library with zero runtime dependencies. It comes with a synthetic-data generator that checks the rules against a known ground truth.

## How it works

```
XML files ──► streaming tokenizer ──► normalise() ──► foldFilings() ──► diffPeriods() ──► labelled deltas
              (zero dependencies)     units per       amendments in     splits and label
                                      filing, 1000x   acceptance order  precedence
                                      misreport check
```

**1. Streaming XML tokenizer** (`src/xml.ts`). This is a hand-written tokenizer for the part of XML that 13F documents use: elements, attributes, the five named entities and numeric character references, comments, CDATA, processing instructions and DOCTYPE. Input can arrive in chunks that split anywhere, even inside a tag or an entity. The tests feed every possible two-chunk split of a document and check that the events come out identical. Namespace prefixes are dropped, so `ns1:infoTable` and `infoTable` parse the same way.

**2. Unit normalisation** (`src/units.ts`). Each filing's expected unit comes from its **acceptance date**: filings accepted before 2023-01-03 report thousands, later ones report dollars. Some filers use the wrong unit anyway, so the tool compares every pair of the same manager's filings whose periods are at most one quarter apart:

- For each shared CUSIP it computes the implied price, value ÷ shares.
- It takes the median log10 price ratio across those CUSIPs and rounds it to the nearest multiple of 3. The result is 0 or ±3, because real prices do not move 30x in a quarter.
- Those relative offsets are spread across the connected graph of filings with a BFS.
- The offset shared by the most filings counts as correct. Every other filing is rescaled by exactly 1000x.

A filer who kept reporting in thousands for two quarters after the cutover is caught this way, even though those two filings agree with each other.

**3. Amendment fold** (`src/fold.ts`). Filings for each period of report are applied in acceptance order, with ties broken by accession number:

- The first filing is the base.
- A `RESTATEMENT` replaces the entire holdings set.
- A `NEW HOLDINGS` amendment adds rows. If its cover page has `confDeniedExpired`, the positions it adds are marked as revealed. The amendment carries the original period of report, so a late reveal lands in the quarter the position was held, not the quarter the amendment was accepted.

Rows are summed per **(CUSIP, putCall, sshPrnamtType)** across `otherManager` and `investmentDiscretion`, so a call option, a principal amount and common shares on the same CUSIP stay three separate positions. The fold also keeps each period's share counts as the original filing reported them.

**4. Split inference** (`src/rational.ts`). A k-for-1 split multiplies shares by k and divides the implied price by k. When a position is held in both quarters, the tool:

1. Takes the observed price ratio `r = price_now / price_before`.
2. Assumes the market moved by at most ±5% on top of any split, so k must lie in `[(1 − 0.05)/r, (1 + 0.05)/r]`.
3. Walks the **Stern–Brocot tree** to find the simplest rational in that interval: smallest denominator, then smallest numerator. Runs of moves in the same direction are skipped in one step, so the search is logarithmic.
4. Accepts the candidate only if it is one of 2, 3, 4, 5, 10, 3/2 or their reciprocals.

The previous share count is then restated in post-split shares, so the trade is `shares − prevShares × k`. Share counts never enter the inference, which is why a 3:2 split with a 5% purchase on top comes out as `ADD +5%` and not as `SPLIT_ONLY`. A test checks every recognised ratio across the whole ±3% move range. With a 5% band, the interval around 10 excludes both 9 and 11, and the interval around 3/2 contains no simpler fraction.

**5. Classifier** (`src/diff.ts`). Every position held in either of two consecutive quarters gets one label. The first matching rule wins:

| Label | When |
|---|---|
| `LATE_REVEAL` | the position entered this quarter's holdings through a confidential-treatment amendment |
| `NEW` / `EXIT` / `ADD` / `TRIM` | the split-adjusted share count really changed |
| `SPLIT_ONLY` | a split was inferred and nothing else changed |
| `AMENDMENT_CORRECTION` | no real change, but an amendment altered the share count on either side (a tracker that reads only original filings sees a change here) |
| `UNIT_ARTEFACT` | no real change, but the two sides were reported in different value units |
| `HOLD` | nothing happened |

Each delta also carries:

- `economic`: the underlying NEW/EXIT/ADD/TRIM/HOLD, even when a reporting label takes precedence
- `splitRatio`, `adjustedPrevShares` and `shareDelta`
- dollar values on both sides
- the evidence rows on each side, each with its accession number, amendment type, acceptance time, other-manager and discretion codes, reported value and the unit multiplier applied
- plain-language notes

### Worked example

Seed 15 of the generator is a fund history from 2021Q3 to 2023Q1. It includes a 1-for-4 reverse split, 3-for-1 and 5-for-1 splits, a confidential put position for 2022-03-31 that was revealed only in October 2022 (two quarterly filings later), three restatements, a NEW HOLDINGS amendment filed across the unit cutover, and a filer who kept reporting in thousands after the cutover. These are the position-quarters where the naive diff and thirteenf-delta disagree (`npm run compare`):

| Quarter | CUSIP | Type | Naive diff | thirteenf-delta | Truth | Artefacts |
|---|---|---|---|---|---|---|
| 2021-12-31 | LDMK2O106 | PUT | ADD +29,718 | HOLD +0 | HOLD | option-and-stock |
| 2022-03-31 | C9LWB0102 | SH | TRIM -8,175 | SPLIT_ONLY +0 split 1/4 | SPLIT_ONLY | split |
| 2022-03-31 | LDMK2O106 | PUT | EXIT -193,018 | LATE_REVEAL -12,597 | LATE_REVEAL | multi-row, option-and-stock, confidential-reveal |
| 2022-03-31 | S72PO7106 | SH | EXIT -73,339 | AMENDMENT_CORRECTION +0 | AMENDMENT_CORRECTION | restatement |
| 2022-06-30 | LDMK2O106 | PUT | NEW +69,703 | AMENDMENT_CORRECTION +0 | AMENDMENT_CORRECTION | multi-row, confidential-reveal |
| 2022-06-30 | S72PO7106 | SH | NEW +111,835 | ADD +38,496 | ADD | restatement |
| 2022-09-30 | 0Q893Y108 | SH | TRIM -88,878 | ADD +133,618 | ADD | restatement |
| 2022-09-30 | 53WQLN103 | SH | TRIM -8,484 | NEW +28,600 | NEW | option-and-stock, new-holdings |
| 2022-09-30 | 8NXA2D103 | SH | ADD +166,800 | SPLIT_ONLY +0 split 5 | SPLIT_ONLY | split, multi-row |
| 2022-09-30 | S72PO7106 | SH | ADD +223,670 | SPLIT_ONLY +0 split 3 | SPLIT_ONLY | split |
| 2022-12-31 | 53WQLN103 | SH | ADD +42,515 | AMENDMENT_CORRECTION +0 | AMENDMENT_CORRECTION | option-and-stock, unit-misreport, new-holdings |
| 2023-03-31 | 53WQLN103 | SH | TRIM -21,375 (value x701) | AMENDMENT_CORRECTION +0 | AMENDMENT_CORRECTION | option-and-stock, unit-misreport, restatement |
| 2023-03-31 | 53WQLN103 | PUT | TRIM -21,375 (value x701) | ADD +7,225 | ADD | option-and-stock, unit-misreport |
| 2023-03-31 | C1H0E5100 | SH | HOLD +0 (value x970) | UNIT_ARTEFACT +0 | UNIT_ARTEFACT | unit-misreport |
| 2023-03-31 | S72PO7106 | SH | HOLD +0 (value x978) | UNIT_ARTEFACT +0 | UNIT_ARTEFACT | unit-misreport |

15 of the 47 position-quarters differ. In every row, thirteenf-delta matches the ground truth.

## Install and usage

Requires Node.js 20.12 or later. There are no runtime dependencies. TypeScript, Biome and fast-check are dev-only.

```sh
git clone <this repository> thirteenf-delta && cd thirteenf-delta
npm install
npm test          # builds, then runs the node:test suite
npm run bench     # 2,000 generated histories, naive vs classified
npm run compare   # the worked-example table above (optionally: npm run compare -- <seed>)
```

Generate a synthetic fund history and diff it:

```console
$ node dist/src/cli.js generate ./filings --seed 15
wrote 12 filings for manager 0001237840 (2021-09-30 to 2023-03-31) and truth.json to ./filings

$ node dist/src/cli.js diff ./filings --manager 0001237840
PERIOD      CUSIP      TYPE  ISSUER                LABEL                 PREV SHARES  SHARES   SPLIT  TRADE     VALUE USD   ROWS
----------  ---------  ----  --------------------  --------------------  -----------  -------  -----  --------  ----------  ----
2021-12-31  0Q893Y108  SH    VECTOR LOGISTICS INC  ADD                   120,200      347,844  2      +107,444  27,399,000  2/1
2021-12-31  C1H0E5100  SH    SUMMIT ROBOTICS INC   TRIM                  27,300       16,374          -10,926   6,161,000   1/1
2021-12-31  LDMK2O106  SH    POLAR BANCORP INC     ADD                   81,000       110,718         +29,718   19,577,000  1/1
2021-12-31  S72PO7106  SH    HARBOR LOGISTICS INC  ADD                   51,700       73,339          +21,639   23,044,000  1/1
2022-03-31  0Q893Y108  SH    VECTOR LOGISTICS INC  ADD                   347,844      417,122         +69,278   31,890,000  1/2
2022-03-31  53WQLN103  PUT   HARBOR ROBOTICS INC   ADD                   40,800       54,960          +14,160   11,941,000  1/1
2022-03-31  C1H0E5100  SH    SUMMIT ROBOTICS INC   ADD                   16,374       25,809          +9,435    9,710,000   1/1
2022-03-31  C9LWB0102  SH    VECTOR FOODS INC      SPLIT_ONLY            10,900       2,725    1/4    0         2,867,000   1/1
2022-03-31  LDMK2O106  SH    POLAR BANCORP INC     EXIT                  110,718      0               -110,718  0           1/0
2022-03-31  LDMK2O106  PUT   POLAR BANCORP INC     LATE_REVEAL           82,300       69,703          -12,597   12,171,000  1/2
2022-03-31  S72PO7106  SH    HARBOR LOGISTICS INC  AMENDMENT_CORRECTION  73,339       73,339          0         23,587,000  1/1
...
```

In this output:

- `TRADE` is the split-adjusted share change.
- `ROWS` counts the evidence rows behind the previous and current quarter.
- `HOLD` rows are hidden unless you pass `--all`.
- `--naive` prints the CUSIP-keyed diff that ignores amendments, for comparison.
- `--format json` prints the full `Delta` objects, including evidence:

```console
$ node dist/src/cli.js diff ./filings --manager 1237840 --format json
[ ...
  {
    "key": "LDMK2O106|PUT|SH",
    "period": "2022-03-31",
    "label": "LATE_REVEAL",
    "economic": "TRIM",
    "prevShares": 82300,
    "shares": 69703,
    "splitRatio": { "n": 1, "d": 1 },
    "adjustedPrevShares": 82300,
    "shareDelta": -12597,
    "evidence": {
      "cur": [
        {
          "accessionNumber": "0001237840-22-000007",
          "submissionType": "13F-HR/A",
          "amendmentType": "NEW HOLDINGS",
          "acceptanceDateTime": "2022-10-25T15:52:59",
          "confDeniedExpired": true,
          "otherManager": "3",
          "investmentDiscretion": "SOLE",
          "sshPrnamt": 54286,
          "reportedValue": 9479,
          "unitMultiplier": 1000,
          "valueUsd": 9479000
        }, ...
```

(The JSON above is trimmed. Real output also includes the issuer, dollar values, the previous-quarter evidence rows and the notes.)

As a library:

```ts
import { readFilingsDir, normalise, foldFilings, diffPeriods } from "thirteenf-delta";

const filings = (await readFilingsDir("./filings")).filter((f) => f.cik === "0001237840");
const deltas = diffPeriods(foldFilings(normalise(filings)));
```

`parseFiling(string | Iterable<string>)` and `parseFilingStream(AsyncIterable)` parse single documents.

### Input format

Each `.xml` file holds one filing. Fields are matched by local element name wherever they appear, so wrapper elements and namespace prefixes do not matter. A filing needs:

- `accessionNumber`, `cik`, `submissionType` (`13F-HR` or `13F-HR/A`)
- `periodOfReport` (`YYYY-MM-DD` or EDGAR's `MM-DD-YYYY`)
- `acceptanceDateTime` (ISO or EDGAR's `YYYYMMDDHHMMSS`)
- for amendments: `amendmentType`, plus `confDeniedExpired` if it applies
- `infoTable` elements with the standard SEC information-table fields

Run `generate` to see a complete example.

## Results

On 2,000 generated fund histories (seeds 1–2000, 21,056 filings, 108,950 position-quarter deltas):

| Cells | Count | Naive diff | thirteenf-delta |
|---|---:|---:|---:|
| **All CUSIP-period deltas** | 108,950 | 71.3% | 100.0% |

By artefact present in the cell (a cell can carry several):

| Artefact | Cells | Naive diff | thirteenf-delta |
|---|---:|---:|---:|
| clean | 32,739 | 99.6% | 100.0% |
| split | 3,087 | 0.0% | 100.0% |
| split-with-trade | 2,779 | 50.3% | 100.0% |
| multi-row | 44,967 | 71.9% | 100.0% |
| option-and-stock | 35,216 | 45.0% | 100.0% |
| unit-cutover | 8,093 | 46.5% | 100.0% |
| unit-misreport | 8,248 | 54.5% | 100.0% |
| restatement | 3,218 | 20.9% | 100.0% |
| new-holdings | 3,085 | 7.3% | 100.0% |
| confidential-reveal | 3,385 | 4.9% | 100.0% |

By true label:

| True label | Cells | Naive diff | thirteenf-delta |
|---|---:|---:|---:|
| ADD | 23,855 | 89.4% | 100.0% |
| AMENDMENT_CORRECTION | 3,593 | 0.0% | 100.0% |
| EXIT | 6,271 | 62.1% | 100.0% |
| HOLD | 38,095 | 81.4% | 100.0% |
| LATE_REVEAL | 1,538 | 0.0% | 100.0% |
| NEW | 7,550 | 63.5% | 100.0% |
| SPLIT_ONLY | 3,037 | 0.0% | 100.0% |
| TRIM | 19,847 | 84.1% | 100.0% |
| UNIT_ARTEFACT | 5,164 | 0.0% | 100.0% |

The naive diff also reported 400 deltas for position-quarters that do not exist, from stale and phantom rows that a later restatement removed. thirteenf-delta reported none.

### How the numbers were measured

**The generator.** For each history, the generator builds a portfolio of 4–10 stocks, some with a put or call on the same CUSIP, and 0–2 bonds. It then:

- Draws true share paths: entries, exits, adds and trims.
- Moves prices by up to ±3% a quarter, applies splits and reverse splits, and renders each quarter's filings with artefacts injected at random:
  - one position spread over two or three rows with different manager and discretion codes
  - confidential positions revealed 170–200 days late
  - restatements that fix a stale row, a phantom row, a wrong share count or a missing row
  - NEW HOLDINGS amendments
  - the unit cutover, and filers who use the wrong unit
- Records the correct label for every cell from its own bookkeeping. It never calls the classifier to do this.

**The scoring.** Every filing is rendered to XML, parsed back and scored:

- **thirteenf-delta** counts as correct when the label, split ratio and split-adjusted share delta all match.
- **The naive diff** is what most trackers compute: each quarter's original 13F-HR, amendments ignored, rows keyed by CUSIP alone, raw shares compared. It counts as correct when its label matches. It can never produce the four reporting labels, so it scores 0% on those by construction. For those cells, the table in the worked example shows what it reports instead.

**Why "clean" is not 100% for the naive diff.** A cell can be clean itself but share a CUSIP with a sibling position that has an artefact. Keying by CUSIP alone merges the two.

**Hardware.** Rendering, parsing, classifying and scoring all 2,000 histories takes 2.2 s on an Apple M2 with Node 24.12.0.

**What 100% means.** The generator and the classifier follow the same written rules, and the generator stays inside the assumptions described under Limitations. So 100% shows that the rules are implemented consistently and survive rendering, parsing, row splitting, amendment interleaving and unit errors together. It does not measure accuracy on real EDGAR data. The test suite applies the same exact-match check to 3,000 seeds.

## Design notes

**Units follow the filing, not the quarter.** The cutover rule is keyed to the acceptance date, not the period of report. The 13F-HR for 2022-12-31 was filed in February 2023 in dollars. A 2023 amendment to a 2022 quarter is also in dollars, while the original filing it amends was in thousands. A rule keyed to the period of report gets both wrong, and so does a fold that normalises after merging rows. For that reason `normalise()` runs before `foldFilings()`, and each evidence row carries its own `unitMultiplier`.

The misreport check could have compared each filing only with the previous quarter. That fails for a filer who stayed on thousands for two quarters, because the two wrong filings agree with each other. Spreading offsets across the whole graph and taking the majority is barely more code and handles that case. The trade-off is that a manager whose filings are *mostly* in the wrong unit would be "corrected" the wrong way. That seemed far less likely than a short lapse.

**Split inference uses prices only, never share counts.** A share ratio of 1.575 could be a 3:2 split plus a 5% buy, a 2:1 split plus a 21% sale, or no split at all. Only the implied price tells these apart, and only if the market move is small next to the gaps between candidate ratios. The Stern–Brocot search turns "is there a split?" into one question with an exact answer: the simplest fraction consistent with the price, checked against a short list of real split ratios. The cost is a hard tolerance band, described under Limitations.

**Precedence between labels.** Real changes outrank reporting explanations. A RESTATEMENT that removes a row is an `EXIT`, not an `AMENDMENT_CORRECTION`, because the fund really no longer holds the stock. The one exception is `LATE_REVEAL`: that position was invisible to anyone reading the original filing, which is the most important thing to know about it, and the `economic` field still gives the underlying change.

## Limitations

- **Split inference assumes quarterly price moves under 5%** apart from the split itself. The generator uses ±3%. Real stocks often move more:
  - A split with no trade still has share and value evidence, but the price interval may miss the split ratio or contain a simpler one, and the tool then reports a large ADD or TRIM.
  - A real price move of about a third or more with no split (for example a fall to 2/3 or a doubling) can land on a recognised ratio and be reported as a split.
  - Fixing this properly needs outside data: a corporate-actions feed, or the same CUSIP across many filers.
- **Only these split ratios are recognised:** 2, 3, 4, 5, 10, 3/2 and their reciprocals. 5/4 is excluded because 4/3 is simpler and falls inside its tolerance interval.
- **Unit-misreport detection needs overlap.** A filing that shares no common-stock or option CUSIP with any filing from an adjacent quarter keeps the unit its date implies. A misreport in such a filing goes undetected. Positions held only as principal amounts (`PRN`) are never used as price evidence.
- **The input format is one XML file per filing.** On EDGAR, the header and cover page (`primary_doc.xml`) and the information table are separate documents, and the acceptance time is in the submission index. You have to combine them into one file before using this tool. It does not download from EDGAR, and it runs fully offline.
- **Only one manager is folded at a time.** Other-manager codes are summed, not attributed. Multi-manager filings and 13F-NT notices are not handled.
- **CUSIP changes are not followed.** After a merger, spin-off or re-listing, the new CUSIP shows as `EXIT` + `NEW`.
- **`NEW HOLDINGS` rows for a position already in the set are added to it.** That is what the amendment type means. A filer who wrongly repeats a row under NEW HOLDINGS is double-counted.
- **The benchmark is synthetic.** The 100% figure is a consistency result against a generator that shares the tool's assumptions, not accuracy measured on real filings.

## License

MIT. See [LICENSE](LICENSE).
