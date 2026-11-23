/**
 * .NET assembly parser (managed .dll / .exe).
 *
 * Always (no tools): the assembly's identity, dependencies, every type with its
 * base type, fields and methods (with parameter names), P/Invoke imports into
 * native DLLs, the entry point, and string literals — read straight from the
 * ECMA-335 metadata tables.
 *
 * With ilspycmd installed (optional), types are decompiled to C# and the source
 * replaces the structural summary. ilspycmd runs argv-only, on an absolute path,
 * into a private temp dir, under a time limit; its output is untrusted input to
 * the cleaning engine.
 */
import { mkdtempSync, readdirSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactModel, CodeUnit, EntryPoint, ExtractedString, Parser, ParserInput } from "../core/types.js";
import { findCliHeader, readDotnetMetadata, type DotnetType } from "./dotnet-metadata.js";
import { ILSPY, findTool, installHint, runTool, safeInputPath } from "../tools/external.js";

export interface DotnetLimits {
  decompileTimeoutMs: number;
  maxTypes: number;
  maxSourceFileBytes: number;
  maxSourceTotalBytes: number;
}

export const DEFAULT_DOTNET_LIMITS: DotnetLimits = {
  decompileTimeoutMs: 300_000,
  maxTypes: 50_000,
  maxSourceFileBytes: 1024 * 1024,
  maxSourceTotalBytes: 128 * 1024 * 1024,
};

const TD_VISIBILITY = 0x7;
const TD_INTERFACE = 0x20;
const MD_STATIC = 0x10;

/** Compiler-generated types (async state machines, closures, anonymous types). */
const generated = (t: DotnetType) => /[<>]/.test(t.name);

export class DotnetParser implements Parser {
  readonly format = "dotnet" as const;

  constructor(private readonly limits: DotnetLimits = DEFAULT_DOTNET_LIMITS) {}

  canParse(input: ParserInput): boolean {
    return findCliHeader(input.bytes) !== null;
  }

  async parse(input: ParserInput): Promise<ArtifactModel> {
    const warnings: string[] = [];
    let md: ReturnType<typeof readDotnetMetadata>;
    try {
      md = readDotnetMetadata(input.bytes);
    } catch (e) {
      // Hostile or corrupt metadata: report it instead of failing the run.
      return {
        format: "dotnet",
        sourcePath: input.path,
        byteLength: input.bytes.length,
        units: [],
        strings: [],
        entryPoints: [],
        warnings: [`.NET metadata could not be read: ${(e as Error).message}`],
        meta: { graphComplete: false, decompiler: "none", metadataError: (e as Error).message },
      };
    }
    const strings: ExtractedString[] = md.userStrings.map((value) => ({ value, source: "literal" as const }));

    const all = md.types.filter((t) => t.fullName !== "<Module>");
    const kept = all.filter((t) => !generated(t) && !t.fullName.split("+").some((part) => /[<>]/.test(part)));
    const generatedCount = all.length - kept.length;
    if (kept.length > this.limits.maxTypes) warnings.push(`[anti-exhaust] only the first ${this.limits.maxTypes} of ${kept.length} types are modeled`);

    const units: CodeUnit[] = [];
    const idOf = new Map<string, string>();
    for (const t of kept.slice(0, this.limits.maxTypes)) {
      const id = `type:${units.length}`;
      idOf.set(t.fullName, id);
      units.push({
        id,
        name: t.fullName,
        kind: "class",
        references: [],
        meta: {
          kind: t.flags & TD_INTERFACE ? "interface" : "type",
          public: (t.flags & TD_VISIBILITY) === 1 || (t.flags & TD_VISIBILITY) === 2,
          extends: t.extends && t.extends !== "System.Object" ? t.extends : undefined,
          methods: t.methods.map((m) => `${m.flags & MD_STATIC ? "static " : ""}${m.name}(${m.params.join(", ")})`),
          fields: t.fields.filter((f) => !/[<>]/.test(f)),
          refToken: t.name,
        },
      });
    }
    // Within-assembly inheritance is the one type-level edge metadata gives directly.
    for (const u of units) {
      const base = (u.meta as { extends?: string }).extends;
      const target = base ? idOf.get(base) : undefined;
      if (target) u.references.push(target);
    }

    const entryPoints: EntryPoint[] = [];
    if (md.entryPoint) {
      const id = idOf.get(md.entryPoint.type);
      if (id) entryPoints.push({ unitId: id, reason: "declared", detail: `entry point: ${md.entryPoint.type}.${md.entryPoint.method}` });
    }

    const tool = process.env.REE_DISABLE_ILSPY ? null : findTool(ILSPY);
    let decompiled = 0;
    let decompileFailed = false;
    if (tool && units.length) {
      const r = await this.decompile(tool, input.path, units, idOf, warnings);
      decompiled = r.decompiled;
      decompileFailed = r.failed;
    }

    return {
      format: "dotnet",
      sourcePath: input.path,
      byteLength: input.bytes.length,
      units,
      strings,
      entryPoints,
      warnings,
      meta: {
        // No type-level call graph without reading IL; never prune.
        graphComplete: false,
        assembly: md.assembly ? `${md.assembly.name} ${md.assembly.version}` : undefined,
        runtime: md.runtimeVersion,
        ilOnly: md.ilOnly,
        dependencies: md.assemblyRefs.map((a) => `${a.name} ${a.version}`),
        types: kept.length,
        generatedTypes: generatedCount,
        externalTypes: md.typeRefs.length,
        pinvokes: md.pinvokes.slice(0, 200),
        userStrings: md.userStrings.length,
        entryPoint: md.entryPoint ? `${md.entryPoint.type}.${md.entryPoint.method}` : undefined,
        decompiler: decompiled ? "ilspycmd" : "none",
        decompiledTypes: decompiled,
        ...(decompiled || decompileFailed ? {} : { ilspyInstall: installHint(ILSPY) }),
      },
    };
  }

