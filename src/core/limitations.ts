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
  if (fmt === "apk") {
    const m = model.meta as {
      decompiler?: string; jadxInstall?: string; classDefs?: number; appClasses?: number; libraryClasses?: number;
      decompileErrors?: number; hermesBundles?: number; nativeLibs?: number; package?: string; container?: string;
    };
    if (m.decompiler !== "jadx") {
      out.push(
        `Java/Kotlin code was not decompiled (${m.classDefs ?? 0} classes in DEX): jadx is not installed. Install it to unlock source-level analysis: ${m.jadxInstall ?? "see 'ree doctor'"}.`,
      );
    } else {
      out.push(
        `Decompiled with jadx; Kotlin appears as Java and decompiler output can be inexact${m.decompileErrors ? ` (${m.decompileErrors} class(es) only partially decompiled)` : ""}.`,
      );
      if (m.libraryClasses) {
        out.push(`${m.libraryClasses} third-party library classes were counted but not analyzed; only the app's own ${m.appClasses ?? 0} classes${m.package ? ` (under ${m.package})` : ""} are in scope.`);
      }
    }
    if (!m.package) out.push("The app's package could not be read from the manifest, so app code could not be separated from library code.");
    if (m.hermesBundles) out.push(`${m.hermesBundles} React Native bundle(s) are Hermes bytecode; REE does not decompile Hermes.`);
    if (m.nativeLibs) out.push(`${m.nativeLibs} native library file(s) (.so) were listed but not analyzed; run 'ree analyze' on an extracted .so for its structure.`);
  }
  if (fmt === "jar") {
    const m = model.meta as { decompiler?: string; vineflowerInstall?: string; classes?: number; decompiledClasses?: number; nestedJars?: number; classParseFailures?: number };
    if (m.decompiler !== "vineflower") {
      out.push(
        `Java bytecode was read for structure only (classes, fields, method signatures, references) — method bodies were not decompiled${m.vineflowerInstall ? `: Vineflower is not installed. Install it to unlock Java source: ${m.vineflowerInstall}` : ""}.`,
      );
    } else {
      out.push(`Decompiled with Vineflower (${m.decompiledClasses ?? 0} source files); decompiler output can be inexact, and generics or lambdas may not match the original source exactly.`);
    }
    out.push("Class references come from the constant pool; reflection, service loading and dependency injection are not visible, so nothing is pruned.");
    if (m.nestedJars) out.push(`${m.nestedJars} nested library JAR(s) were counted but not analyzed; extract one and run 'ree analyze' on it.`);
    if (m.classParseFailures) out.push(`${m.classParseFailures} class file(s) could not be parsed and are missing from the report.`);
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
