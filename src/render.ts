import type { Filing } from "./types.js";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Renders a filing as one XML document: EDGAR header and cover-page fields followed by an
 * information table using the SEC element names and namespace.
 */
export function renderFiling(f: Filing): string {
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push(
    '<thirteenFFiling xmlns:ns1="http://www.sec.gov/edgar/document/thirteenf/informationtable">',
  );
  out.push("  <headerData>");
  out.push(`    <accessionNumber>${esc(f.accessionNumber)}</accessionNumber>`);
  out.push(`    <cik>${esc(f.cik)}</cik>`);
  out.push(`    <submissionType>${f.submissionType}</submissionType>`);
  out.push(`    <periodOfReport>${f.periodOfReport}</periodOfReport>`);
  out.push(`    <acceptanceDateTime>${f.acceptanceDateTime}</acceptanceDateTime>`);
  out.push("  </headerData>");
  out.push("  <coverPage>");
  out.push(`    <isAmendment>${f.submissionType === "13F-HR/A"}</isAmendment>`);
  if (f.amendmentType) {
    out.push("    <amendmentInfo>");
    out.push(`      <amendmentType>${esc(f.amendmentType)}</amendmentType>`);
    if (f.confDeniedExpired) out.push("      <confDeniedExpired>true</confDeniedExpired>");
    out.push("    </amendmentInfo>");
  }
  out.push("  </coverPage>");
  out.push("  <ns1:informationTable>");
  for (const r of f.rows) {
    out.push("    <ns1:infoTable>");
    out.push(`      <ns1:nameOfIssuer>${esc(r.nameOfIssuer)}</ns1:nameOfIssuer>`);
    out.push(`      <ns1:titleOfClass>${esc(r.titleOfClass)}</ns1:titleOfClass>`);
    out.push(`      <ns1:cusip>${r.cusip}</ns1:cusip>`);
    out.push(`      <ns1:value>${r.value}</ns1:value>`);
    out.push("      <ns1:shrsOrPrnAmt>");
    out.push(`        <ns1:sshPrnamt>${r.sshPrnamt}</ns1:sshPrnamt>`);
    out.push(`        <ns1:sshPrnamtType>${r.sshPrnamtType}</ns1:sshPrnamtType>`);
    out.push("      </ns1:shrsOrPrnAmt>");
    if (r.putCall) {
      out.push(`      <ns1:putCall>${r.putCall === "PUT" ? "Put" : "Call"}</ns1:putCall>`);
    }
    out.push(
      `      <ns1:investmentDiscretion>${esc(r.investmentDiscretion)}</ns1:investmentDiscretion>`,
    );
    if (r.otherManager)
      out.push(`      <ns1:otherManager>${esc(r.otherManager)}</ns1:otherManager>`);
    out.push("      <ns1:votingAuthority>");
    out.push(`        <ns1:Sole>${r.sshPrnamt}</ns1:Sole>`);
    out.push("        <ns1:Shared>0</ns1:Shared>");
    out.push("        <ns1:None>0</ns1:None>");
    out.push("      </ns1:votingAuthority>");
    out.push("    </ns1:infoTable>");
  }
  out.push("  </ns1:informationTable>");
  out.push("</thirteenFFiling>");
  return `${out.join("\n")}\n`;
}
