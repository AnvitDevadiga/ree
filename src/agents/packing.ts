/**
 * Slice packing for reconstruction.
 *
 * Cleaning works best at fine granularity (each function judged on its own),
 * but reconstruction works best with context: a function that uses a
 * module-level constant, or a minified bundle whose export map names its
 * functions, loses that context when every unit is sent alone. The
 * reconstruction benchmark showed it directly — a per-function slice of a
 * minified escapeHtml could not see the regex it depends on, and the export
 * names were lost.
 *
 * packSlices groups slices from the same file back together, in source order,
 * up to a token budget. Small artifacts become one pack (full context); large
 * ones still split, so nothing exceeds what a model can take in one call.
 * Packing only changes how cleaned content is grouped — it never adds content
 * the cleaning engine removed.
 */
import { estimateTokens } from "../core/tokens.js";
import type { ArtifactModel, CodeUnit, ContextSlice } from "../core/types.js";

export interface PackedSlice extends ContextSlice {
  /** Unit ids contained in this pack, in source order. */
  memberIds: string[];
}

/** Default pack budget, below the 6,000-token per-slice cap to leave room for the reply. */
export const DEFAULT_PACK_TOKENS = 4000;

function fileKey(u: CodeUnit | undefined): string {
  if (!u) return "";
  const parent = (u.meta as { parent?: string }).parent;
  return parent ?? "<artifact>";
}

export function packSlices(slices: ContextSlice[], model: ArtifactModel, budget = DEFAULT_PACK_TOKENS): PackedSlice[] {
  const byId = new Map(model.units.map((u) => [u.id, u] as const));
  // Group by file, keep source order inside each file.
  const groups = new Map<string, ContextSlice[]>();
  for (const s of slices) {
    const k = fileKey(byId.get(s.unitId));
    const g = groups.get(k);
    if (g) g.push(s);
    else groups.set(k, [s]);
  }

  const packs: PackedSlice[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => (byId.get(a.unitId)?.offset ?? 0) - (byId.get(b.unitId)?.offset ?? 0));
    let cur: ContextSlice[] = [];
    let curTokens = 0;
    const flush = () => {
      if (!cur.length) return;
      packs.push(merge(cur));
      cur = [];
      curTokens = 0;
    };
    for (const s of group) {
      if (cur.length && curTokens + s.estTokens > budget) flush();
      cur.push(s);
      curTokens += s.estTokens;
    }
    flush();
  }
  return packs;
}

function merge(members: ContextSlice[]): PackedSlice {
  if (members.length === 1) return { ...members[0]!, memberIds: [members[0]!.unitId] };
  const names = members.map((m) => m.name);
  const content = members.map((m) => `// ---- unit: ${m.name} ----\n${m.content}`).join("\n\n");
  const own = new Set(names);
  const neighbors = [...new Set(members.flatMap((m) => m.neighbors))].filter((n) => !own.has(n));
  const label = names.length <= 4 ? names.join(" + ") : `${names.slice(0, 3).join(" + ")} + ${names.length - 3} more`;
  return {
    unitId: members[0]!.unitId,
    name: label,
    content,
    neighbors,
    estTokens: estimateTokens(content),
    memberIds: members.map((m) => m.unitId),
  };
}