  private async decompile(tool: string, path: string, units: CodeUnit[], idOf: Map<string, string>, warnings: string[]) {
    const work = mkdtempSync(join(tmpdir(), "ree-ilspy-"));
    try {
      try {
        await runTool(tool, ["-p", "-o", work, safeInputPath(path)], {
          cwd: work,
          timeoutMs: Number(process.env.REE_ILSPY_TIMEOUT_MS) || this.limits.decompileTimeoutMs,
        });
      } catch (e) {
        warnings.push(`ilspycmd failed: ${(e as Error).message}; falling back to metadata structure`);
        return { decompiled: 0, failed: true };
      }
      const byId = new Map(units.map((u) => [u.id, u] as const));
      let total = 0;
      let decompiled = 0;
      const walk = (dir: string, depth: number) => {
        if (depth > 64) return;
        let names: string[];
        try {
          names = readdirSync(dir);
        } catch {
          return;
        }
        for (const n of names) {
          const p = join(dir, n);
          const st = lstatSync(p);
          if (st.isSymbolicLink()) continue;
          if (st.isDirectory()) {
            walk(p, depth + 1);
            continue;
          }
          if (!n.endsWith(".cs")) continue;
          if (st.size > this.limits.maxSourceFileBytes || total + st.size > this.limits.maxSourceTotalBytes) {
            warnings.push(`${n}: decompiled source too large; kept as metadata structure`);
            continue;
          }
          const body = readFileSync(p, "utf8");
          total += st.size;
          // Type name from the namespace declaration + file name, not the path.
          const ns = /^\s*namespace\s+([\w.]+)\s*[;{]?/m.exec(body)?.[1];
          const fullName = (ns ? ns + "." : "") + n.slice(0, -3).replace(/`\d+$/, "");
          const u = byId.get(idOf.get(fullName) ?? "");
          if (!u || u.body) continue;
          u.body = body;
          u.meta = { ...u.meta, decompiler: "ilspycmd" };
          decompiled++;
        }
      };
      walk(work, 0);
      // Nested types live inside their outer type's file.
      const withSource = new Set(units.filter((u) => u.body).map((u) => u.name));
      for (let i = units.length - 1; i >= 0; i--) {
        const u = units[i]!;
        const outer = u.name.includes("+") ? u.name.slice(0, u.name.indexOf("+")) : null;
        if (!u.body && outer && withSource.has(outer)) units.splice(i, 1);
      }
      const live = new Set(units.map((u) => u.id));
      for (const u of units) u.references = u.references.filter((r) => live.has(r));
      return { decompiled, failed: false };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
}
