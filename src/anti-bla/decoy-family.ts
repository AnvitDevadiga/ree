/**
 * Decoy-family detection.
 *
 * Reachability pruning can only drop code that is provably unreachable from an
 * entry point. Real BLA output defeats that: it plants large families of
 * *structurally identical* units with no honest entry graph —
 *   - flat JS bundles with dozens of templated tarpit functions
 *     (`scc_deriveSubkeySchedule_…`, `scc_permuteFeistelRound_…`, all the same
 *     body shape, differing only in constants and which sibling they call);
 *   - Electron `.asar` archives with thousands of near-identical decoy files
 *     (`enclave/shards/ring0-slot-*.json`) planted to amplify the header.
 *
 * Neither is reachable-dead, so neither gets pruned, and both flood the context.
 * This pass clusters units by a structural fingerprint (identifiers → `V`,
 * numbers → `N`, string/comment contents stripped, control-flow keywords kept),
 * and quarantines clusters that are large enough to be generated filler rather
 * than hand-written code. Quarantine removes a unit from the LLM context only —
 * REE never rewrites or executes the target.
 */
import type { AntiBlaFinding, CodeUnit } from "../core/types.js";

export interface DecoyFamilyThresholds {
  /** Minimum members sharing one fingerprint before a substantial-body cluster is a family. */
  minFamilySize: number;
  /** A cluster of substantial bodies needs a fingerprint at least this long. */
  minBodyChars: number;
  /**
   * Tiny bodies (e.g. 75-byte decoy JSON shards) are only treated as chaff when
   * the family is both very large AND dominates the artifact — the signature of
   * an exhaustion flood, not of ordinary repeated records.
   */
  massFamilySize: number;
  /** Minimum normalized length to be clustered at all (skips empty `{}` / `;`). */
  minTinyChars: number;
  /** Fraction of all candidate units a tiny-body family must reach to qualify. */
  massDominanceFraction: number;
}

export const DEFAULT_DECOY_THRESHOLDS: DecoyFamilyThresholds = {
  minFamilySize: 8,
  minBodyChars: 60,
  massFamilySize: 40,
  minTinyChars: 16,
  massDominanceFraction: 0.1,
};

// Control-flow / declaration keywords are preserved so the fingerprint still
// encodes a function's structure; everything else collapses, so two templated
// clones match while two genuinely different functions do not.
const KEYWORDS = new Set(
  (
    "if else for while switch case default return function const let var break continue " +
    "try catch finally throw new typeof instanceof void delete in of do await async yield " +
    "this class extends super import export from as"
  ).split(" "),
);

/** Structural fingerprint of a source body (see module doc). */
export function structuralFingerprint(body: string): string {
  let s = body;
  // Strip comments first.
  s = s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  // Empty string / template contents (keep delimiters) so constants don't matter.
  s = s.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/`(?:[^`\\]|\\.)*`/g, "``");
  // Numbers (hex and decimal) → N.
  s = s.replace(/\b0x[0-9a-fA-F]+\b/g, "N").replace(/\b\d+(?:\.\d+)?\b/g, "N");
  // Non-keyword identifiers → V.
  s = s.replace(/[A-Za-z_$][\w$]*/g, (m) => (KEYWORDS.has(m) ? m : "V"));
  // Collapse whitespace.
  s = s.replace(/\s+/g, "");
  return s;
}

export interface DecoyFamilyResult {
  findings: AntiBlaFinding[];
  quarantined: Set<string>;
  /** fingerprint → member ids, for families that were quarantined. */
  families: { size: number; sample: string }[];
}

/**
 * Cluster code-like units by structural fingerprint and quarantine large
 * clone families. Entry points are never quarantined. A family is not
 * quarantined if removing it would leave no units behind (guards against a
 * tiny artifact of genuinely repetitive records).
 */
export function detectDecoyFamilies(
  units: CodeUnit[],
  entryIds: ReadonlySet<string>,
  t: DecoyFamilyThresholds = DEFAULT_DECOY_THRESHOLDS,
): DecoyFamilyResult {
  const findings: AntiBlaFinding[] = [];
  const quarantined = new Set<string>();
  const families: { size: number; sample: string }[] = [];

  const groups = new Map<string, CodeUnit[]>();
  for (const u of units) {
    if (!u.body) continue;
    if ((u.meta as { listing?: boolean }).listing === true) continue; // disassembly, not source
    if (u.kind !== "module" && u.kind !== "function" && u.kind !== "class" && u.kind !== "chunk") continue;
    const fp = structuralFingerprint(u.body);
    if (fp.length < t.minTinyChars) continue;
    const g = groups.get(fp);
    if (g) g.push(u);
    else groups.set(fp, [u]);
  }

  const totalCandidates = units.length;
  for (const [fp, members] of groups) {
    const substantial = fp.length >= t.minBodyChars && members.length >= t.minFamilySize;
    const massChaff =
      members.length >= t.massFamilySize && members.length >= totalCandidates * t.massDominanceFraction;
    if (!substantial && !massChaff) continue;

    const prunable = members.filter((m) => !entryIds.has(m.id));
    // Never let a family swallow the whole artifact, and re-check the floor.
    if (prunable.length >= totalCandidates) continue;
    if (prunable.length < Math.min(t.minFamilySize, members.length)) continue;

    for (const m of prunable) quarantined.add(m.id);
    families.push({ size: prunable.length, sample: fp.slice(0, 80) });
    const names = prunable.slice(0, 3).map((m) => m.name).join(", ");
    findings.push({
      pass: "decoy-family",
      severity: "malicious",
      action: "quarantined",
      unitId: prunable[0]!.id,
      message: `quarantined a ${prunable.length}-unit structural-clone family from LLM context (generated decoy filler, e.g. ${names}${prunable.length > 3 ? ", …" : ""})`,
      evidence: { familySize: prunable.length, fingerprint: fp.slice(0, 80) },
    });
  }

  return { findings, quarantined, families };
}
