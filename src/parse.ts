import type {
  AmendmentType,
  Filing,
  InfoRow,
  PutCall,
  SshPrnamtType,
  SubmissionType,
} from "./types.js";
import { XmlTokenizer } from "./xml.js";

export class FilingParseError extends Error {}

const HEADER_FIELDS = new Set([
  "accessionNumber",
  "cik",
  "submissionType",
  "periodOfReport",
  "acceptanceDateTime",
  "amendmentType",
  "confDeniedExpired",
]);

const ROW_FIELDS = new Set([
  "nameOfIssuer",
  "titleOfClass",
  "cusip",
  "value",
  "sshPrnamt",
  "sshPrnamtType",
  "putCall",
  "investmentDiscretion",
  "otherManager",
]);

/**
 * Builds a Filing from tokenizer events. Fields are matched by local element name
 * wherever they appear, so namespace prefixes and wrapper elements do not matter.
 */
class FilingBuilder {
  private readonly header = new Map<string, string>();
  private readonly rows: Map<string, string>[] = [];
  private row: Map<string, string> | null = null;
  private field: string | null = null;
  private text = "";

  open(name: string): void {
    if (name === "infoTable") {
      if (this.row) throw new FilingParseError("nested <infoTable>");
      this.row = new Map();
      return;
    }
    if ((this.row && ROW_FIELDS.has(name)) || (!this.row && HEADER_FIELDS.has(name))) {
      this.field = name;
      this.text = "";
    }
  }

  close(name: string): void {
    if (name === "infoTable" && this.row) {
      this.rows.push(this.row);
      this.row = null;
      return;
    }
    if (this.field === name) {
      (this.row ?? this.header).set(name, this.text.trim());
      this.field = null;
    }
  }

  textChunk(t: string): void {
    if (this.field) this.text += t;
  }

  build(): Filing {
    const need = (k: string): string => {
      const v = this.header.get(k);
      if (!v) throw new FilingParseError(`missing <${k}>`);
      return v;
    };
    const submissionType = need("submissionType");
    if (submissionType !== "13F-HR" && submissionType !== "13F-HR/A") {
      throw new FilingParseError(`unsupported submissionType '${submissionType}'`);
    }
    let amendmentType: AmendmentType | null = null;
    if (submissionType === "13F-HR/A") {
      const raw = (this.header.get("amendmentType") ?? "RESTATEMENT").toUpperCase();
      if (raw !== "RESTATEMENT" && raw !== "NEW HOLDINGS") {
        throw new FilingParseError(`unsupported amendmentType '${raw}'`);
      }
      amendmentType = raw;
    }
    return {
      accessionNumber: need("accessionNumber"),
      cik: need("cik").padStart(10, "0"),
      submissionType: submissionType as SubmissionType,
      periodOfReport: parseDate(need("periodOfReport")),
      acceptanceDateTime: parseDateTime(need("acceptanceDateTime")),
      amendmentType,
      confDeniedExpired: (this.header.get("confDeniedExpired") ?? "").toLowerCase() === "true",
      rows: this.rows.map((r, i) => buildRow(r, i)),
    };
  }
}

function buildRow(r: Map<string, string>, index: number): InfoRow {
  const where = `infoTable #${index + 1}`;
  const cusip = (r.get("cusip") ?? "").toUpperCase();
  if (!/^[0-9A-Z*@#]{9}$/.test(cusip)) {
    throw new FilingParseError(`${where}: invalid CUSIP '${cusip}'`);
  }
  const num = (k: string): number => {
    const raw = (r.get(k) ?? "").replace(/,/g, "");
    if (!/^\d+(\.\d+)?$/.test(raw)) throw new FilingParseError(`${where}: invalid <${k}> '${raw}'`);
    return Number(raw);
  };
  const type = (r.get("sshPrnamtType") ?? "").toUpperCase();
  if (type !== "SH" && type !== "PRN") {
    throw new FilingParseError(`${where}: invalid <sshPrnamtType> '${type}'`);
  }
  const pc = (r.get("putCall") ?? "").toUpperCase();
  let putCall: PutCall = null;
  if (pc === "PUT" || pc === "CALL") putCall = pc;
  else if (pc !== "") throw new FilingParseError(`${where}: invalid <putCall> '${pc}'`);
  return {
    nameOfIssuer: r.get("nameOfIssuer") ?? "",
    titleOfClass: r.get("titleOfClass") ?? "",
    cusip,
    value: num("value"),
    sshPrnamt: num("sshPrnamt"),
    sshPrnamtType: type as SshPrnamtType,
    putCall,
    investmentDiscretion: (r.get("investmentDiscretion") ?? "SOLE").toUpperCase(),
    otherManager: r.get("otherManager") ?? "",
  };
}

/** Accepts ISO `YYYY-MM-DD` and EDGAR's `MM-DD-YYYY`. */
function parseDate(raw: string): string {
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (m) return raw;
  m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(raw);
  if (m) return `${m[3]}-${m[1]}-${m[2]}`;
  throw new FilingParseError(`invalid date '${raw}'`);
}

/** Accepts ISO date-times and EDGAR's compact `YYYYMMDDHHMMSS`. */
function parseDateTime(raw: string): string {
  const iso = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})$/.exec(raw);
  if (iso) return `${iso[1]}T${iso[2]}`;
  const compact = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(raw);
  if (compact) {
    const [, y, mo, d, h, mi, s] = compact;
    return `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  }
  throw new FilingParseError(`invalid acceptanceDateTime '${raw}'`);
}

function builderTokenizer(): [FilingBuilder, XmlTokenizer] {
  const b = new FilingBuilder();
  const tok = new XmlTokenizer({
    open: (name) => b.open(name),
    close: (name) => b.close(name),
    text: (t) => b.textChunk(t),
  });
  return [b, tok];
}

/** Parses a filing document given as a string or as a sequence of string chunks. */
export function parseFiling(input: string | Iterable<string>): Filing {
  const [b, tok] = builderTokenizer();
  if (typeof input === "string") tok.write(input);
  else for (const chunk of input) tok.write(chunk);
  tok.end();
  return b.build();
}

/** Parses a filing from an async chunk source such as `fs.createReadStream(path, "utf8")`. */
export async function parseFilingStream(input: AsyncIterable<string | Buffer>): Promise<Filing> {
  const [b, tok] = builderTokenizer();
  const decoder = new TextDecoder("utf-8");
  for await (const chunk of input) {
    tok.write(typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }));
  }
  tok.write(decoder.decode());
  tok.end();
  return b.build();
}
