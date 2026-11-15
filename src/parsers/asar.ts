/**
 * Electron `.asar` archive parser.
 *
 * Layout: two Chromium "pickles" followed by file contents.
 *   bytes 0..3   uint32  size of pickle #1 payload (always 4)
 *   bytes 4..7   uint32  size of pickle #2 (the header pickle)
 *   bytes 8..11  uint32  pickle #2 payload size
 *   bytes 12..15 uint32  JSON string length
 *   bytes 16..   JSON header (a tree of directories/files with offsets/sizes)
 *   content region starts at 8 + size-of-pickle-#2
 *
 * Each file becomes a CodeUnit. Text files get bodies; references between files
 * come from relative `require`/`import`, bare package specifiers resolved through
 * bundled `node_modules`, and file names mentioned in string literals (Electron
 * loads preload scripts, workers, and HTML by path, not by `require`).
 *
 * Anti-Exhaust: header size and tree depth are bounded by ParserLimits, so an
 * inflated header or a deeply nested tree is reported rather than followed.
 */
import { DEFAULT_LIMITS, type ArtifactModel, type CodeUnit, type EntryPoint, type ExtractedString, type Parser, type ParserInput } from "../core/types.js";
import { ByteReader } from "./reader.js";

interface AsarNode {
  offset?: string;
  size?: number;
  unpacked?: boolean;
  files?: Record<string, AsarNode>;
  link?: string;
}

const CODE_EXT = /\.(js|cjs|mjs|jsx|ts|tsx|html?)$/i;
const TEXT_EXT = /\.(js|cjs|mjs|jsx|ts|tsx|json|html?|css|txt|md)$/i;
const MAX_TEXT_FILE = 4 * 1024 * 1024;

export class AsarParser implements Parser {
  readonly format = "asar" as const;

  canParse(input: ParserInput): boolean {
    if (input.path.toLowerCase().endsWith(".asar")) return true;
    const b = input.bytes;
    if (b.length < 17) return false;
    const r = new ByteReader(b);
    return r.u32() === 4 && b[16] === 0x7b;
  }

  async parse(input: ParserInput): Promise<ArtifactModel> {
    const limits = input.limits ?? DEFAULT_LIMITS;
    const warnings: string[] = [];
    const r = new ByteReader(input.bytes);
    r.u32(); // pickle #1 payload size
    const headerPickleSize = r.u32();
    r.u32(); // pickle #2 payload size
    const strLen = r.u32();
    const contentBase = 8 + headerPickleSize;

    const empty = (msg: string): ArtifactModel => ({
      format: "asar", sourcePath: input.path, byteLength: input.bytes.length, units: [], strings: [], entryPoints: [],
      warnings: [...warnings, msg], meta: { graphComplete: false },
    });

    if (strLen > limits.maxHeaderBytes) {
      return empty(`[anti-exhaust] header declares ${strLen} bytes (> hard cap ${limits.maxHeaderBytes}); refusing to decode`);
    }
    if (strLen > limits.suspiciousHeaderBytes) {
      warnings.push(`[anti-exhaust] header is ${strLen} bytes (> ${limits.suspiciousHeaderBytes}); decoding with depth/entry caps — likely inflated`);
    }
    if (16 + strLen > input.bytes.length) return empty("header length exceeds file size");

    let header: AsarNode;
    try {
      header = JSON.parse(new TextDecoder().decode(input.bytes.subarray(16, 16 + strLen)));
    } catch (e) {
      return empty(`header JSON parse failed: ${(e as Error).message}`);
    }

    const units: CodeUnit[] = [];
    const strings: ExtractedString[] = [];
    let maxDepthSeen = 0;
    let depthCapped = false;
    let sourceMaps = 0;

    const walkTree = (node: AsarNode, path: string, depth: number): void => {
      maxDepthSeen = Math.max(maxDepthSeen, depth);
      if (depth > limits.maxDepth) {
        depthCapped = true;
        return;
      }
      if (units.length >= limits.maxUnits) return;
      if (node.files) {
        for (const [name, child] of Object.entries(node.files)) walkTree(child, path ? `${path}/${name}` : name, depth + 1);
        return;
      }
      if (node.link) return; // symlink entry
      const size = node.size ?? 0;
      let body: string | undefined;
      if (/\.map$/i.test(path)) {
        sourceMaps++;
      } else if (node.unpacked) {
        // lives in app.asar.unpacked/, outside this file
      } else if (node.offset !== undefined && TEXT_EXT.test(path) && size <= MAX_TEXT_FILE) {
        const start = contentBase + Number(node.offset);
        if (Number.isFinite(start) && start + size <= input.bytes.length) {
          body = new TextDecoder().decode(input.bytes.subarray(start, start + size));
        } else {
          warnings.push(`entry points outside the archive: ${path}`);
        }
      }
      units.push({
        id: `asar:${units.length}`,
        name: path,
        kind: "module",
        body,
        size,
        references: [],
        meta: { code: CODE_EXT.test(path), unpacked: !!node.unpacked, refToken: basename(path) },
      });
    };
    walkTree(header, "", 0);

    if (depthCapped) warnings.push(`[anti-exhaust] directory tree deeper than ${limits.maxDepth}; deeper entries skipped`);
    else if (maxDepthSeen > 32) warnings.push(`directory tree depth ${maxDepthSeen} exceeds 32 — consistent with a nesting trap`);
    if (units.length >= limits.maxUnits) warnings.push(`entry cap ${limits.maxUnits} reached; remaining entries skipped`);
    if (sourceMaps) warnings.push(`${sourceMaps} source map(s) present and excluded from analysis (source maps may be decoys)`);

    resolveReferences(units);
    for (const u of units) if (u.body) collectStrings(u.body, u.id, strings);

    return {
      format: "asar",
      sourcePath: input.path,
      byteLength: input.bytes.length,
      units,
      strings,
      entryPoints: findEntryPoints(units),
      warnings,
      meta: { entryCount: units.length, maxDepth: maxDepthSeen, graphComplete: true },
    };
  }
}

