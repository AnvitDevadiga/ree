/**
 * iOS .ipa parser — structure only.
 *
 * Reads the app's Info.plist (identity, minimum iOS, privacy usage strings,
 * URL schemes, transport-security exceptions), lists frameworks and app
 * extensions, analyzes bundled JavaScript (React Native, Cordova, Capacitor),
 * and — for an unencrypted executable, such as a development or ad-hoc build of
 * your own app — reports the Mach-O structure.
 *
 * App Store binaries are encrypted (LC_ENCRYPTION_INFO with cryptid != 0).
 * REE detects that and reports that the code cannot be analyzed. It never
 * attempts decryption, never re-signs, and never repackages an app.
 */
import type { ArtifactModel, CodeUnit, EntryPoint, ExtractedString, Parser, ParserInput } from "../core/types.js";
import { classify } from "../core/detect.js";
import { ZipReader, type ZipEntry } from "./zip.js";
import { parsePlist, type PlistValue } from "./plist.js";
import { parseNativeStructure } from "./native.js";
import { parseJsSource } from "./js-bundle.js";
import { redactInjections } from "../anti-bla/sanitizer.js";

const MAX_EXECUTABLE_BYTES = 256 * 1024 * 1024;
const HERMES_MAGIC = [0xc6, 0x1f, 0xbc, 0x03];

export interface MachoEncryption {
  /** True when any architecture slice has cryptid != 0. */
  encrypted: boolean;
  slices: Array<{ cpu: string; cryptid: number | null }>;
}

const CPU: Record<number, string> = { 7: "x86", 0x01000007: "x86_64", 12: "arm", 0x0100000c: "arm64", 0x0200000c: "arm64_32" };

/** Inspect LC_ENCRYPTION_INFO(_64) in a thin or universal Mach-O. */
export function machoEncryption(b: Uint8Array): MachoEncryption {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const slices: MachoEncryption["slices"] = [];
  const thin = (off: number) => {
    if (off + 32 > b.length) return;
    const magic = dv.getUint32(off, false);
    const le = magic === 0xcffaedfe || magic === 0xcefaedfe;
    const is64 = magic === 0xcffaedfe || magic === 0xfeedfacf;
    if (![0xcffaedfe, 0xcefaedfe, 0xfeedfacf, 0xfeedface].includes(magic)) return;
    const u32 = (o: number) => dv.getUint32(o, le);
    const cpu = CPU[u32(off + 4)] ?? `cpu ${u32(off + 4)}`;
    const ncmds = Math.min(u32(off + 16), 4096);
    let p = off + (is64 ? 32 : 28);
    let cryptid: number | null = null;
    for (let i = 0; i < ncmds && p + 8 <= b.length; i++) {
      const cmd = u32(p);
      const size = u32(p + 4);
      if (size < 8) break;
      if ((cmd === 0x21 || cmd === 0x2c) && p + 20 <= b.length) cryptid = u32(p + 16);
      p += size;
    }
    slices.push({ cpu, cryptid });
  };
  if (b.length >= 8 && dv.getUint32(0, false) === 0xcafebabe) {
    const n = Math.min(dv.getUint32(4, false), 32);
    for (let i = 0; i < n; i++) {
      const a = 8 + i * 20;
      if (a + 20 > b.length) break;
      thin(dv.getUint32(a + 8, false));
    }
  } else thin(0);
  return { encrypted: slices.some((s) => (s.cryptid ?? 0) !== 0), slices };
}

const str = (v: PlistValue | undefined) => (typeof v === "string" ? redactInjections(v.slice(0, 300)).text : undefined);

export class IpaParser implements Parser {
  readonly format = "ipa" as const;

  canParse(input: ParserInput): boolean {
    const b = input.bytes;
    if (b.length < 4 || b[0] !== 0x50 || b[1] !== 0x4b || b[2] !== 0x03 || b[3] !== 0x04) return false;
    return classify(b.subarray(0, 64 * 1024), b.subarray(Math.max(0, b.length - 1024 * 1024))).kind === "ipa";
  }

