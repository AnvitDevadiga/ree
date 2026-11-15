/**
 * JS bundle parser.
 *
 * Uses acorn to build a real AST, then recovers logical units. It understands
 * the two shapes that dominate shipped bundles:
 *   1. Webpack-style module registries: an object keyed by numeric/path ids, or
 *      an array, of `function(module, exports, require){...}` factories.
 *   2. Flat scripts / ES modules: top-level function and class declarations,
 *      plus a synthetic `<top-level>` unit holding every other top-level
 *      statement (that is where execution actually starts).
 *
 * References are resolved to unit ids so the reachability pass works on a real
 * graph: registry modules link through `require(<id>)`, flat units link through
 * any identifier reference to another top-level name (calls *and* callbacks such
 * as `app.whenReady().then(createWindow)`). Identifier matching over-approximates
 * edges, which errs on the side of keeping code rather than pruning it.
 */
import * as acorn from "acorn";
import * as walk from "acorn-walk";
import type { ArtifactModel, CodeUnit, EntryPoint, ExtractedString, Parser, ParserInput } from "../core/types.js";

type AnyNode = acorn.Node & Record<string, any>;

export class JsBundleParser implements Parser {
  readonly format = "js-bundle" as const;

  canParse(input: ParserInput): boolean {
    return /\.(js|cjs|mjs|jsx)$/i.test(input.path) || looksLikeJs(input.bytes);
  }

  async parse(input: ParserInput): Promise<ArtifactModel> {
    const src = new TextDecoder().decode(input.bytes);
    return parseJsSource(src, input.path, input.bytes.length);
  }
}

/** Parse JS source text into an ArtifactModel. Exported for reuse by the asar parser. */
export function parseJsSource(src: string, path: string, byteLength: number): ArtifactModel {
  const warnings: string[] = [];
  const comments: acorn.Comment[] = [];
  const ast = parseProgram(src, warnings, comments);
  if (!ast) return flatFallback(path, byteLength, src, warnings);

  const registry = findModuleRegistry(ast);
  const model =
    registry.length > 0 ? buildRegistryModel(ast, src, registry) : buildFlatModel(ast, src, comments);
  if (!model) return flatFallback(path, byteLength, src, warnings);

  const strings: ExtractedString[] = [];
  for (const u of model.units) if (u.body) collectStrings(u.body, u.id, strings);

  return {
    format: "js-bundle",
    sourcePath: path,
    byteLength,
    units: model.units,
    strings,
    entryPoints: model.entryPoints,
    warnings,
    meta: { moduleCount: model.units.length, registryDetected: registry.length > 0, graphComplete: true },
  };
}

