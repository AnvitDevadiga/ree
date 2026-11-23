/**
 * Bounded property-list reader (Info.plist in .ipa / .app bundles).
 *
 * Handles Apple's binary format (`bplist00`) and the XML format. Object
 * count, nesting depth, collection sizes and string lengths are capped; the
 * reader never follows a reference twice in one path, so cyclic object tables
 * cannot loop.
 */
export type PlistValue = string | number | boolean | null | PlistValue[] | { [k: string]: PlistValue };

export class PlistError extends Error {}

const MAX_OBJECTS = 200_000;
const MAX_DEPTH = 32;
const MAX_ITEMS = 10_000;
const MAX_STRING = 64 * 1024;

export function parsePlist(b: Uint8Array): PlistValue {
  const head = String.fromCharCode(...b.subarray(0, 8));
  if (head === "bplist00") return parseBinary(b);
  const text = new TextDecoder().decode(b);
  if (/<plist[\s>]/.test(text)) return parseXml(text);
  throw new PlistError("not a property list");
}

function parseBinary(b: Uint8Array): PlistValue {
  if (b.length < 40) throw new PlistError("binary plist too short");
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const t = b.length - 32;
  const offSize = b[t + 6]!;
  const refSize = b[t + 7]!;
  const numObjects = Number(dv.getBigUint64(t + 8));
  const top = Number(dv.getBigUint64(t + 16));
  const offTable = Number(dv.getBigUint64(t + 24));
  if (numObjects > MAX_OBJECTS || offTable + numObjects * offSize > t || offSize < 1 || offSize > 8 || refSize < 1 || refSize > 8) {
    throw new PlistError("binary plist trailer is inconsistent");
  }
  const uint = (o: number, n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + b[o + i]!;
    return v;
  };
  const offsetOf = (ref: number) => {
    if (ref >= numObjects) throw new PlistError("object reference out of range");
    const o = uint(offTable + ref * offSize, offSize);
    if (o >= t) throw new PlistError("object offset out of range");
    return o;
  };
  const read = (ref: number, depth: number, path: Set<number>): PlistValue => {
    if (depth > MAX_DEPTH) throw new PlistError("plist nesting too deep");
    if (path.has(ref)) throw new PlistError("cyclic plist object reference");
    const o = offsetOf(ref);
    const marker = b[o]!;
    const hi = marker >> 4;
    const lo = marker & 0xf;
    const count = (): { n: number; start: number } => {
      if (lo !== 0xf) return { n: lo, start: o + 1 };
      const intMarker = b[o + 1]!;
      const width = 1 << (intMarker & 0xf);
      return { n: uint(o + 2, width), start: o + 2 + width };
    };
    switch (hi) {
      case 0x0:
        return marker === 0x08 ? false : marker === 0x09 ? true : null;
      case 0x1:
        return uint(o + 1, 1 << lo);
      case 0x2:
        return lo === 2 ? dv.getFloat32(o + 1) : dv.getFloat64(o + 1);
      case 0x3:
        return dv.getFloat64(o + 1); // seconds since 2001-01-01
      case 0x4: {
        const { n } = count();
        return `<${n} bytes of data>`;
      }
      case 0x5: {
        const { n, start } = count();
        return String.fromCharCode(...b.subarray(start, start + Math.min(n, MAX_STRING)));
      }
      case 0x6: {
        const { n, start } = count();
        let s = "";
        for (let i = 0; i < Math.min(n, MAX_STRING); i++) s += String.fromCharCode(dv.getUint16(start + i * 2));
        return s;
      }
      case 0xa: {
        const { n, start } = count();
        if (n > MAX_ITEMS) throw new PlistError("plist array too large");
        const next = new Set(path).add(ref);
        return Array.from({ length: n }, (_, i) => read(uint(start + i * refSize, refSize), depth + 1, next));
      }
      case 0xd: {
        const { n, start } = count();
        if (n > MAX_ITEMS) throw new PlistError("plist dict too large");
        const next = new Set(path).add(ref);
        const out: Record<string, PlistValue> = {};
        for (let i = 0; i < n; i++) {
          const k = read(uint(start + i * refSize, refSize), depth + 1, next);
          const v = read(uint(start + (n + i) * refSize, refSize), depth + 1, next);
          if (typeof k === "string") out[k] = v;
        }
        return out;
      }
      default:
        return null;
    }
  };
  return read(top, 0, new Set());
}

/** Minimal XML plist reader: dict/array/string/integer/real/true/false/data/date. */
function parseXml(text: string): PlistValue {
  const tokens = text.replace(/<!--[\s\S]*?-->/g, "").match(/<[^>]*>|[^<]+/g) ?? [];
  const isOpen = (tok: string | undefined) => !!tok && /^<[a-zA-Z]/.test(tok);
  const nameOf = (tok: string) => /^<\/?([a-zA-Z]+)/.exec(tok)?.[1] ?? "";
  let i = 0;
  const unescape = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  const textUntil = (close: string) => {
    let s = "";
    while (i < tokens.length && tokens[i] !== close) s += tokens[i++];
    i++;
    return unescape(s).slice(0, MAX_STRING);
  };
  const value = (depth: number): PlistValue => {
    if (depth > MAX_DEPTH) throw new PlistError("plist nesting too deep");
    while (i < tokens.length && !isOpen(tokens[i])) i++;
    const tag = nameOf(tokens[i++] ?? "");
    if (tag === "dict") {
      const out: Record<string, PlistValue> = {};
      let n = 0;
      while (i < tokens.length && tokens[i] !== "</dict>" && n++ < MAX_ITEMS) {
        if (tokens[i] === "<key>") {
          i++;
          const k = textUntil("</key>");
          out[k] = value(depth + 1);
        } else i++;
      }
      i++;
      return out;
    }
    if (tag === "array") {
      const out: PlistValue[] = [];
      while (i < tokens.length && tokens[i] !== "</array>" && out.length < MAX_ITEMS) {
        if (isOpen(tokens[i])) out.push(value(depth + 1));
        else i++;
      }
      i++;
      return out;
    }
    if (tag === "true" || tag === "false") return tag === "true";
    if (tag === "string") return textUntil("</string>");
    if (tag === "integer" || tag === "real") return Number(textUntil(`</${tag}>`));
    if (tag === "data" || tag === "date") return textUntil(`</${tag}>`).trim();
    return null;
  };
  while (i < tokens.length && nameOf(tokens[i]!) !== "plist") i++;
  i++;
  return value(0);
}
