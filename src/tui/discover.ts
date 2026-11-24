/**
 * Find things on this machine that REE can open, so a user picks from a list
 * instead of typing a path.
 *
 * Bounded on every axis — depth, directory entries visited, results and wall
 * time — never follows symlinked directories, never descends into dependency
 * folders, hidden folders or app bundles, and only reads directory listings and
 * file sizes (never file contents).
 */
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";

export interface Candidate {
  path: string;
  name: string;
  /** Human label for the kind, e.g. "Android app". */
  kind: string;
  /** Where it was found, e.g. "Downloads". */
  where: string;
  size: number;
  mtimeMs: number;
  isDir: boolean;
}

export interface Root {
  dir: string;
  label: string;
  depth: number;
  /** Only report these kinds here (e.g. only `.app` bundles in /Applications). */
  only?: string[];
}

export interface DiscoverOptions {
  roots?: Root[];
  maxEntries?: number;
  maxResults?: number;
  timeBudgetMs?: number;
  now?: () => number;
}

const EXT_KINDS: Record<string, string> = {
  ".dmg": "macOS disk image",
  ".asar": "Electron app archive",
  ".apk": "Android app",
  ".aab": "Android app bundle",
  ".xapk": "Android app",
  ".ipa": "iOS app",
  ".jar": "Java archive",
  ".war": "Java web archive",
  ".dll": ".NET / Windows library",
  ".exe": "Windows program",
  ".wasm": "WebAssembly module",
  ".pyc": "Python bytecode",
  ".so": "Linux library",
  ".dylib": "macOS library",
  ".appimage": "Linux app",
  ".node": "Native Node addon",
};
const SCRIPT_KINDS: Record<string, string> = { ".js": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript" };

const SKIP_DIRS = new Set(["node_modules", "Library", "AppData", "__pycache__", "venv", ".venv", "site-packages", "Pods", "build", "dist", "target", "$RECYCLE.BIN", "System Volume Information"]);

/** What kind of openable thing a name is, or null. Scripts only count where `scripts` is set. */
export function kindOf(name: string, isDir: boolean, scripts = false): string | null {
  if (isDir) return /\.app$/i.test(name) ? "macOS app" : null;
  const ext = extname(name).toLowerCase();
  if (EXT_KINDS[ext]) return EXT_KINDS[ext]!;
  if (scripts && SCRIPT_KINDS[ext]) return SCRIPT_KINDS[ext]!;
  return null;
}

export function defaultRoots(platform: NodeJS.Platform = process.platform, home = homedir(), cwd = process.cwd()): Root[] {
  const roots: Root[] = [
    { dir: cwd, label: "This folder", depth: 2 },
    { dir: join(home, "Downloads"), label: "Downloads", depth: 2 },
    { dir: join(home, "Desktop"), label: "Desktop", depth: 2 },
    { dir: join(home, "Documents"), label: "Documents", depth: 1 },
  ];
  if (platform === "darwin") {
    roots.push({ dir: "/Applications", label: "Applications", depth: 1, only: ["macOS app"] });
    roots.push({ dir: join(home, "Applications"), label: "Applications", depth: 1, only: ["macOS app"] });
  }
  // De-duplicate (cwd is often home/Downloads).
  const seen = new Set<string>();
  return roots.filter((r) => (seen.has(r.dir) ? false : (seen.add(r.dir), true)));
}

export function discoverCandidates(opts: DiscoverOptions = {}): { candidates: Candidate[]; truncated: boolean } {
  const roots = opts.roots ?? defaultRoots();
  const maxEntries = opts.maxEntries ?? 20_000;
  const maxResults = opts.maxResults ?? 400;
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.timeBudgetMs ?? 1500);
  const out: Candidate[] = [];
  const seen = new Set<string>();
  let visited = 0;
  let truncated = false;

  const walk = (dir: string, depth: number, root: Root, top: boolean) => {
    if (truncated) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable or missing: skip silently
    }
    for (const e of entries) {
      if (++visited > maxEntries || out.length >= maxResults || now() > deadline) {
        truncated = true;
        return;
      }
      const name = e.name;
      if (name.startsWith(".")) continue;
      if (e.isSymbolicLink()) continue; // never follow links (loops, escapes)
      const full = join(dir, name);
      const isDir = e.isDirectory();
      const kind = kindOf(name, isDir, root.label === "This folder" && top);
      if (kind && (!root.only || root.only.includes(kind)) && !seen.has(full)) {
        seen.add(full);
        let size = 0;
        let mtimeMs = 0;
        try {
          const st = statSync(full);
          size = isDir ? 0 : st.size;
          mtimeMs = st.mtimeMs;
        } catch {
          continue;
        }
        if (!isDir && size === 0) continue;
        out.push({ path: full, name, kind, where: root.label, size, mtimeMs, isDir });
        continue; // never descend into an app bundle
      }
      if (isDir && depth > 1 && !SKIP_DIRS.has(name)) walk(full, depth - 1, root, false);
    }
  };

  for (const r of roots) {
    if (truncated) break;
    walk(r.dir, r.depth, r, true);
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { candidates: out, truncated };
}

/** Case-insensitive fuzzy filter: every query character must appear in order. */
export function filterCandidates(list: Candidate[], query: string): Candidate[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  const words = q.split(/\s+/);
  return list.filter((c) => {
    const hay = `${c.name} ${c.kind} ${c.where}`.toLowerCase();
    return words.every((w) => hay.includes(w) || subsequence(w, basename(c.path).toLowerCase()));
  });
}

function subsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (const ch of hay) if (ch === needle[i]) i++;
  return i === needle.length;
}

export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
