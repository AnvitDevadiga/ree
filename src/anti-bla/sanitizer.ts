/**
 * Adversarial prompt and metadata sanitizer.
 *
 * Defenses aimed at LLM analyzers plant instructions where an agent will read
 * them verbatim: comments, docstrings, string tables, source-map references, and
 * — in real `bla-agents` output — large **string-literal arrays** of fake
 * safety/ChatML/turn-boundary payloads embedded inside otherwise-real source and
 * JSON files. This pass makes sure none of that reaches a model as instructions:
 *
 *  - comments that match injection signatures are replaced (comments never affect
 *    behavior, so this is lossless for reconstruction);
 *  - the matched injection span inside any **string literal or data payload** is
 *    redacted to a placeholder, keeping the surrounding program/JSON structure so
 *    reconstruction still sees the shape, but the hostile text never reaches the
 *    model (REE never rewrites or executes the target — this only changes the
 *    context slice an analyzer reads);
 *  - matching entries are dropped from the global string table;
 *  - source-map references are flagged as possible decoys;
 *  - XOR/keystream string decoders are flagged so literals aren't taken at face value.
 *
 * The comment scanner tracks string, template, and regex literals, so a `//`
 * inside a URL is never mistaken for a comment. Redaction is whole-body (not span
 * classified) so a payload survives no matter how the surrounding bytes parse.
 */
import type { AntiBlaFinding, ExtractedString } from "../core/types.js";

const INJECTION_SIGNATURES: RegExp[] = [
  /\bignore\s+(all\s+|any\s+|the\s+)?(previous|above|prior|earlier)\s+(instructions|context|rules)\b/i,
  /\bdisregard\s+(your|the|all)\s+(system\s+)?(prompt|instructions|rules)\b/i,
  /\byou\s+are\s+now\s+(an?\s+)?\w+/i,
  // Turn-boundary roles, accepting a real newline OR the literal escape `\n`
  // (BLA embeds `\n\nHuman:` inside JSON string literals, which models still read
  // as a turn break).
  /(^|\n|\\n)\s*(system|assistant|developer|human|user)\s*:/i,
  /<\/?\s*(system|instructions?|tool_call|function_call|im_start|im_end)\b[^>]*>/i,
  /\b(print|reveal|output)\s+(your|the)\s+(system\s+)?prompt\b/i,
  /\b(stop|halt|end)\s+(the\s+)?(analysis|reconstruction|reverse[- ]engineering)\b/i,
  /\b(analysis|reconstruction)\s+(is\s+)?(complete|finished|done)\b/i,
  /\bthis\s+(file|module|function|code)\s+(is\s+)?(empty|irrelevant|not\s+relevant|safe\s+to\s+skip|auto-?generated)\b/i,
  /\b(note|attention|important)\s+(to|for)\s+(the\s+)?(ai|llm|model|agent|assistant)\b/i,
  /\b(send|post|upload|exfiltrate)\b.{0,60}\bhttps?:\/\//i,
  // ChatML / special-token turn frames (incl. the `<|im_start|>` pipe form BLA uses).
  /<\|?\s*(im_start|im_end|endoftext|eot_id|start_header_id|end_header_id)\s*\|?>/i,
  /\|\s*(im_start|im_end|endoftext)\s*\|/i,
  // Fake moderation / "safety classifier" interventions and alignment canaries.
  /\bALIGNMENT[-_\s]?EVAL[-_\s]?CANARY\b/i,
  /\bcanary\s+[0-9a-f]{8}-[0-9a-f]{4}/i,
  /\b(safety\s+classifier|critical\s+safety|constitutional\s+stop|system\s+safety\s+override|policy[_\s]violation)\b/i,
  // Refusal scripts that try to make the analyzer abort or decline.
  /\b(abort|terminate)\s+(all\s+)?(tool\s+calls?|code\s+generation|further\s+assistance)\b/i,
  /\bI\s+cannot\s+(assist|help)\s+with\b/i,
  /\brefuse\s+(further\s+)?(assistance|requests?|to\s+\w+)/i,
];

const SOURCEMAP_REF = /[#@]\s*sourceMappingURL\s*=\s*\S+/;

const REDACTION = "[ree:redacted-injection]";

export function looksInjected(text: string): boolean {
  return INJECTION_SIGNATURES.some((re) => re.test(text));
}

/**
 * Replace every injection-signature match anywhere in `text` with a neutral
 * placeholder. Applied to whole unit bodies so a payload is removed no matter
 * whether it sits in a comment, a string literal, or raw JSON/data — closing the
 * leak where BLA embeds attacks as string-literal arrays rather than comments.
 */
export function redactInjections(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const re of INJECTION_SIGNATURES) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    out = out.replace(g, () => {
      count++;
      return REDACTION;
    });
  }
  return { text: out, count };
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
  /** Count of injection payloads redacted from string literals / data (not comments). */
  redactedInjections: number;
}

/**
 * Make string literals readable and un-splittable before matching:
 *  - decode \xNN, \uNNNN and \u{…} escapes of printable characters (obfuscators
 *    write spaces as \x20, which a model reads fine but a regex does not);
 *  - fold adjacent literal concatenations ("SYSTEM: ig" + "nore …") into one.
 * Quotes, backslashes, `$`/backtick in templates, control characters and line
 * terminators stay escaped, so the code remains valid. This only changes what an
 * analyzer reads; REE never rewrites the target.
 */
