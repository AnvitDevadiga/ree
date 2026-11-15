/**
 * Adversarial prompt and metadata sanitizer.
 *
 * Defenses aimed at LLM analyzers plant instructions where an agent will read
 * them verbatim: comments, docstrings, string tables, source-map references.
 * This pass makes sure none of that reaches a model as if it were an instruction:
 *
 *  - comments that match injection signatures are replaced (comments never affect
 *    behavior, so this is lossless for reconstruction);
 *  - string *literals* that match are left intact (removing them would change
 *    program behavior) but flagged, and the slicer labels them as program data;
 *  - matching entries are dropped from the global string table;
 *  - source-map references are flagged as possible decoys;
 *  - XOR/keystream string decoders are flagged so literals aren't taken at face value.
 *
 * The comment scanner tracks string, template, and regex literals, so a `//`
 * inside a URL is never mistaken for a comment.
 */
import type { AntiBlaFinding, ExtractedString } from "../core/types.js";

const INJECTION_SIGNATURES: RegExp[] = [
  /\bignore\s+(all\s+|any\s+|the\s+)?(previous|above|prior|earlier)\s+(instructions|context|rules)\b/i,
  /\bdisregard\s+(your|the|all)\s+(system\s+)?(prompt|instructions|rules)\b/i,
  /\byou\s+are\s+now\s+(an?\s+)?\w+/i,
  /(^|\n)\s*(system|assistant|developer)\s*:/i,
  /<\/?\s*(system|instructions?|tool_call|function_call|im_start|im_end)\b[^>]*>/i,
  /\b(print|reveal|output)\s+(your|the)\s+(system\s+)?prompt\b/i,
  /\b(stop|halt|end)\s+(the\s+)?(analysis|reconstruction|reverse[- ]engineering)\b/i,
  /\b(analysis|reconstruction)\s+(is\s+)?(complete|finished|done)\b/i,
  /\bthis\s+(file|module|function|code)\s+(is\s+)?(empty|irrelevant|not\s+relevant|safe\s+to\s+skip|auto-?generated)\b/i,
  /\b(note|attention|important)\s+(to|for)\s+(the\s+)?(ai|llm|model|agent|assistant)\b/i,
  /\b(send|post|upload|exfiltrate)\b.{0,60}\bhttps?:\/\//i,
];

const SOURCEMAP_REF = /[#@]\s*sourceMappingURL\s*=\s*\S+/;

export function looksInjected(text: string): boolean {
  return INJECTION_SIGNATURES.some((re) => re.test(text));
}

interface Span {
  start: number;
  end: number;
  kind: "comment" | "string";
}

/** Locate comments and string literals in JS-like source. */
export function scanJs(src: string): Span[] {
  const spans: Span[] = [];
  let i = 0;
  let lastSignificant = "";
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      spans.push({ start: i, end: stop, kind: "comment" });
      i = stop;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      spans.push({ start: i, end: stop, kind: "comment" });
      i = stop;
      continue;
    }
    if (c === "<" && src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      const stop = end === -1 ? n : end + 3;
      spans.push({ start: i, end: stop, kind: "comment" });
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === "\\") j++;
        else if (c !== "`" && src[j] === "\n") break;
        j++;
      }
      spans.push({ start: i, end: Math.min(j + 1, n), kind: "string" });
      i = j + 1;
      lastSignificant = c;
      continue;
    }
    if (c === "/" && (lastSignificant === "" || "(,=:[!&|?{};+-*%<>~^".includes(lastSignificant))) {
      // regex literal
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== "\n") {
        const d = src[j];
        if (d === "\\") j++;
        else if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) break;
        j++;
      }
      i = j + 1;
      lastSignificant = "/";
      continue;
    }
    if (!/\s/.test(c)) lastSignificant = /[\w$)\]]/.test(c) ? "a" : c;
    i++;
  }
  return spans;
}

export interface SanitizeResult {
  findings: AntiBlaFinding[];
  body: string;
  flaggedLiterals: number;
}

export function sanitizeBody(unitId: string, name: string, body: string): SanitizeResult {
  const findings: AntiBlaFinding[] = [];
  const spans = scanJs(body);
  let out = "";
  let cursor = 0;
  let removed = 0;
  let flaggedLiterals = 0;

  for (const s of spans) {
    const text = body.slice(s.start, s.end);
    if (s.kind === "comment" && (looksInjected(text) || SOURCEMAP_REF.test(text))) {
      out += body.slice(cursor, s.start) + (text.startsWith("<!--") ? "<!-- [ree: removed] -->" : "/* [ree: removed] */");
      cursor = s.end;
      removed++;
      findings.push({
        pass: "sanitizer",
        severity: SOURCEMAP_REF.test(text) && !looksInjected(text) ? "suspicious" : "malicious",
        action: "sanitized",
        unitId,
        message: SOURCEMAP_REF.test(text) && !looksInjected(text)
          ? `removed source-map reference from "${name}" (source maps may point to decoy sources)`
          : `removed an instruction-like comment from "${name}"`,
        evidence: { sample: text.slice(0, 100) },
      });
    } else if (s.kind === "string" && looksInjected(text)) {
      flaggedLiterals++;
    }
  }
  out += body.slice(cursor);

  if (flaggedLiterals) {
    findings.push({
      pass: "sanitizer",
      severity: "suspicious",
      action: "flagged",
      unitId,
      message: `"${name}" has ${flaggedLiterals} string literal(s) that read like instructions to an AI; kept as program data`,
    });
  }
  return { findings, body: removed ? out : body, flaggedLiterals };
}

export function sanitizeStrings(strings: ExtractedString[]): { findings: AntiBlaFinding[]; strings: ExtractedString[] } {
  const findings: AntiBlaFinding[] = [];
  const kept: ExtractedString[] = [];
  let dropped = 0;
  for (const s of strings) {
    if (looksInjected(s.value)) {
      dropped++;
      continue;
    }
    kept.push(s);
  }
  if (dropped) {
    findings.push({
      pass: "sanitizer",
      severity: "malicious",
      action: "sanitized",
      message: `dropped ${dropped} instruction-like entr${dropped === 1 ? "y" : "ies"} from the string table`,
    });
  }
  return { findings, strings: kept };
}

export function detectStringDecoder(unitId: string, name: string, body: string): AntiBlaFinding[] {
  const xor = /charCodeAt\([^)]*\)\s*\^|\^\s*\w+\.charCodeAt\(|fromCharCode\([^)]*\^/;
  if (xor.test(body) && /\bfor\s*\(|\.map\(|\.reduce\(|while\s*\(/.test(body)) {
    return [{
      pass: "sanitizer",
      severity: "suspicious",
      action: "flagged",
      unitId,
      message: `"${name}" contains an XOR/keystream string decoder; literal strings are encrypted at rest`,
    }];
  }
  return [];
}
