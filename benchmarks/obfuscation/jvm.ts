/**
 * JVM / Android half of the protection benchmark: R8 (Google's Android
 * shrinker/obfuscator, BSD-3-Clause, the default for Android release builds).
 *
 * The ground-truth inventory CLI JAR is processed by R8 with a standard keep
 * rule for its entry point, producing:
 *   r8-classfile — shrunk + renamed JVM bytecode → REE's JAR path (Vineflower)
 *   r8-dex       — the same as Android DEX inside an APK container → REE's
 *                  APK path (jadx)
 * R8 is downloaded from Google Maven, SHA-256 pinned, into a gitignored cache,
 * and run with a local JDK. Everything skips cleanly if either is missing.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze } from "../../src/core/analyze.js";
import { normalizeLiterals, redactInjections } from "../../src/anti-bla/sanitizer.js";
import { ghidraEnv } from "../../src/tools/ghidra.js";
import { which } from "../../src/tools/external.js";
import { buildInventoryJar, INVENTORY_TRUTH } from "../fixtures/java.js";
import type { Row } from "./run.js";

const here = dirname(fileURLToPath(import.meta.url));
const work = join(here, ".cache", "jvm");
export const R8 = {
  version: "9.5.33",
  license: "BSD-3-Clause",
  url: "https://dl.google.com/android/maven2/com/android/tools/r8/9.5.33/r8-9.5.33.jar",
  sha256: "9743e95de295fb6f5490e21da26536e4d0921809511423122ff20328a572e7f5",
};

/** Ground-truth string literals of the inventory CLI (excluding the planted one). */
const TRUTH_LITERALS = ["qty must be positive", "total: "];
const KEEP_RULES = "-keep class org.ree.fixture.inventory.Main { public static void main(java.lang.String[]); }\n-dontwarn java.**\n";

async function r8Jar(): Promise<string | null> {
  const p = join(here, "..", "fixtures", ".cache", "tools", `r8-${R8.version}.jar`);
  if (!existsSync(p)) {
    try {
      const res = await fetch(R8.url);
      if (!res.ok) return null;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, Buffer.from(await res.arrayBuffer()));
    } catch {
      return null;
    }
  }
  return createHash("sha256").update(readFileSync(p)).digest("hex") === R8.sha256 ? p : null;
}

export async function runJvmBench(): Promise<{ rows: Row[]; skipped?: string }> {
  const jar = buildInventoryJar();
  if (!jar) return { rows: [], skipped: "no JDK to build the ground-truth JAR" };
  const env = ghidraEnv(); // a real JDK, not the macOS stub
  const java = env.JAVA_HOME ? join(env.JAVA_HOME, "bin", "java") : which("java");
  const r8 = await r8Jar();
  if (!java || !env.JAVA_HOME || !r8) return { rows: [], skipped: !r8 ? "R8 unavailable (offline?)" : "no JDK found" };

  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const rules = join(work, "rules.pro");
  writeFileSync(rules, KEEP_RULES);
  const r8run = (args: string[]) =>
    execFileSync(java, ["-cp", r8, "com.android.tools.r8.R8", "--release", "--pg-conf", rules, "--lib", env.JAVA_HOME!, ...args, jar], { stdio: "ignore", timeout: 300_000 });

  const classfile = join(work, "inventory.r8.jar");
  r8run(["--classfile", "--output", classfile]);
  const dexZip = join(work, "inventory.r8.dex.zip");
  r8run(["--output", dexZip, "--min-api", "24"]);
  // Package the DEX as an APK container (no resources; REE reads the manifest if present).
  const apk = join(work, "inventory.r8.apk");
  const stage = join(work, "apk");
  mkdirSync(stage, { recursive: true });
  execFileSync("unzip", ["-q", "-o", dexZip, "-d", stage]);
  writeFileSync(join(stage, "AndroidManifest.xml"), Buffer.from([0x03, 0, 8, 0, 8, 0, 0, 0]));
  execFileSync("zip", ["-q", "-r", apk, "AndroidManifest.xml", "classes.dex"], { cwd: stage, stdio: "ignore" });

  const rows: Row[] = [];
  for (const [protection, file] of [["none (jar)", jar], ["r8-classfile", classfile], ["r8-dex (apk)", apk]] as const) {
    const r = await analyze(file);
    const m = r.report.model;
    const text = normalizeLiterals(r.slices.map((s) => s.content).join("\n")).text;
    const visible = TRUTH_LITERALS.filter((l) => text.includes(l)).length;
    const decompiler = (m.meta as { decompiler?: string }).decompiler ?? "none";
    const methods = Object.values(INVENTORY_TRUTH.methods).flat();
    const namesVisible = methods.filter((n) => new RegExp(`\\b${n}\\s*\\(`).test(text)).length;
    const leaks = redactInjections(text).count + (text.includes("ignore previous instructions") ? 1 : 0);
    const entry = m.entryPoints.some((e) => /Main/.test(e.detail ?? "") || m.units.find((u) => u.id === e.unitId)?.name.endsWith(".Main"));
    const reasons: string[] = [];
    // External tools are optional: without jadx an APK's code isn't modeled, which is
    // documented behavior, not a regression. Report the row as skipped.
    const toolMissing = protection === "r8-dex (apk)" && decompiler === "none" ? "jadx not installed (optional)" : undefined;
    if (!m.units.length && !toolMissing) reasons.push("nothing modeled");
    if (leaks) reasons.push(`${leaks} leak(s)`);
    if (visible < TRUTH_LITERALS.length && decompiler !== "none") reasons.push(`literals ${visible}/${TRUTH_LITERALS.length}`);
    if (protection !== "r8-dex (apk)" && !entry) reasons.push("kept entry point not found");
    rows.push({
      source: "inventory-cli (jvm)",
      protection: `${protection} [${decompiler}]`,
      bytes: readFileSync(file).length,
      parsed: m.units.length > 0,
      units: m.units.length,
      literals: `${visible}/${TRUTH_LITERALS.length} · names ${namesVisible}/${methods.length}`,
      literalRatio: visible / TRUTH_LITERALS.length,
      decoder: false,
      leaks,
      naiveTokens: 0,
      reeTokens: r.slices.reduce((n, s) => n + s.estTokens, 0),
      gate: reasons.length ? "fail" : toolMissing && !m.units.length ? "skip" : "pass",
      gateReason: reasons.join("; ") || (toolMissing && !m.units.length ? toolMissing : undefined),
    });
  }
  return { rows };
}
