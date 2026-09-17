import assert from "node:assert/strict";
import { test } from "node:test";
import { FilingParseError, parseFiling } from "../src/parse.js";
import { renderFiling } from "../src/render.js";
import { XmlError, XmlTokenizer } from "../src/xml.js";
import { filing, pos } from "./helpers.js";

function events(chunks: string[]): string[] {
  const out: string[] = [];
  let text = "";
  const flush = () => {
    if (text.trim()) out.push(`text:${text.trim()}`);
    text = "";
  };
  const tok = new XmlTokenizer({
    open: (n, a) => {
      flush();
      out.push(`open:${n}${JSON.stringify(a)}`);
    },
    close: (n) => {
      flush();
      out.push(`close:${n}`);
    },
    text: (t) => {
      text += t;
    },
  });
  for (const c of chunks) tok.write(c);
  tok.end();
  return out;
}

const DOC = `<?xml version="1.0"?>
<!DOCTYPE root>
<!-- a comment with <tags> & ampersands -->
<ns:root xmlns:ns="urn:x" a='1 > 0' b="&quot;q&quot;">
  <ns:name>AT&amp;T &#73;NC &#x26; CO</ns:name>
  <empty/>
  <data><![CDATA[<not a tag> & raw]]></data>
</ns:root>`;

test("tokenizer yields identical events however the input is chunked", () => {
  const whole = events([DOC]);
  assert.deepEqual(whole, [
    'open:root{"ns":"urn:x","a":"1 > 0","b":"\\"q\\""}',
    "open:name{}",
    "text:AT&T INC & CO",
    "close:name",
    "open:empty{}",
    "close:empty",
    "open:data{}",
    "text:<not a tag> & raw",
    "close:data",
    "close:root",
  ]);
  for (let i = 1; i < DOC.length; i++) {
    assert.deepEqual(events([DOC.slice(0, i), DOC.slice(i)]), whole, `split at ${i}`);
  }
  assert.deepEqual(events([...DOC]), whole, "one character per chunk");
});

test("tokenizer rejects malformed documents", () => {
  assert.throws(() => events(["<a><b></a>"]), XmlError);
  assert.throws(() => events(["<a>"]), /unclosed/);
  assert.throws(() => events(["<a>&bogus;</a>"]), /unknown entity/);
  assert.throws(() => events(["<a>AT&T</a>"]), /unterminated entity/);
  assert.throws(() => events(["<a/><b/>"]), /multiple root/);
  assert.throws(() => events(["text<a/>"]), /outside the root/);
  assert.throws(() => events([""]), /no root/);
  assert.throws(() => events(["<a><b</a>"]), XmlError);
  assert.throws(() => events(['<!DOCTYPE a [<!ENTITY x "y">]><a/>']), /internal subset/);
});

test("rendered filings parse back to the same filing", () => {
  const f = filing({
    period: "2023-03-31",
    accepted: "2023-05-10T08:01:02",
    amendment: "NEW HOLDINGS",
    reveal: true,
    rows: [
      pos("037833100", 1000, 150, { otherManager: "2", discretion: "DFND" }),
      pos("037833100", 500, 150, { putCall: "CALL" }),
      { cusip: "912828ZT0", shares: 2_000_000, usd: 1_950_000, type: "PRN" },
    ],
  });
  f.rows[0].nameOfIssuer = 'AT&T <PREFERRED> "A"';
  assert.deepEqual(parseFiling(renderFiling(f)), f);
});

test("parser accepts EDGAR date formats and rejects bad fields", () => {
  const base = renderFiling(
    filing({
      period: "2022-12-31",
      accepted: "2023-02-01T10:00:00",
      rows: [pos("037833100", 10, 100)],
    }),
  );
  const edgar = base
    .replace("<periodOfReport>2022-12-31", "<periodOfReport>12-31-2022")
    .replace("2023-02-01T10:00:00", "20230201100000");
  const parsed = parseFiling(edgar);
  assert.equal(parsed.periodOfReport, "2022-12-31");
  assert.equal(parsed.acceptanceDateTime, "2023-02-01T10:00:00");

  assert.throws(
    () => parseFiling(base.replace(">037833100</ns1:cusip>", ">BAD</ns1:cusip>")),
    FilingParseError,
  );
  assert.throws(
    () => parseFiling(base.replace(">1000</ns1:value>", ">1e3</ns1:value>")),
    /invalid <value>/,
  );
  assert.throws(() => parseFiling(base.replace(">SH<", ">XX<")), /sshPrnamtType/);
  assert.throws(() => parseFiling(base.replace(/<cik>.*<\/cik>/, "")), /missing <cik>/);
  assert.throws(() => parseFiling(base.replace(">13F-HR<", ">13F-NT<")), /submissionType/);
});
