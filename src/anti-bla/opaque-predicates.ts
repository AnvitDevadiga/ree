/**
 * Opaque-predicate detection and dead-branch folding.
 *
 * Obfuscators guard decoy code with predicates whose value is fixed but hard to
 * see, so the decoy looks live. BLA documents one built on quadratic residues:
 *
 *     (7*x*x - 1) % 7  vs  (y*y) % 7
 *
 * For integers, 7x²−1 ≡ 6 (mod 7) — or −1 under JavaScript's sign-preserving `%`
 * — while squares mod 7 are only {0, 1, 2, 4}. The two sides never match, so
 * `===` is always false and `!==` always true.
 *
 * Detection matches *whole expressions* in the AST (not substrings), so a fold
 * can never change operator precedence. Folding rewrites:
 *   if (OPAQUE) A else B   ->  A or B
 *   OPAQUE ? A : B          ->  (A) or (B)
 *   while (FALSE) S         ->  ;
 *   any other OPAQUE        ->  true / false
 *
 * These identities assume integer operands, which is what obfuscators generate.
 * Every fold is reported, so a reviewer can audit it.
 */
import * as walk from "acorn-walk";
import type { AntiBlaFinding, CodeUnit } from "../core/types.js";
import { parseProgram } from "../parsers/js-bundle.js";

type AnyNode = { type: string; start: number; end: number; [k: string]: any };

interface Identity {
  name: string;
  /** Anchored regex over the expression text with all whitespace removed. */
  re: RegExp;
  /** Truth value given the operator captured in group "op". */
  value: (op: string) => boolean;
}

const eqValue = (whenEqual: boolean) => (op: string) => (op.startsWith("=") ? whenEqual : !whenEqual);

const IDENTITIES: Identity[] = [
  {
    name: "bla-quadratic-residue-mod7",
    re: /^\(7\*(\w+)\*\1-1\)%7(?<op>===?|!==?)\(?(\w+)\*\3\)?%7$/,
    value: eqValue(false),
  },
  {
    name: "bla-quadratic-residue-mod7",
    re: /^\(?(\w+)\*\1\)?%7(?<op>===?|!==?)\(7\*(\w+)\*\3-1\)%7$/,
    value: eqValue(false),
  },
  {
    // x*(x+1) is a product of consecutive integers, hence even.
    name: "consecutive-product-even",
    re: /^\(?(\w+)\*\(\1\+1\)\)?%2(?<op>===?|!==?)0$/,
    value: eqValue(true),
  },
  {
    name: "square-nonnegative",
    re: /^(\w+)\*\1(?<op>>=)0$/,
    value: () => true,
  },
  {
    // BLA MBA variant: ((X | Y) >>> 0) vs ((X ^ Y) >>> 0). For ANY operands,
    // X^Y is a submask of X|Y, so (X|Y) >= (X^Y) always and (X|Y) < (X^Y) never.
    // Matching the shape is sound regardless of what X and Y are, so this can
    // only miss cases, never fold wrongly.
    name: "bitmask-or-dominates-xor",
    re: /^\(\((.+)\|(.+)\)>>>0\)(?<op><|>=)\(\(\1\^\2\)>>>0\)$/,
    value: (op) => op === ">=",
  },
];

function stripParens(text: string): string {
  let t = text.replace(/\s+/g, "");
  while (t.startsWith("(") && t.endsWith(")") && balanced(t.slice(1, -1))) t = t.slice(1, -1);
  return t;
}

function balanced(t: string): boolean {
  let d = 0;
  for (const c of t) {
    if (c === "(") d++;
    else if (c === ")" && --d < 0) return false;
  }
  return d === 0;
}

export function evaluateOpaque(exprText: string): { name: string; value: boolean } | null {
  const t = stripParens(exprText);
  for (const id of IDENTITIES) {
    const m = id.re.exec(t);
    if (m) return { name: id.name, value: id.value(m.groups?.op ?? "") };
  }
  return null;
}

interface Fold {
  start: number;
  end: number;
  text: string;
  identity: string;
  value: boolean;
}

/**
 * Fold opaque predicates in a JS source body. Returns the body unchanged (with
 * `folds: 0`) if the body is not parseable JS.
 */