  async parse(input: ParserInput): Promise<ArtifactModel> {
    const warnings: string[] = [];
    const units: CodeUnit[] = [];
    const strings: ExtractedString[] = [];
    const entryPoints: EntryPoint[] = [];
    const zip = new ZipReader(input.bytes);
    warnings.push(...zip.warnings);

    const appRoot = zip.entries.map((e) => /^Payload\/([^/]+\.app)\//.exec(e.name)?.[1]).find(Boolean);
    if (!appRoot) throw new Error("no Payload/<App>.app/ directory in this .ipa");
    const base = `Payload/${appRoot}/`;

    // ---- Info.plist -------------------------------------------------------
    let info: Record<string, PlistValue> = {};
    const plistEntry = zip.get(`${base}Info.plist`);
    if (plistEntry) {
      try {
        const v = parsePlist(zip.read(plistEntry, 8 * 1024 * 1024));
        if (v && typeof v === "object" && !Array.isArray(v)) info = v;
      } catch (e) {
        warnings.push(`Info.plist could not be read: ${(e as Error).message}`);
      }
    } else warnings.push("Info.plist is missing");
    const usage = Object.entries(info)
      .filter(([k, v]) => /^NS\w+UsageDescription$/.test(k) && typeof v === "string")
      .map(([k, v]) => `${k.replace(/^NS|UsageDescription$/g, "")}: ${str(v)}`);
    for (const [, v] of Object.entries(info)) if (typeof v === "string") strings.push({ value: v, source: "metadata" });
    const urlSchemes = (Array.isArray(info.CFBundleURLTypes) ? info.CFBundleURLTypes : [])
      .flatMap((t) => (t && typeof t === "object" && !Array.isArray(t) && Array.isArray(t.CFBundleURLSchemes) ? t.CFBundleURLSchemes : []))
      .filter((s): s is string => typeof s === "string")
      .map((s) => str(s)!);
    const ats = info.NSAppTransportSecurity;
    const allowsArbitraryLoads = !!(ats && typeof ats === "object" && !Array.isArray(ats) && ats.NSAllowsArbitraryLoads === true);

    // ---- main executable ----------------------------------------------------
    const exeName = typeof info.CFBundleExecutable === "string" ? info.CFBundleExecutable : appRoot.replace(/\.app$/, "");
    const exeEntry = zip.get(base + exeName);
    let encryption: MachoEncryption | undefined;
    if (!exeEntry) warnings.push(`main executable '${exeName}' not found in the bundle`);
    else {
      let exe: Uint8Array | undefined;
      try {
        exe = zip.read(exeEntry, MAX_EXECUTABLE_BYTES);
      } catch (e) {
        warnings.push(`main executable: ${(e as Error).message}`);
      }
      if (exe) {
        encryption = machoEncryption(exe);
        if (encryption.encrypted) {
          warnings.push("the main executable is encrypted (App Store FairPlay); REE does not decrypt it, so its code is not analyzed");
        } else {
          const native = parseNativeStructure({ path: `${input.path}!${exeName}`, bytes: exe, limits: input.limits });
          warnings.push(...native.warnings.map((w) => `${exeName}: ${w}`));
          for (const u of native.units) units.push({ ...u, id: `exe/${u.id}`, name: `${exeName}#${u.name}`, references: u.references.map((r) => `exe/${r}`), meta: { ...u.meta, parent: exeName } });
          for (const s of native.strings) strings.push({ ...s, unitId: s.unitId ? `exe/${s.unitId}` : undefined });
          const main = units.find((u) => /#_?main$/.test(u.name));
          if (main) entryPoints.push({ unitId: main.id, reason: "main", detail: `${exeName} main` });
        }
      }
    }

    // ---- frameworks, extensions, bundled JS ---------------------------------
    const frameworks = [...new Set(zip.entries.map((e) => new RegExp(`^${escapeRe(base)}Frameworks/([^/]+\\.(?:framework|dylib))`).exec(e.name)?.[1]).filter((x): x is string => !!x))];
    const extensions = [...new Set(zip.entries.map((e) => new RegExp(`^${escapeRe(base)}PlugIns/([^/]+\\.appex)/`).exec(e.name)?.[1]).filter((x): x is string => !!x))];
    const jsEntries = zip.entries.filter((e) => e.name.startsWith(base) && /(main\.jsbundle|\/(www|public)\/.+\.m?js)$/.test(e.name)).slice(0, 200);
    let hermes = 0;
    for (const e of jsEntries) this.addJs(zip, e, base, units, strings, warnings, () => hermes++);
    if (hermes) warnings.push(`${hermes} React Native bundle(s) are Hermes bytecode; listed, not decompiled`);

    return {
      format: "ipa",
      sourcePath: input.path,
      byteLength: input.bytes.length,
      units,
      strings,
      entryPoints,
      warnings,
      meta: {
        graphComplete: false,
        bundleId: str(info.CFBundleIdentifier),
        name: str(info.CFBundleDisplayName) ?? str(info.CFBundleName),
        version: str(info.CFBundleShortVersionString),
        build: str(info.CFBundleVersion),
        minimumOS: str(info.MinimumOSVersion),
        executable: exeName,
        encrypted: encryption?.encrypted ?? null,
        architectures: encryption?.slices.map((s) => `${s.cpu}${s.cryptid ? " (encrypted)" : ""}`) ?? [],
        usageDescriptions: usage,
        urlSchemes,
        allowsArbitraryLoads,
        frameworks,
        extensions,
        jsBundles: jsEntries.length,
        hermesBundles: hermes,
      },
    };
  }

  private addJs(zip: ZipReader, e: ZipEntry, base: string, units: CodeUnit[], strings: ExtractedString[], warnings: string[], onHermes: () => void): void {
    let bytes: Uint8Array;
    try {
      bytes = zip.read(e, 16 * 1024 * 1024);
    } catch (err) {
      warnings.push(`${e.name}: ${(err as Error).message}`);
      return;
    }
    const rel = e.name.slice(base.length);
    if (HERMES_MAGIC.every((v, i) => bytes[i] === v)) {
      onHermes();
      units.push({ id: `js:${units.length}`, name: rel, kind: "chunk", size: bytes.length, references: [], meta: { jsBundle: true, hermes: true, code: false } });
      return;
    }
    const sub = parseJsSource(new TextDecoder().decode(bytes), rel, bytes.length);
    const prefix = `js${units.length}`;
    const local = new Set(sub.units.map((u) => u.id));
    for (const u of sub.units) {
      units.push({ ...u, id: `${prefix}/${u.id}`, name: `${rel}#${u.name}`, references: u.references.filter((r) => local.has(r)).map((r) => `${prefix}/${r}`), meta: { ...u.meta, jsBundle: true, parent: rel } });
    }
    for (const s of sub.strings) strings.push({ ...s, unitId: s.unitId ? `${prefix}/${s.unitId}` : undefined });
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
