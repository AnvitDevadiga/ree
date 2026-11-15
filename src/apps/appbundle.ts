/**
 * Application-bundle walker.
 *
 * A macOS `.app` (and the `.dmg` that ships it) is a *container*, not a single
 * parseable artifact. This module walks a bundle directory and picks out the
 * artifacts REE can actually analyze — the Electron `app.asar`, the main Mach-O
 * executable, and bundled dylibs/frameworks — so each can be routed through the
 * ordinary `analyze()` pipeline. It is pure filesystem traversal with hard caps,
 * so it works on any platform against an already-extracted bundle; the `.dmg`
 * mount step (macOS-only) lives in `dmg.ts`.
 */
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, basename, extname } from "node:path";

export type ArtifactRole = "electron-asar" | "main-executable" | "dylib" | "nested-asar" | "plist";

export interface BundleArtifact {
  path: string;
  role: ArtifactRole;
  /** Bytes, for ordering/reporting. */
  size: number;
}

export interface WalkLimits {
  maxDepth: number;
  maxEntries: number;
  maxArtifacts: number;
}

export const DEFAULT_WALK_LIMITS: WalkLimits = { maxDepth: 12, maxEntries: 200_000, maxArtifacts: 64 };

// Mach-O (incl. fat/universal) and ELF magic. A macOS app's main binary is
// Mach-O, but a bundle built/extracted on Linux carries an ELF main executable,
// so both count — and the parser handles either.
const MACHO_MAGIC = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);
const ELF_MAGIC = 0x7f454c46; // \x7fELF

/** Cheap native-executable check: read the 4-byte magic (Mach-O or ELF). */
function isNativeExecutable(path: string): boolean {
  try {
    const fd = readFileSync(path, { flag: "r" }).subarray(0, 4);
    if (fd.length < 4) return false;
    const be = ((fd[0]! << 24) | (fd[1]! << 16) | (fd[2]! << 8) | fd[3]!) >>> 0;
    return MACHO_MAGIC.has(be) || be === ELF_MAGIC;
  } catch {
    return false;
  }
}

/**
 * Collect analyzable artifacts under a bundle or arbitrary directory. Results are
 * ordered by role priority (asar first — it's the richest recovery), then size.
 */
export function collectAppArtifacts(root: string, limits: WalkLimits = DEFAULT_WALK_LIMITS): BundleArtifact[] {
  const found: BundleArtifact[] = [];
  let entries = 0;

  const walk = (dir: string, depth: number): void => {
    if (depth > limits.maxDepth || entries >= limits.maxEntries || found.length >= limits.maxArtifacts) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (entries >= limits.maxEntries || found.length >= limits.maxArtifacts) return;
      entries++;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!st.isFile()) continue;
      const ext = extname(name).toLowerCase();
      if (ext === ".asar") {
        found.push({ path: full, role: name === "app.asar" ? "electron-asar" : "nested-asar", size: st.size });
      } else if (ext === ".dylib" || ext === ".so") {
        found.push({ path: full, role: "dylib", size: st.size });
      } else if (ext === "" && st.size > 0 && isNativeExecutable(full)) {
        found.push({ path: full, role: "main-executable", size: st.size });
      }
    }
  };

  walk(root, 0);

  const priority: Record<ArtifactRole, number> = {
    "electron-asar": 0,
    "main-executable": 1,
    "nested-asar": 2,
    dylib: 3,
    plist: 4,
  };
  return found.sort((a, b) => priority[a.role] - priority[b.role] || b.size - a.size).slice(0, limits.maxArtifacts);
}

/** Find `.app` bundles directly under a directory (e.g. a mounted dmg root). */
export function findAppBundles(root: string): string[] {
  try {
    return readdirSync(root)
      .filter((n) => n.toLowerCase().endsWith(".app"))
      .map((n) => join(root, n))
      .filter((p) => {
        try {
          return statSync(p).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

/** Human label for an artifact role. */
export function roleLabel(role: ArtifactRole): string {
  switch (role) {
    case "electron-asar":
      return "Electron app.asar";
    case "nested-asar":
      return "nested .asar";
    case "main-executable":
      return "main Mach-O executable";
    case "dylib":
      return "bundled library";
    case "plist":
      return "property list";
  }
}

export { basename };