// ---------------------------------------------------------------------------
// reference resolution
// ---------------------------------------------------------------------------
function resolveReferences(units: CodeUnit[]): void {
  const byPath = new Map(units.map((u) => [u.name, u]));
  const byBase = new Map<string, CodeUnit[]>();
  for (const u of units) {
    const b = basename(u.name);
    const list = byBase.get(b);
    if (list) list.push(u);
    else byBase.set(b, [u]);
  }

  for (const u of units) {
    if (!u.body) continue;
    const refs = new Set<string>();
    for (const spec of moduleSpecifiers(u.body)) {
      const target = spec.startsWith(".") || spec.startsWith("/")
        ? resolveRelative(u.name, spec, byPath)
        : resolvePackage(u.name, spec, byPath);
      if (target && target.id !== u.id) refs.add(target.id);
    }
    // File names mentioned in string literals (preload scripts, workers, HTML, src=).
    const re = /["'`/]([\w.-]+\.(?:js|cjs|mjs|html?|json))["'`?#]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(u.body))) {
      for (const t of byBase.get(m[1]!) ?? []) if (t.id !== u.id) refs.add(t.id);
    }
    u.references = [...refs];
  }
}

function moduleSpecifiers(src: string): string[] {
  const out = new Set<string>();
  const re = /(?:require\(\s*|from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.add(m[1]!);
  return [...out];
}

function resolveRelative(from: string, spec: string, byPath: Map<string, CodeUnit>): CodeUnit | undefined {
  return resolveFile(joinPath(dirname(from), spec), byPath);
}

function resolvePackage(from: string, spec: string, byPath: Map<string, CodeUnit>): CodeUnit | undefined {
  if (spec.startsWith("node:")) return undefined;
  let dir = dirname(from);
  for (;;) {
    const base = joinPath(dir, `node_modules/${spec}`);
    const pkg = byPath.get(`${base}/package.json`);
    if (pkg?.body) {
      try {
        const main = (JSON.parse(pkg.body) as { main?: string }).main;
        if (main) {
          const hit = resolveFile(joinPath(base, main), byPath);
          if (hit) return hit;
        }
      } catch {
        /* malformed package.json */
      }
    }
    const hit = resolveFile(base, byPath);
    if (hit) return hit;
    if (!dir) return undefined;
    dir = dirname(dir);
  }
}

function resolveFile(p: string, byPath: Map<string, CodeUnit>): CodeUnit | undefined {
  for (const cand of [p, `${p}.js`, `${p}.cjs`, `${p}.mjs`, `${p}.json`, `${p}/index.js`]) {
    const hit = byPath.get(cand);
    if (hit) return hit;
  }
  return undefined;
}

function findEntryPoints(units: CodeUnit[]): EntryPoint[] {
  const byPath = new Map(units.map((u) => [u.name, u]));
  const pkg = byPath.get("package.json");
  if (pkg?.body) {
    try {
      const main = (JSON.parse(pkg.body) as { main?: string }).main ?? "index.js";
      const hit = resolveFile(joinPath("", main), byPath);
      if (hit) return [{ unitId: hit.id, reason: "declared", detail: `package.json main: ${main}` }];
    } catch {
      /* fall through */
    }
  }
  const fallback = units.find((u) => /^(main|index)\.(js|cjs|mjs)$/.test(u.name));
  return fallback ? [{ unitId: fallback.id, reason: "main", detail: fallback.name }] : [];
}

// ---------------------------------------------------------------------------
// path helpers (asar paths are always posix)
// ---------------------------------------------------------------------------
function basename(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

function joinPath(a: string, b: string): string {
  const stack: string[] = [];
  for (const part of `${a}/${b}`.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

function collectStrings(src: string, unitId: string, out: ExtractedString[]): void {
  const re = /["'`]([^"'`\n]{4,120})["'`]/g;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(src)) && n < 200) {
    out.push({ value: m[1]!, source: "literal", unitId });
    n++;
  }
}
