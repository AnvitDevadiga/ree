/**
 * Reachability pruner.
 *
 * Walks the reference graph from the model's entry points and removes code that
 * nothing can reach — injected decoy functions, shadow state machines, padding
 * modules. Run after opaque-predicate folding, so code reachable only through a
 * dead branch is also removed.
 *
 * Pruning is only sound when the graph is trustworthy, so it is skipped when:
 *   - the parser did not mark the graph complete (pyc, native, unparsable JS), or
 *   - no entry point is known.
 * Non-code entries (images, JSON data, etc.) are never pruned.
 */
import type { AntiBlaFinding, ArtifactModel, CodeUnit } from "../core/types.js";

export interface ReachabilityResult {
  findings: AntiBlaFinding[];
  reachableIds: Set<string>;
  pruned: number;
}

function isCode(u: CodeUnit): boolean {
  if ((u.meta as { code?: boolean }).code === false) return false;
  return !!u.body || u.kind === "function";
}

export function analyzeReachability(model: ArtifactModel): ReachabilityResult {
  const findings: AntiBlaFinding[] = [];
  const all = new Set(model.units.map((u) => u.id));

  if ((model.meta as { graphComplete?: boolean }).graphComplete !== true) {
    findings.push({
      pass: "reachability",
      severity: "info",
      action: "flagged",
      message: `no trusted call graph for ${model.format}; dead-code pruning skipped`,
    });
    return { findings, reachableIds: all, pruned: 0 };
  }
  if (model.entryPoints.length === 0) {
    findings.push({
      pass: "reachability",
      severity: "info",
      action: "flagged",
      message: "no entry points found; dead-code pruning skipped",
    });
    return { findings, reachableIds: all, pruned: 0 };
  }

  const byId = new Map(model.units.map((u) => [u.id, u]));
  const reachable = new Set<string>();
  const queue = model.entryPoints.map((e) => e.unitId).filter((id) => byId.has(id));
  while (queue.length) {
    const id = queue.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const ref of byId.get(id)?.references ?? []) if (!reachable.has(ref) && byId.has(ref)) queue.push(ref);
  }

  let pruned = 0;
  let codeUnits = 0;
  for (const u of model.units) {
    if (!isCode(u)) {
      reachable.add(u.id);
      continue;
    }
    codeUnits++;
    u.reachable = reachable.has(u.id);
    if (!u.reachable) {
      pruned++;
      findings.push({
        pass: "reachability",
        severity: "suspicious",
        action: "pruned",
        unitId: u.id,
        message: `pruned "${u.name}": unreachable from every entry point`,
        evidence: { kind: u.kind, size: u.size ?? u.body?.length ?? 0 },
      });
    }
  }

  if (codeUnits > 4 && pruned >= codeUnits * 0.5) {
    findings.push({
      pass: "reachability",
      severity: "malicious",
      action: "flagged",
      message: `${pruned}/${codeUnits} code units are unreachable — consistent with large-scale decoy injection`,
    });
  }
  return { findings, reachableIds: reachable, pruned };
}

export function keepReachable(units: CodeUnit[], reachable: Set<string>): CodeUnit[] {
  return units.filter((u) => reachable.has(u.id));
}