export function simplifyOpaquePredicates(body: string): { body: string; folds: Fold[] } {
  let current = body;
  const all: Fold[] = [];
  for (let pass = 0; pass < 4; pass++) {
    const { folds, offset } = findFolds(current);
    if (!folds.length) break;
    // Apply non-overlapping folds from the end so earlier offsets stay valid.
    folds.sort((a, b) => b.start - a.start);
    let lastStart = Infinity;
    for (const f of folds) {
      if (f.end > lastStart) continue; // overlaps a fold already applied
      current = current.slice(0, f.start - offset) + f.text + current.slice(f.end - offset);
      lastStart = f.start;
      all.push(f);
    }
  }
  return { body: current, folds: all };
}

function findFolds(src: string): { folds: Fold[]; offset: number } {
  let offset = 0;
  let ast = parseProgram(src);
  if (!ast) {
    // Anonymous function expressions (webpack factories) are not valid statements.
    ast = parseProgram(`(${src})`);
    offset = 1;
    if (!ast) return { folds: [], offset: 0 };
  }
  const text = offset ? `(${src})` : src;
  const slice = (n: AnyNode) => text.slice(n.start, n.end);
  const folds: Fold[] = [];
  const claimed: Array<[number, number]> = [];
  const isClaimed = (n: AnyNode) => claimed.some(([s, e]) => n.start >= s && n.end <= e);
  const claim = (f: Fold) => {
    folds.push(f);
    claimed.push([f.start, f.end]);
  };

  // Branch-level folds first (they subsume the predicate itself).
  walk.full(ast as any, (node: any) => {
    const n = node as AnyNode;
    if (isClaimed(n)) return;
    if (n.type === "IfStatement" || n.type === "ConditionalExpression") {
      const hit = evaluateOpaque(slice(n.test));
      if (!hit) return;
      const keep = hit.value ? n.consequent : n.alternate;
      const replacement =
        n.type === "IfStatement" ? (keep ? slice(keep) : ";") : `(${slice(keep)})`;
      claim({ start: n.start, end: n.end, text: replacement, identity: hit.name, value: hit.value });
    } else if (n.type === "WhileStatement") {
      const hit = evaluateOpaque(slice(n.test));
      if (hit && !hit.value) claim({ start: n.start, end: n.end, text: ";", identity: hit.name, value: false });
    }
  });

  // Remaining standalone predicates -> literal.
  walk.full(ast as any, (node: any) => {
    const n = node as AnyNode;
    if (n.type !== "BinaryExpression" || isClaimed(n)) return;
    const hit = evaluateOpaque(slice(n));
    if (hit) claim({ start: n.start, end: n.end, text: String(hit.value), identity: hit.name, value: hit.value });
  });

  return { folds, offset };
}

export interface OpaqueResult {
  findings: AntiBlaFinding[];
  /** unitIds whose bodies were rewritten. */
  changed: Set<string>;
}

/**
 * Fold opaque predicates in every JS-bearing unit, in place, and drop reference
 * edges whose target no longer appears in the folded body (an edge that only
 * existed inside a dead branch).
 */
export function foldOpaquePredicates(units: CodeUnit[]): OpaqueResult {
  const findings: AntiBlaFinding[] = [];
  const changed = new Set<string>();
  const tokenOf = new Map(units.map((u) => [u.id, String((u.meta as { refToken?: unknown }).refToken ?? "")]));

  for (const u of units) {
    if (!u.body || (u.meta as { listing?: boolean }).listing) continue;
    if (!/%\s*[27]|>=\s*0/.test(u.body)) continue; // cheap pre-filter
    const { body, folds } = simplifyOpaquePredicates(u.body);
    if (!folds.length) continue;
    u.body = body;
    changed.add(u.id);

    const before = u.references.length;
    u.references = u.references.filter((ref) => {
      const tok = tokenOf.get(ref);
      return !tok || new RegExp(`(^|[^\\w$])${escapeRe(tok)}($|[^\\w$])`).test(body);
    });

    const byIdentity = new Map<string, number>();
    for (const f of folds) byIdentity.set(f.identity, (byIdentity.get(f.identity) ?? 0) + 1);
    for (const [identity, count] of byIdentity) {
      findings.push({
        pass: "opaque-predicates",
        severity: identity.startsWith("bla-") ? "malicious" : "suspicious",
        action: "sanitized",
        unitId: u.id,
        message: `"${u.name}": folded ${count} opaque predicate(s) [${identity}]`,
        evidence: { identity, count, edgesRemoved: before - u.references.length },
      });
    }
  }
  return { findings, changed };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