export function parseProgram(src: string, warnings: string[] = [], comments?: acorn.Comment[]): AnyNode | null {
  const base = { ecmaVersion: "latest" as const, allowReturnOutsideFunction: true, allowHashBang: true };
  const collect = () => (comments ? { onComment: (comments.length = 0, comments) } : {});
  try {
    return acorn.parse(src, { ...base, ...collect(), sourceType: "module", allowAwaitOutsideFunction: true }) as AnyNode;
  } catch {
    try {
      return acorn.parse(src, { ...base, ...collect(), sourceType: "script" }) as AnyNode;
    } catch (e) {
      warnings.push(`acorn parse failed: ${(e as Error).message}`);
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Webpack-style registries
// ---------------------------------------------------------------------------
interface ModuleEntry {
  key: string;
  node: AnyNode;
  requires: string[];
}

function buildRegistryModel(ast: AnyNode, src: string, registry: ModuleEntry[]) {
  const units: CodeUnit[] = registry.map((mod) => ({
    id: `mod:${mod.key}`,
    name: `module[${mod.key}]`,
    kind: "module",
    body: src.slice(mod.node.start, mod.node.end),
    offset: mod.node.start,
    size: mod.node.end - mod.node.start,
    references: mod.requires.map((rq) => `mod:${rq}`),
    meta: { registry: true, key: mod.key, refToken: mod.key },
  }));
  const ids = new Set(units.map((u) => u.id));
  for (const u of units) u.references = u.references.filter((r) => ids.has(r) && r !== u.id);

  const spans = registry.map((m) => [m.node.start, m.node.end] as const);
  const entryKeys = findBootstrapEntryKeys(ast, spans).filter((k) => ids.has(`mod:${k}`));
  const entryPoints: EntryPoint[] = entryKeys.map((k) => ({ unitId: `mod:${k}`, reason: "declared", detail: `bootstrap require(${k})` }));
  return { units, entryPoints };
}

/**
 * Find the module registry. Candidates are object literals whose keys look like
 * module ids (numbers or paths) or arrays, where most values are factory
 * functions. Only the single largest candidate is used, so ordinary objects of
 * methods inside user code are never mistaken for a registry.
 */
function findModuleRegistry(ast: AnyNode): ModuleEntry[] {
  let best: ModuleEntry[] = [];
  walk.full(ast as any, (node: AnyNode) => {
    let entries: ModuleEntry[] = [];
    let total = 0;
    if (node.type === "ObjectExpression") {
      total = node.properties.length;
      for (const prop of node.properties as AnyNode[]) {
        if (prop.type !== "Property" || !isFactory(prop.value)) continue;
        const key = keyName(prop.key);
        if (key === undefined || !/^\d+$|[/.]/.test(key)) continue;
        entries.push({ key, node: prop.value, requires: findInternalRequires(prop.value) });
      }
    } else if (node.type === "ArrayExpression") {
      total = node.elements.length;
      node.elements.forEach((el: AnyNode | null, i: number) => {
        if (el && isFactory(el)) entries.push({ key: String(i), node: el, requires: findInternalRequires(el) });
      });
    } else {
      return;
    }
    const looksLikeRegistry = entries.length >= 3 && entries.length >= total * 0.8 && entries.some((e) => e.requires.length > 0 || hasModuleParams(e.node));
    if (looksLikeRegistry && entries.length > best.length) best = entries;
    entries = [];
  });
  return best;
}

function isFactory(node: AnyNode | null | undefined): boolean {
  if (!node || (node.type !== "FunctionExpression" && node.type !== "ArrowFunctionExpression")) return false;
  const n = (node.params as AnyNode[]).length;
  return n >= 1 && n <= 3;
}

function hasModuleParams(fn: AnyNode): boolean {
  return (fn.params as AnyNode[]).length >= 2;
}

function findInternalRequires(fn: AnyNode): string[] {
  const out = new Set<string>();
  const reqName = (fn.params as AnyNode[])[2]?.name;
  walk.simple(fn as any, {
    CallExpression(n: AnyNode) {
      const callee = n.callee as AnyNode;
      const arg = (n.arguments as AnyNode[])[0];
      const isReq =
        (callee.type === "Identifier" && (callee.name === "__webpack_require__" || (reqName && callee.name === reqName))) ||
        (callee.type === "Identifier" && callee.name === "require" && arg?.type === "Literal" && typeof arg.value === "number");
      if (isReq && arg?.type === "Literal" && (typeof arg.value === "number" || typeof arg.value === "string")) {
        out.add(String(arg.value));
      }
    },
  });
  return [...out];
}

/** Calls like `__webpack_require__(42)` / `n(42)` located outside every module factory. */
function findBootstrapEntryKeys(ast: AnyNode, spans: ReadonlyArray<readonly [number, number]>): string[] {
  const keys: string[] = [];
  const inside = (pos: number) => spans.some(([s, e]) => pos >= s && pos < e);
  walk.simple(ast as any, {
    CallExpression(n: AnyNode) {
      if (inside(n.start)) return;
      const callee = n.callee as AnyNode;
      const arg = (n.arguments as AnyNode[])[0];
      if (callee.type === "Identifier" && arg?.type === "Literal" && (typeof arg.value === "number" || /^[\w./-]+$/.test(String(arg.value)))) {
        keys.push(String(arg.value));
      }
    },
  });
  return [...new Set(keys)];
}

// ---------------------------------------------------------------------------
// Flat scripts / ES modules
// ---------------------------------------------------------------------------
function buildFlatModel(ast: AnyNode, src: string, comments: acorn.Comment[] = []) {
  const units: CodeUnit[] = [];
  const topLevelParts: AnyNode[] = [];
  const exportedNames = new Set<string>();
  const claimedComments = new Set<acorn.Comment>();
  let counter = 0;

  /** Start offset including the contiguous comment block directly above `node`. */
  const leadingStart = (node: AnyNode): number => {
    let start = node.start;
    for (let i = comments.length - 1; i >= 0; i--) {
      const c = comments[i]!;
      if (c.end > start) continue;
      if (src.slice(c.end, start).trim() !== "") break;
      claimedComments.add(c);
      start = c.start;
    }
    return start;
  };

  const addDecl = (name: string, kind: CodeUnit["kind"], node: AnyNode, exported: boolean) => {
    const start = leadingStart(node);
    units.push({
      id: `fn:${counter++}`,
      name,
      kind,
      body: src.slice(start, node.end),
      offset: start,
      size: node.end - start,
      references: [],
      meta: { exported, refToken: name, node },
    });
  };

  for (const node of (ast.body as AnyNode[]) ?? []) {
    const decl = declarationOf(node);
    if (decl) {
      addDecl(decl.name, decl.kind, decl.node, decl.exported);
      continue;
    }
    if (node.type === "ExportNamedDeclaration" && !node.declaration) {
      for (const spec of (node.specifiers as AnyNode[]) ?? []) if (spec.local?.name) exportedNames.add(spec.local.name);
      continue;
    }
    if (node.type === "ExportDefaultDeclaration" && node.declaration?.type === "Identifier") {
      exportedNames.add(node.declaration.name);
      continue;
    }
    topLevelParts.push(node);
  }

  if (units.length === 0) return null;

  for (const u of units) if (exportedNames.has(u.name)) (u.meta as { exported?: boolean }).exported = true;

  const byName = new Map<string, string>();
  for (const u of units) if (!byName.has(u.name)) byName.set(u.name, u.id);

  for (const u of units) {
    const node = (u.meta as { node: AnyNode }).node;
    u.references = resolveIdentifierRefs([node], byName, u.id);
    delete (u.meta as { node?: AnyNode }).node;
  }

  const entryPoints: EntryPoint[] = [];
  if (topLevelParts.length > 0) {
    const parts = topLevelParts.map((n) => src.slice(leadingStart(n), n.end));
    // File-level comments not attached to any statement (e.g. a trailing
    // sourceMappingURL) belong to the top-level unit so they get sanitized too.
    for (const c of comments) {
      const insideUnit = units.some((u) => c.start >= (u.offset ?? 0) && c.end <= (u.offset ?? 0) + (u.size ?? 0));
      const insideTop = topLevelParts.some((n) => c.start >= n.start && c.end <= n.end);
      if (!claimedComments.has(c) && !insideUnit && !insideTop) parts.push(src.slice(c.start, c.end));
    }
    const top: CodeUnit = {
      id: "top:0",
      name: "<top-level>",
      kind: "module",
      body: parts.join("\n"),
      offset: topLevelParts[0]!.start,
      size: topLevelParts.reduce((s, n) => s + (n.end - n.start), 0),
      references: resolveIdentifierRefs(topLevelParts, byName, "top:0"),
      meta: { synthetic: true },
    };
    units.unshift(top);
    entryPoints.push({ unitId: top.id, reason: "main", detail: "top-level statements" });
  }
  for (const u of units) {
    if ((u.meta as { exported?: boolean }).exported) entryPoints.push({ unitId: u.id, reason: "export", detail: u.name });
  }
  return { units, entryPoints };
}

function declarationOf(node: AnyNode): { name: string; kind: CodeUnit["kind"]; node: AnyNode; exported: boolean } | null {
  const fromDecl = (d: AnyNode | null | undefined, exported: boolean, outer: AnyNode) => {
    if (!d) return null;
    if (d.type === "FunctionDeclaration") return { name: d.id?.name ?? "default", kind: "function" as const, node: outer, exported };
    if (d.type === "ClassDeclaration") return { name: d.id?.name ?? "default", kind: "class" as const, node: outer, exported };
    if (d.type === "VariableDeclaration" && d.declarations.length === 1) {
      const v = d.declarations[0] as AnyNode;
      const init = v.init as AnyNode | null;
      if (v.id?.type === "Identifier" && init && /^(FunctionExpression|ArrowFunctionExpression|ClassExpression)$/.test(init.type)) {
        return { name: v.id.name as string, kind: (init.type === "ClassExpression" ? "class" : "function") as CodeUnit["kind"], node: outer, exported };
      }
    }
    return null;
  };
  if (node.type === "ExportNamedDeclaration") return fromDecl(node.declaration, true, node);
  if (node.type === "ExportDefaultDeclaration") return fromDecl(node.declaration, true, node);
  return fromDecl(node, false, node);
}

function resolveIdentifierRefs(nodes: AnyNode[], byName: Map<string, string>, selfId: string): string[] {
  const out = new Set<string>();
  for (const n of nodes) {
    walk.full(n as any, (child: AnyNode) => {
      if (child.type === "Identifier") {
        const id = byName.get(child.name);
        if (id && id !== selfId) out.add(id);
      }
    });
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function keyName(key: AnyNode): string | undefined {
  if (key.type === "Identifier") return key.name;
  if (key.type === "Literal") return String(key.value);
  return undefined;
}

function collectStrings(body: string, unitId: string, out: ExtractedString[]): void {
  const re = /["'`]([^"'`\n]{4,160})["'`]/g;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(body)) && n < 300) {
    out.push({ value: m[1]!, source: "literal", unitId });
    n++;
  }
}

function looksLikeJs(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.subarray(0, 512));
  if (/[\x00-\x08\x0e-\x1f]/.test(head)) return false; // binary
  return /\b(function|const|let|var|require\(|import\s|export\s)|=>/.test(head);
}

function flatFallback(path: string, byteLength: number, src: string, warnings: string[]): ArtifactModel {
  warnings.push("no units recovered; using a single-unit representation (no pruning)");
  const id = "chunk:0";
  const strings: ExtractedString[] = [];
  collectStrings(src, id, strings);
  return {
    format: "js-bundle",
    sourcePath: path,
    byteLength,
    units: [{ id, name: "bundle", kind: "chunk", body: src, offset: 0, size: src.length, references: [], meta: {} }],
    strings,
    entryPoints: [{ unitId: id, reason: "heuristic", detail: "whole bundle" }],
    warnings,
    meta: { moduleCount: 1, graphComplete: false },
  };
}
