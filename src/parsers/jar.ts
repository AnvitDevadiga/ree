/**
 * Java JAR / .class parser.
 *
 * Always (no tools): the JAR manifest (Main-Class, title, version, Spring Boot
 * Start-Class), every class read straight from bytecode — superclass,
 * interfaces, fields, methods with signatures — and a precise class-level
 * reference graph from the constant pool. Methods named `main` with the
 * standard signature and the declared Main-Class become entry points.
 *
 * With Vineflower installed (optional), classes are decompiled to Java source
 * and the source replaces the structural summary. Inner classes are folded
 * into their outer class's source. Fat JARs (Spring Boot BOOT-INF/lib, lib/)
 * have their nested library JARs counted, not opened.
 *
 * Vineflower runs with an argv array on an absolute path, into a private temp
 * dir, under a time limit; its output goes through REE's cleaning engine.
 */
import { mkdtempSync, readdirSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import type { ArtifactModel, CodeUnit, EntryPoint, ExtractedString, Parser, ParserInput } from "../core/types.js";
import { classify } from "../core/detect.js";
import { ZipReader } from "./zip.js";
import { parseClassFile, prettyDescriptor, javaVersion, type ClassInfo } from "./classfile.js";
import { VINEFLOWER, installHint, runTool, safeInputPath, which } from "../tools/external.js";

export interface JarLimits {
  maxClasses: number;
  maxClassBytes: number;
  decompileTimeoutMs: number;
  maxSourceFileBytes: number;
  maxSourceTotalBytes: number;
}

export const DEFAULT_JAR_LIMITS: JarLimits = {
  maxClasses: 20_000,
  maxClassBytes: 4 * 1024 * 1024,
  decompileTimeoutMs: 300_000,
  maxSourceFileBytes: 512 * 1024,
  maxSourceTotalBytes: 128 * 1024 * 1024,
};

const ACC_PUBLIC = 0x0001;
const ACC_STATIC = 0x0008;

function isSingleClass(b: Uint8Array): boolean {
  if (b.length < 10 || b[0] !== 0xca || b[1] !== 0xfe || b[2] !== 0xba || b[3] !== 0xbe) return false;
  const major = (b[6]! << 8) | b[7]!;
  return major >= 45 && major < 200;
}

function readManifest(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Continuation lines start with a single space.
  const lines = text.replace(/\r\n/g, "\n").replace(/\n /g, "").split("\n");
  for (const l of lines.slice(0, 2000)) {
    const i = l.indexOf(":");
    if (i > 0 && !(l.slice(0, i) in out)) out[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  return out;
}

export class JarParser implements Parser {
  readonly format = "jar" as const;

  constructor(private readonly limits: JarLimits = DEFAULT_JAR_LIMITS) {}

  canParse(input: ParserInput): boolean {
    const b = input.bytes;
    if (isSingleClass(b)) return true;
    if (b.length < 4 || b[0] !== 0x50 || b[1] !== 0x4b || b[2] !== 0x03 || b[3] !== 0x04) return false;
    return classify(b.subarray(0, 64 * 1024), b.subarray(Math.max(0, b.length - 1024 * 1024))).kind === "jar";
  }

  async parse(input: ParserInput): Promise<ArtifactModel> {
    const warnings: string[] = [];
    const strings: ExtractedString[] = [];
    const single = isSingleClass(input.bytes);
    const classBytes: Array<{ path: string; bytes: Uint8Array }> = [];
    let manifest: Record<string, string> = {};
    const nestedJars: string[] = [];
    let multiRelease = 0;

    if (single) {
      classBytes.push({ path: basename(input.path), bytes: input.bytes });
    } else {
      const zip = new ZipReader(input.bytes);
      warnings.push(...zip.warnings);
      const mf = zip.get("META-INF/MANIFEST.MF");
      if (mf) {
        try {
          manifest = readManifest(new TextDecoder().decode(zip.read(mf, 1024 * 1024)));
        } catch (e) {
          warnings.push(`MANIFEST.MF: ${(e as Error).message}`);
        }
      }
      for (const e of zip.entries) {
        if (/^(BOOT-INF\/lib|WEB-INF\/lib|lib)\/[^/]+\.jar$/.test(e.name)) nestedJars.push(e.name);
        if (!e.name.endsWith(".class") || e.name.endsWith("module-info.class")) continue;
        if (e.name.startsWith("META-INF/versions/")) {
          multiRelease++;
          continue;
        }
        if (classBytes.length >= this.limits.maxClasses) {
          warnings.push(`[anti-exhaust] stopped after ${this.limits.maxClasses} classes`);
          break;
        }
        try {
          classBytes.push({ path: e.name, bytes: zip.read(e, this.limits.maxClassBytes) });
        } catch (err) {
          warnings.push(`${e.name}: ${(err as Error).message}`);
        }
      }
      if (multiRelease) warnings.push(`${multiRelease} version-specific class(es) under META-INF/versions/ were skipped; the base classes are analyzed`);
      if (nestedJars.length) warnings.push(`${nestedJars.length} nested library JAR(s) (fat JAR) were counted, not opened`);
    }

    // ---- bytecode structure (always) --------------------------------------
    const infos = new Map<string, ClassInfo>();
    let failed = 0;
    for (const c of classBytes) {
      try {
        const info = parseClassFile(c.bytes);
        if (!infos.has(info.name)) infos.set(info.name, info);
      } catch (e) {
        failed++;
        if (failed <= 5) warnings.push(`${c.path}: ${(e as Error).message}`);
      }
    }
    if (failed > 5) warnings.push(`${failed} class files could not be parsed in total`);

    const units: CodeUnit[] = [];
    const idOf = new Map<string, string>();
    for (const info of infos.values()) {
      const id = `cls:${units.length}`;
      idOf.set(info.name, id);
      units.push({
        id,
        name: info.name,
        kind: "class",
        references: [],
        meta: {
          extends: info.superName && info.superName !== "java.lang.Object" ? info.superName : undefined,
          implements: info.interfaces,
          methods: info.methods.filter((m) => m.name !== "<clinit>").map((m) => `${m.name}${prettyDescriptor(m.desc)}`),
          fields: info.fields.map((f) => `${f.name}: ${prettyDescriptor(`()${f.desc}`).replace(/^\(\) /, "")}`),
          java: javaVersion(info.major),
          refToken: info.name.split(".").pop(),
        },
      });
      for (const s of info.strings) strings.push({ value: s, source: "literal", unitId: id });
    }
    for (const info of infos.values()) {
      const u = units.find((x) => x.id === idOf.get(info.name))!;
      u.references = info.references.map((r) => idOf.get(r)).filter((r): r is string => !!r && r !== u.id);
    }

    // ---- entry points ------------------------------------------------------
    const entryPoints: EntryPoint[] = [];
    const mainClass = manifest["Start-Class"] ?? manifest["Main-Class"];
    if (mainClass && idOf.has(mainClass)) entryPoints.push({ unitId: idOf.get(mainClass)!, reason: "declared", detail: `Main-Class: ${mainClass}` });
    for (const info of infos.values()) {
      const hasMain = info.methods.some((m) => m.name === "main" && m.desc === "([Ljava/lang/String;)V" && (m.access & (ACC_PUBLIC | ACC_STATIC)) === (ACC_PUBLIC | ACC_STATIC));
      if (hasMain && info.name !== mainClass) entryPoints.push({ unitId: idOf.get(info.name)!, reason: "main", detail: `main(String[]) in ${info.name}` });
    }

    // ---- decompilation (optional) -----------------------------------------
    const vfPath = process.env.REE_DISABLE_VINEFLOWER ? null : which(VINEFLOWER.bin);
    let decompiled = 0;
    let decompileFailed = false;
    if (vfPath && infos.size) {
      const res = await this.decompile(vfPath, input.path, single, units, idOf, warnings);
      decompiled = res.decompiled;
      decompileFailed = res.failed;
    }

    const javaVersions = [...new Set([...infos.values()].map((i) => javaVersion(i.major)))];
    const packages = new Set([...infos.keys()].map((n) => n.slice(0, n.lastIndexOf(".")) || "(default)"));
    return {
      format: "jar",
      sourcePath: input.path,
      byteLength: input.bytes.length,
      units,
      strings,
      entryPoints,
      warnings,
      meta: {
        // The constant-pool graph is exact for static references, but reflection
        // and service loading are invisible to it — so never prune on it.
        graphComplete: false,
        container: single ? "class" : "jar",
        mainClass,
        title: manifest["Implementation-Title"] ?? manifest["Bundle-Name"],
        version: manifest["Implementation-Version"] ?? manifest["Bundle-Version"],
        moduleName: manifest["Automatic-Module-Name"],
        classes: infos.size,
        classParseFailures: failed,
        packages: packages.size,
        javaVersions,
        nestedJars: nestedJars.length,
        decompiler: decompiled ? "vineflower" : "none",
        decompiledClasses: decompiled,
        ...(decompiled || decompileFailed ? {} : { vineflowerInstall: installHint(VINEFLOWER) }),
      },
    };
  }

  private async decompile(
    vfPath: string,
    inputPath: string,
    single: boolean,
    units: CodeUnit[],
    idOf: Map<string, string>,
    warnings: string[],
  ): Promise<{ decompiled: number; failed: boolean }> {
    const work = mkdtempSync(join(tmpdir(), "ree-vineflower-"));
    try {
      const out = join(work, "out");
      let src = safeInputPath(inputPath);
      if (single) {
        // Vineflower names output after the input; give it a clean .class name.
        src = join(work, "Input.class");
        writeFileSync(src, readFileSync(inputPath));
      }
      try {
        await runTool(vfPath, ["--log-level=error", src, out], {
          cwd: work,
          timeoutMs: Number(process.env.REE_VINEFLOWER_TIMEOUT_MS) || this.limits.decompileTimeoutMs,
        });
      } catch (e) {
        warnings.push(`vineflower failed: ${(e as Error).message}; falling back to bytecode structure`);
        return { decompiled: 0, failed: true };
      }
      let total = 0;
      let decompiled = 0;
      const byId = new Map(units.map((u) => [u.id, u] as const));
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
          if (!n.endsWith(".java")) continue;
          if (st.size > this.limits.maxSourceFileBytes || total + st.size > this.limits.maxSourceTotalBytes) {
            warnings.push(`${n}: decompiled source too large; kept as bytecode structure`);
            continue;
          }
          const body = readFileSync(p, "utf8");
          total += st.size;
          // FQCN from the package declaration + file name, not from the path.
          const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(body)?.[1];
          const fqcn = (pkg ? pkg + "." : "") + n.slice(0, -5);
          const u = byId.get(idOf.get(fqcn) ?? "");
          if (!u) continue;
          u.body = body;
          u.meta = { ...u.meta, decompiler: "vineflower" };
          decompiled++;
        }
      };
      walk(out, 0);
      // Inner classes are inside their outer class's source now; drop their
      // separate structural units when the outer one was decompiled.
      const decompiledNames = new Set(units.filter((u) => u.body).map((u) => u.name));
      for (let i = units.length - 1; i >= 0; i--) {
        const u = units[i]!;
        const outer = u.name.includes("$") ? u.name.slice(0, u.name.indexOf("$")) : null;
        if (!u.body && outer && decompiledNames.has(outer)) {
          const outerId = idOf.get(outer)!;
          for (const other of units) other.references = other.references.map((r) => (r === u.id ? outerId : r)).filter((r) => r !== other.id);
          units.splice(i, 1);
        }
      }
      for (const u of units) u.references = [...new Set(u.references)].filter((r) => units.some((x) => x.id === r));
      return { decompiled, failed: false };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
}
