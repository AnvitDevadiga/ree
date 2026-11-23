/**
 * Android APK / AAB parser.
 *
 * With jadx installed (optional), the app's DEX bytecode is decompiled to Java
 * and the app's own classes — those under the manifest's package — become
 * units; third-party library classes are counted and summarized, not sent to a
 * model. Without jadx, REE still reports the manifest (package, components,
 * permissions), DEX/class counts and native libraries, and fully analyzes any
 * JavaScript the app ships (React Native, Cordova, Capacitor), and the
 * limitations report gives the exact jadx install command.
 *
 * jadx is only ever run with an argv array on an absolute path, into a private
 * temp directory, under a time limit. Its output is untrusted input to REE's
 * cleaning engine like everything else. The app itself is never executed.
 */
import { mkdtempSync, readdirSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import type { ArtifactModel, CodeUnit, EntryPoint, ExtractedString, Parser, ParserInput } from "../core/types.js";
import { classify } from "../core/detect.js";
import { ZipReader, type ZipEntry } from "./zip.js";
import { parseManifest, type ManifestInfo } from "./axml.js";
import { parseJsSource } from "./js-bundle.js";
import { JADX, installHint, runTool, safeInputPath, toolError, which } from "../tools/external.js";

export interface ApkLimits {
  jadxTimeoutMs: number;
  maxJavaFiles: number;
  maxJavaFileBytes: number;
  maxJavaTotalBytes: number;
  maxAppClasses: number;
  maxJsBundles: number;
  maxJsBundleBytes: number;
}

export const DEFAULT_APK_LIMITS: ApkLimits = {
  jadxTimeoutMs: 300_000,
  maxJavaFiles: 50_000,
  maxJavaFileBytes: 512 * 1024,
  maxJavaTotalBytes: 128 * 1024 * 1024,
  maxAppClasses: 5_000,
  maxJsBundles: 200,
  maxJsBundleBytes: 16 * 1024 * 1024,
};

const HERMES_MAGIC = [0xc6, 0x1f, 0xbc, 0x03];

export class ApkParser implements Parser {
  readonly format = "apk" as const;

  constructor(private readonly limits: ApkLimits = DEFAULT_APK_LIMITS) {}

  canParse(input: ParserInput): boolean {
    const b = input.bytes;
    if (b.length < 4 || b[0] !== 0x50 || b[1] !== 0x4b || b[2] !== 0x03 || b[3] !== 0x04) return false;
    const kind = classify(b.subarray(0, 64 * 1024), b.subarray(Math.max(0, b.length - 1024 * 1024))).kind;
    return kind === "apk" || kind === "aab";
  }

  async parse(input: ParserInput): Promise<ArtifactModel> {
    const warnings: string[] = [];
    const units: CodeUnit[] = [];
    const strings: ExtractedString[] = [];
    const entryPoints: EntryPoint[] = [];
    const zip = new ZipReader(input.bytes);
    warnings.push(...zip.warnings);
    const isAab = !!zip.get("base/manifest/AndroidManifest.xml");

    // ---- manifest ---------------------------------------------------------
    let manifest: ManifestInfo = { components: [], permissions: [] };
    const manEntry = zip.get("AndroidManifest.xml");
    if (manEntry) {
      try {
        manifest = parseManifest(zip.read(manEntry, 8 * 1024 * 1024));
      } catch (e) {
        warnings.push(`AndroidManifest.xml could not be decoded: ${(e as Error).message}`);
      }
    } else if (isAab) {
      warnings.push("AAB manifests are protobuf-encoded; package and components were not decoded (jadx output is still analyzed)");
    }

    // ---- DEX and native libraries (structure, no tools needed) -------------
    const dexEntries = zip.entries.filter((e) => /^(base\/dex\/)?classes\d*\.dex$/.test(e.name));
    let classDefs = 0;
    for (const e of dexEntries) {
      try {
        const d = zip.read(e);
        if (d.length >= 0x70 && String.fromCharCode(d[0]!, d[1]!, d[2]!) === "dex") {
          classDefs += new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(0x60, true);
        }
      } catch (err) {
        warnings.push(`${e.name}: ${(err as Error).message}`);
      }
    }
    const nativeLibs = zip.entries.filter((e) => /^(base\/)?lib\/[^/]+\/[^/]+\.so$/.test(e.name)).map((e) => e.name);
    const abis = [...new Set(nativeLibs.map((n) => n.split("/").slice(-2)[0]!))];

    // ---- bundled JavaScript (React Native, Cordova, Capacitor) -------------
    const jsEntries = zip.entries
      .filter((e) => /^(base\/)?assets\/(.+\.bundle|www\/.+\.m?js|public\/.+\.m?js)$/.test(e.name))
      .slice(0, this.limits.maxJsBundles);
    let hermes = 0;
    for (const e of jsEntries) this.addJsBundle(zip, e, units, strings, warnings, () => hermes++);
    if (hermes) warnings.push(`${hermes} React Native bundle(s) are Hermes bytecode, not JavaScript source; they are listed but not decompiled`);

    // ---- jadx decompilation (optional) ------------------------------------
    const jadxPath = process.env.REE_DISABLE_JADX ? null : which(JADX.bin);
    let decompiled: { appClasses: number; libraryClasses: number; libraries: Record<string, number>; errors: number } | undefined;
    if (jadxPath) {
      decompiled = await this.decompile(jadxPath, input.path, manifest, units, strings, warnings);
    }

    // ---- entry points from the manifest ------------------------------------
    const byName = new Map(units.map((u) => [u.name, u] as const));
    for (const c of [...(manifest.application ? [{ kind: "application", name: manifest.application, launcher: false }] : []), ...manifest.components]) {
      const u = byName.get(c.name);
      if (u) entryPoints.push({ unitId: u.id, reason: "declared", detail: `${c.kind}${"launcher" in c && c.launcher ? " (launcher)" : ""}: ${c.name}` });
    }
    for (const u of units) if ((u.meta as { jsBundle?: boolean }).jsBundle && (u.meta as { synthetic?: boolean }).synthetic) {
      entryPoints.push({ unitId: u.id, reason: "main", detail: `bundled JS: ${u.name}` });
    }

    return {
      format: "apk",
      sourcePath: input.path,
      byteLength: input.bytes.length,
      units,
      strings,
      entryPoints,
      warnings,
      meta: {
        // Java references are resolved by name only; never prune on them.
        graphComplete: false,
        container: isAab ? "aab" : "apk",
        package: manifest.package,
        versionName: manifest.versionName,
        application: manifest.application,
        launcher: manifest.components.find((c) => c.launcher)?.name,
        components: manifest.components.length,
        exportedComponents: manifest.components.filter((c) => c.exported).length,
        permissions: manifest.permissions,
        dexFiles: dexEntries.length,
        classDefs,
        nativeLibs: nativeLibs.length,
        abis,
        jsBundles: jsEntries.length,
        hermesBundles: hermes,
        decompiler: decompiled ? "jadx" : "none",
        ...(decompiled
          ? {
              appClasses: decompiled.appClasses,
              libraryClasses: decompiled.libraryClasses,
              topLibraries: Object.entries(decompiled.libraries).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k} (${v})`),
              decompileErrors: decompiled.errors,
            }
          : jadxPath
            ? { decompileFailed: true }
            : { jadxInstall: installHint(JADX) }),
      },
    };
  }

  private addJsBundle(zip: ZipReader, e: ZipEntry, units: CodeUnit[], strings: ExtractedString[], warnings: string[], onHermes: () => void): void {
    let bytes: Uint8Array;
    try {
      bytes = zip.read(e, this.limits.maxJsBundleBytes);
    } catch (err) {
      warnings.push(`${e.name}: ${(err as Error).message}`);
      return;
    }
    if (HERMES_MAGIC.every((v, i) => bytes[i] === v)) {
      onHermes();
      units.push({ id: `js:${units.length}`, name: e.name, kind: "chunk", size: bytes.length, references: [], meta: { jsBundle: true, hermes: true, code: false } });
      return;
    }
    const src = new TextDecoder().decode(bytes);
    const sub = parseJsSource(src, e.name, bytes.length);
    const prefix = `js${units.length}`;
    const local = new Set(sub.units.map((u) => u.id));
    for (const u of sub.units) {
      units.push({
        ...u,
        id: `${prefix}/${u.id}`,
        name: `${e.name}#${u.name}`,
        references: u.references.filter((r) => local.has(r)).map((r) => `${prefix}/${r}`),
        meta: { ...u.meta, jsBundle: true, parent: e.name },
      });
    }
    for (const s of sub.strings) strings.push({ ...s, unitId: s.unitId ? `${prefix}/${s.unitId}` : undefined });
  }

  private async decompile(
    jadxPath: string,
    apkPath: string,
    manifest: ManifestInfo,
    units: CodeUnit[],
    strings: ExtractedString[],
    warnings: string[],
  ) {
    const out = mkdtempSync(join(tmpdir(), "ree-jadx-"));
    try {
      let errors = 0;
      let run: { stdout: string; stderr: string; code: number } = { stdout: "", stderr: "", code: 0 };
      try {
        const r = (run = await runTool(jadxPath, ["-d", out, "--no-res", "--threads-count", "2", "--log-level", "error", safeInputPath(apkPath)], {
          cwd: out,
          timeoutMs: Number(process.env.REE_JADX_TIMEOUT_MS) || this.limits.jadxTimeoutMs,
        }));
        errors = Number(/errors?,? count:\s*(\d+)/i.exec(r.stdout + r.stderr)?.[1] ?? (r.code !== 0 ? 1 : 0));
      } catch (e) {
        warnings.push(`jadx failed: ${(e as Error).message}; falling back to structure-only analysis`);
        return undefined;
      }
      if (errors) warnings.push(`jadx reported ${errors} class(es) it could not fully decompile`);

      const appPrefixes = [manifest.package, manifest.application?.replace(/\.[^.]+$/, "")].filter(Boolean) as string[];
      const isApp = (fqcn: string) => appPrefixes.length === 0 || appPrefixes.some((p) => fqcn === p || fqcn.startsWith(p + "."));
      const libraries: Record<string, number> = {};
      let libraryClasses = 0;
      let files = 0;
      let total = 0;
      const sourcesRoot = join(out, "sources");
      const appUnits: CodeUnit[] = [];

      const walk = (dir: string, depth: number) => {
        if (depth > 64 || files >= this.limits.maxJavaFiles) return;
        let names: string[];
        try {
          names = readdirSync(dir);
        } catch {
          return;
        }
        for (const n of names) {
          if (files >= this.limits.maxJavaFiles) return;
          const p = join(dir, n);
          const st = lstatSync(p);
          if (st.isSymbolicLink()) continue;
          if (st.isDirectory()) {
            walk(p, depth + 1);
            continue;
          }
          if (!n.endsWith(".java")) continue;
          files++;
          const fqcn = relative(sourcesRoot, p).slice(0, -5).split(sep).join(".");
          if (!isApp(fqcn)) {
            libraryClasses++;
            const top = fqcn.split(".").slice(0, 2).join(".");
            libraries[top] = (libraries[top] ?? 0) + 1;
            continue;
          }
          if (appUnits.length >= this.limits.maxAppClasses) continue;
          if (st.size > this.limits.maxJavaFileBytes || total + st.size > this.limits.maxJavaTotalBytes) {
            warnings.push(`${fqcn}: decompiled source too large; skipped`);
            continue;
          }
          total += st.size;
          const body = readFileSync(p, "utf8");
          appUnits.push({ id: `cls:${appUnits.length}`, name: fqcn, kind: "class", body, size: st.size, references: [], meta: { decompiler: "jadx", refToken: fqcn.split(".").pop() } });
        }
      };
      walk(sourcesRoot, 0);
      if (files === 0) {
        warnings.push(`jadx ran but produced no Java source (${toolError(run)}); falling back to structure-only analysis`);
        return undefined;
      }
      if (files >= this.limits.maxJavaFiles) warnings.push(`[anti-exhaust] stopped after ${this.limits.maxJavaFiles} decompiled files`);

      // Name-based references between the app's own classes (over-approximate).
      const bySimple = new Map<string, string>();
      for (const u of appUnits) bySimple.set(u.name.split(".").pop()!.split("$")[0]!, u.id);
      for (const u of appUnits) {
        const refs = new Set<string>();
        for (const m of (u.body ?? "").matchAll(/\b([A-Z][A-Za-z0-9_]{2,})\b/g)) {
          const id = bySimple.get(m[1]!);
          if (id && id !== u.id) refs.add(id);
        }
        u.references = [...refs];
        for (const m of (u.body ?? "").matchAll(/"((?:[^"\\\n]|\\.){4,160})"/g)) strings.push({ value: m[1]!, source: "literal", unitId: u.id });
      }
      units.push(...appUnits);
      return { appClasses: appUnits.length, libraryClasses, libraries, errors };
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }
}
