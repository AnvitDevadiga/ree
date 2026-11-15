/**
 * `.dmg` / `.app` front-end.
 *
 * REE's parsers work on single artifacts; a shipped macOS app is a disk image
 * wrapping a bundle wrapping many artifacts. This module bridges the gap:
 *
 *   analyzeApp(path)  — path is a .dmg, a .app, or any extracted directory.
 *     - .dmg : mount read-only with hdiutil (macOS only), walk, detach.
 *     - .app / dir : walk directly (any platform).
 *
 * Each discovered artifact (Electron asar, main Mach-O, dylibs) is run through
 * the ordinary analyze() pipeline, so every anti-BLA defense applies uniformly.
 * REE never executes the target — the image is mounted read-only and only read.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join, extname, basename } from "node:path";
import { analyze, type AnalyzeOptions, type AnalyzeResult } from "../core/analyze.js";
import {
  collectAppArtifacts,
  findAppBundles,
  roleLabel,
  type ArtifactRole,
  type BundleArtifact,
} from "./appbundle.js";

export interface AppArtifactResult {
  path: string;
  role: ArtifactRole;
  roleLabel: string;
  size: number;
  result?: AnalyzeResult;
  error?: string;
}

export interface AppAnalysis {
  source: string;
  kind: "dmg" | "app" | "directory";
  mounted?: string;
  bundles: string[];
  artifacts: AppArtifactResult[];
  warnings: string[];
}

export interface AppAnalyzeOptions extends AnalyzeOptions {
  /** Cap on how many inner artifacts to analyze (richest first). Default 12. */
  maxArtifacts?: number;
}

/** True when `.dmg` mounting is possible on this host. */
export function canMountDmg(): boolean {
  return platform() === "darwin";
}

/**
 * Mount a read-only dmg, await `fn` against the mount point, and always detach.
 * The detach only runs after the (async) work completes, so analysis never reads
 * from an unmounted image. macOS-only; throws a clear error elsewhere.
 */
export async function withMountedDmg<T>(dmgPath: string, fn: (mountPoint: string) => Promise<T> | T): Promise<T> {
  if (!canMountDmg()) {
    throw new Error(`mounting .dmg requires macOS (hdiutil); this host is ${platform()}. Extract the .app and point REE at it instead.`);
  }
  const mountPoint = mkdtempSync(join(tmpdir(), "ree-dmg-"));
  let attached = false;
  try {
    execFileSync(
      "hdiutil",
      ["attach", "-nobrowse", "-readonly", "-noverify", "-noautoopen", "-mountpoint", mountPoint, dmgPath],
      { stdio: "ignore", timeout: 120_000 },
    );
    attached = true;
    return await fn(mountPoint);
  } finally {
    if (attached) {
      try {
        execFileSync("hdiutil", ["detach", "-force", mountPoint], { stdio: "ignore", timeout: 60_000 });
      } catch {
        /* best-effort detach */
      }
    }
    rmSync(mountPoint, { recursive: true, force: true });
  }
}

async function analyzeArtifacts(arts: BundleArtifact[], opts: AppAnalyzeOptions): Promise<AppArtifactResult[]> {
  const out: AppArtifactResult[] = [];
  for (const a of arts) {
    const entry: AppArtifactResult = { path: a.path, role: a.role, roleLabel: roleLabel(a.role), size: a.size };
    try {
      entry.result = await analyze(a.path, opts);
    } catch (err) {
      entry.error = (err as Error).message;
    }
    out.push(entry);
  }
  return out;
}

async function analyzeRoot(root: string, kind: AppAnalysis["kind"], source: string, opts: AppAnalyzeOptions): Promise<AppAnalysis> {
  const warnings: string[] = [];
  const bundles = findAppBundles(root);
  // Analyze each .app bundle's artifacts; if none, treat the root itself as a bundle.
  const scanRoots = bundles.length ? bundles : [root];
  const arts: BundleArtifact[] = [];
  for (const b of scanRoots) {
    arts.push(...collectAppArtifacts(b, { maxDepth: 12, maxEntries: 200_000, maxArtifacts: opts.maxArtifacts ?? 12 }));
  }
  if (arts.length === 0) warnings.push("no analyzable artifacts (.asar, Mach-O, .dylib) found in the bundle");
  const artifacts = await analyzeArtifacts(arts.slice(0, opts.maxArtifacts ?? 12), opts);
  return { source, kind, bundles, artifacts, warnings };
}

/**
 * Analyze a `.dmg`, a `.app`, or an extracted directory. Returns one
 * AnalyzeResult per discovered inner artifact.
 */
export async function analyzeApp(path: string, opts: AppAnalyzeOptions = {}): Promise<AppAnalysis> {
  const ext = extname(path).toLowerCase();
  let st;
  try {
    st = statSync(path);
  } catch {
    throw new Error(`cannot read ${path}`);
  }

  if (st.isFile() && ext === ".dmg") {
    const analysis = await withMountedDmg(path, (mount) => analyzeRoot(mount, "dmg", path, opts));
    analysis.mounted = "(read-only, detached)";
    return analysis;
  }
  if (st.isDirectory()) {
    const kind: AppAnalysis["kind"] = ext === ".app" ? "app" : "directory";
    return analyzeRoot(path, kind, path, opts);
  }
  throw new Error(`unsupported app target: ${basename(path)} (expected a .dmg, a .app, or a directory)`);
}
