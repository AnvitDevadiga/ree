/**
 * Honest limitations reporting.
 *
 * Like REA, REE should never present a conclusion without also stating what it
 * could *not* establish. `deriveLimitations` turns the model and the anti-BLA
 * report into a plain-language list of caveats a reader must keep in mind before
 * trusting the output — incomplete call graphs, structure-only native/pyc
 * support, quarantined material that was deliberately not analyzed, and the
 * standing fact that REE is static-only.
 */
import type { AntiBlaReport } from "./types.js";

export function deriveLimitations(report: AntiBlaReport): string[] {
  const out: string[] = [];
  const { model, stats } = report;
  const fmt = model.format;
  const meta = model.meta as { graphComplete?: boolean };

  // Call-graph completeness governs how much pruning could be trusted.
  if (meta.graphComplete !== true) {
    out.push(
      `No trusted call graph for ${fmt}: dead-code pruning was skipped, so unreferenced decoys may still be present in the slices.`,
    );
  } else if (model.entryPoints.length === 0) {
    out.push("No entry point was identified, so reachability pruning was skipped.");
  }

  // Depth of support per format.
  if (fmt === "elf" || fmt === "macho" || fmt === "pe") {
    out.push(
      `Native (${fmt}) analysis is structural only — symbols, imports and exports. REE does not decompile machine code; pair it with Ghidra/Hopper/IDA for instruction-level recovery.`,
    );
  }
  if (fmt === "pyc") {
    out.push(
      "Python bytecode: code objects, names and constants are recovered, but there is no bytecode-level call graph, so nothing is pruned.",
    );
  }
  if (fmt === "wasm") {
    out.push("WASM is decoded to a WAT-style listing; high-level types and names beyond the name section are not recovered.");
  }

  // Material deliberately excluded from analysis.
  const excluded = stats.unitsQuarantined + stats.unitsPruned;
  if (excluded > 0) {
    const parts: string[] = [];
    if (stats.decoyFamilyUnits) parts.push(`${stats.decoyFamilyUnits} decoy-family`);
    if (stats.unitsPruned) parts.push(`${stats.unitsPruned} unreachable`);
    out.push(
      `${excluded} unit(s) were excluded from LLM context (${parts.join(", ") || "quarantined"}). They are listed in the findings if you need to inspect them directly.`,
    );
  }

  // Trust posture for recovered strings.
  const redacted = report.findings.filter((f) => f.pass === "sanitizer" && f.action === "sanitized").length;
  if (redacted > 0) {
    out.push(
      "The artifact contained AI-directed instructions that were redacted; treat all recovered strings as untrusted data, never as instructions.",
    );
  }

  // Standing limitation.
  out.push("REE is static-only: it never executes the target, so runtime-generated behavior is not observed.");
  return out;
}
