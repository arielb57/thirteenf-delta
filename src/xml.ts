/**
 * A zero-dependency streaming XML tokenizer for the subset 13F documents use:
 * elements, attributes, text, the five named entities plus numeric references,
 * comments, CDATA, processing instructions and a DOCTYPE without an internal subset.
 * Chunks may split anywhere, including inside a tag or an entity.
 */

export interface XmlHandler {
  open(name: string, attrs: Record<string, string>): void;
  close(name: string): void;
  text(text: string): void;
}

export class XmlError extends Error {}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

export function decodeEntities(raw: string): string {
  if (!raw.includes("&")) return raw;
  return raw.replace(/&([^;&\s]*);?/g, (match, body: string) => {
    if (!match.endsWith(";")) throw new XmlError(`unterminated entity reference '${match}'`);
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      if (Number.isNaN(code)) throw new XmlError(`bad character reference '${match}'`);
      return String.fromCodePoint(code);
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      if (Number.isNaN(code)) throw new XmlError(`bad character reference '${match}'`);
      return String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[body];
    if (named === undefined) throw new XmlError(`unknown entity '${match}'`);
    return named;
  });
}

/** Strips a namespace prefix: `ns1:infoTable` becomes `infoTable`. */
function localName(qname: string): string {
  const colon = qname.indexOf(":");
  return colon === -1 ? qname : qname.slice(colon + 1);
}

const TAG_RE = /^([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)$/;
const ATTR_RE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

export class XmlTokenizer {
  private buf = "";
  private readonly stack: string[] = [];
  private sawRoot = false;

  constructor(private readonly handler: XmlHandler) {}

  write(chunk: string): void {
    this.buf += chunk;
    this.drain();
  }

  end(): void {
    this.drain();
    if (this.buf.trim().length > 0) {
      throw new XmlError(`unexpected end of document near '${this.buf.slice(0, 40)}'`);
    }
    if (this.stack.length > 0) {
      throw new XmlError(`unclosed element <${this.stack[this.stack.length - 1]}>`);
    }
    if (!this.sawRoot) throw new XmlError("document has no root element");
  }

  private drain(): void {
    let pos = 0;
    const buf = this.buf;
    while (pos < buf.length) {
      const lt = buf.indexOf("<", pos);
      if (lt === -1) {
        // Text may still be followed by more text or an entity split across chunks.
        break;
      }
      if (lt > pos) {
        this.emitText(buf.slice(pos, lt));
        pos = lt;
      }
      const consumed = this.readMarkup(buf, lt);
      if (consumed === -1) break;
      pos = consumed;
    }
    this.buf = buf.slice(pos);
  }

  private emitText(raw: string): void {
    if (this.stack.length === 0) {
      if (raw.trim().length > 0) throw new XmlError("text outside the root element");
      return;
    }
    this.handler.text(decodeEntities(raw));
  }

  /** Returns the index after the markup at `lt`, or -1 if the buffer ends first. */
  private readMarkup(buf: string, lt: number): number {
    if (buf.startsWith("<!--", lt)) {
      const endIdx = buf.indexOf("-->", lt + 4);
      return endIdx === -1 ? -1 : endIdx + 3;
    }
    if (buf.startsWith("<![CDATA[", lt)) {
      const endIdx = buf.indexOf("]]>", lt + 9);
      if (endIdx === -1) return -1;
      if (this.stack.length === 0) throw new XmlError("CDATA outside the root element");
      this.handler.text(buf.slice(lt + 9, endIdx));
      return endIdx + 3;
    }
    if (buf.startsWith("<?", lt)) {
      const endIdx = buf.indexOf("?>", lt + 2);
      return endIdx === -1 ? -1 : endIdx + 2;
    }
    if (buf.startsWith("<!", lt)) {
      if (buf.length - lt < 9) return -1;
      if (!buf.startsWith("<!DOCTYPE", lt)) throw new XmlError("unsupported markup declaration");
      const endIdx = buf.indexOf(">", lt);
      if (endIdx === -1) return -1;
      if (buf.slice(lt, endIdx).includes("[")) {
        throw new XmlError("DOCTYPE internal subsets are not supported");
      }
      return endIdx + 1;
    }
    const gt = findTagEnd(buf, lt + 1);
    if (gt === -1) return -1;
    const inner = buf.slice(lt + 1, gt);
    if (inner.startsWith("/")) {
      const name = localName(inner.slice(1).trim());
      const open = this.stack.pop();
      if (open !== name) {
        throw new XmlError(`mismatched closing tag </${name}>, expected </${open ?? "nothing"}>`);
      }
      this.handler.close(name);
      return gt + 1;
    }
    const m = TAG_RE.exec(inner);
    if (!m) throw new XmlError(`malformed tag <${inner}>`);
    if (this.stack.length === 0 && this.sawRoot) throw new XmlError("multiple root elements");
    const name = localName(m[1]);
    const attrs: Record<string, string> = {};
    for (const a of m[2].matchAll(ATTR_RE)) {
      attrs[localName(a[1])] = decodeEntities(a[2] ?? a[3] ?? "");
    }
    this.sawRoot = true;
    this.handler.open(name, attrs);
    if (m[3] === "/") {
      this.handler.close(name);
    } else {
      this.stack.push(name);
    }
    return gt + 1;
  }
}

/** Finds the `>` ending a tag, skipping any `>` inside quoted attribute values. */
function findTagEnd(buf: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < buf.length; i++) {
    const c = buf[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return i;
    } else if (c === "<") {
      throw new XmlError("'<' inside a tag");
    }
  }
  return -1;
}