export function normalizeLiterals(body: string): { text: string; decoded: number; folded: number } {
  let decoded = 0;
  const decode = (lit: string): string => {
    const q = lit[0]!;
    const inner = lit.slice(1, -1).replace(/\\(?:x([0-9a-fA-F]{2})|u([0-9a-fA-F]{4})|u\{([0-9a-fA-F]{1,6})\})/g, (m, x, u, cp) => {
      const code = parseInt(x ?? u ?? cp, 16);
      const printable = (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code !== 0x2028 && code !== 0x2029 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff));
      const ch = String.fromCodePoint(code);
      if (!printable || ch === q || ch === "\\" || (q === "`" && (ch === "$" || ch === "`"))) return m;
      decoded++;
      return ch;
    });
    return q + inner + q;
  };
  // Pass A: decode escapes inside every string literal.
  let out = "";
  let cursor = 0;
  for (const s of scanJs(body)) {
    if (s.kind !== "string") continue;
    const lit = body.slice(s.start, s.end);
    if (lit.length < 2 || lit[0] !== lit[lit.length - 1]) continue;
    out += body.slice(cursor, s.start) + decode(lit);
    cursor = s.end;
  }
  out += body.slice(cursor);
  // Pass B: fold "a" + "b" (plain quotes only, no templates) until stable.
  let folded = 0;
  for (let round = 0; round < 8; round++) {
    let changed = false;
    const spans = scanJs(out).filter((s) => s.kind === "string");
    let next = "";
    let pos = 0;
    for (let i = 0; i + 1 < spans.length; i++) {
      const a = spans[i]!;
      const b = spans[i + 1]!;
      if (a.start < pos) continue;
      const between = out.slice(a.end, b.start);
      const la = out.slice(a.start, a.end);
      const lb = out.slice(b.start, b.end);
      if (!/^\s*\+\s*$/.test(between) || la[0] === "`" || lb[0] === "`") continue;
      const q = la[0]!;
      const innerB = lb.slice(1, -1).replace(/\\(['"])/g, "$1").replace(new RegExp(q, "g"), `\\${q}`);
      next += out.slice(pos, a.start) + la.slice(0, -1) + innerB + q;
      pos = b.end;
      folded++;
      changed = true;
      i++;
    }
    out = next + out.slice(pos);
    if (!changed) break;
  }
  return { text: out, decoded, folded };
}

export function sanitizeBody(unitId: string, name: string, rawBody: string): SanitizeResult {
  const findings: AntiBlaFinding[] = [];
  // Pass 0: decode escaped / split literals so an obfuscated instruction cannot
  // slip past the signatures below (e.g. "SYSTEM:\x20ignore\x20previous…").
  const norm = normalizeLiterals(rawBody);
  const body = norm.text;
  if (norm.decoded || norm.folded) {
    findings.push({
      pass: "sanitizer",
      severity: "info",
      action: "flagged",
      unitId,
      message: `normalized string literals in "${name}" for reading: ${norm.decoded} escape(s) decoded, ${norm.folded} split string(s) joined`,
    });
  }
  const spans = scanJs(body);
  let out = "";
  let cursor = 0;
  let removedComments = 0;

  // Pass 1: drop instruction-like comments and source-map refs wholesale.
  for (const s of spans) {
    if (s.kind !== "comment") continue;
    const text = body.slice(s.start, s.end);
    if (!(looksInjected(text) || SOURCEMAP_REF.test(text))) continue;
    out += body.slice(cursor, s.start) + (text.startsWith("<!--") ? "<!-- [ree: removed] -->" : "/* [ree: removed] */");
    cursor = s.end;
    removedComments++;
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
  }
  out += body.slice(cursor);

  // Pass 2: redact injection payloads that live in string literals or raw data.
  // These change nothing at runtime (REE never rewrites the target); redacting
  // them only keeps BLA's prompt attacks out of the analyzer's context.
  const red = redactInjections(out);
  out = red.text;
  if (red.count) {
    findings.push({
      pass: "sanitizer",
      severity: "malicious",
      action: "sanitized",
      unitId,
      message: `redacted ${red.count} embedded AI-directed instruction(s) from "${name}" (string-literal or data payloads; neutralized, not executed)`,
    });
  }

  const changed = removedComments > 0 || red.count > 0 || norm.decoded > 0 || norm.folded > 0;
  return { findings, body: changed ? out : rawBody, redactedInjections: red.count };
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

/**
 * javascript-obfuscator-style string array: a rotation loop
 * (`while(!![]){ … parseInt(…) … arr.push(arr.shift()) }`) that reorders an
 * array of (often base64/rc4-encoded) strings until a checksum matches, read
 * through a decoder function. Recovering the literals means running that
 * decoder, which REE never does — so it is reported, not decoded.
 */
export function detectStringArray(unitId: string, name: string, body: string): AntiBlaFinding[] {
  const rotation =
    /while\s*\(\s*(?:!!\[\]|true|!0)\s*\)/.test(body) &&
    /parseInt\(/.test(body) &&
    /(?:\[\s*['"]push['"]\s*\]|\.push)\(\s*[\w$]+(?:\[\s*['"]shift['"]\s*\]|\.shift)\(\)\s*\)/.test(body);
  if (!rotation) return [];
  const encoded = /abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\+\/=/.test(body) || /%\s*(?:0x100|256)\b/.test(body);
  return [{
    pass: "sanitizer",
    severity: "suspicious",
    action: "flagged",
    unitId,
    message: `"${name}" contains an obfuscator string array${encoded ? " with encoded (base64/rc4) entries" : ""}; literals are decoded at runtime and REE does not execute decoders, so they stay hidden`,
  }];
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
