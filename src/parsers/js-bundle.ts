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
    registry.length > 0
      ? buildRegistryModel(ast, src, registry)
      : (buildFlatModel(ast, src, comments) ?? buildWrappedModel(ast, src, warnings));
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
    // File-level comments not attached to any statement (e.g. a trailing
    // sourceMappingURL) belong to the first top-level unit so they get sanitized too.
    const stray: string[] = [];
    for (const c of comments) {
      const insideUnit = units.some((u) => c.start >= (u.offset ?? 0) && c.end <= (u.offset ?? 0) + (u.size ?? 0));
      const insideTop = topLevelParts.some((n) => c.start >= n.start && c.end <= n.end);
      if (!claimedComments.has(c) && !insideUnit && !insideTop) stray.push(src.slice(c.start, c.end));
    }
    const groups = groupStatements(topLevelParts, src, leadingStart);
    const tops: CodeUnit[] = groups.map((group, i) => {
      const id = `top:${i}`;
      const parts = group.map((n) => src.slice(leadingStart(n), n.end));
      if (i === 0) parts.push(...stray);
      return {
        id,
        name: i === 0 ? "<top-level>" : `<top-level>#${i + 1}`,
        kind: "module",
        body: parts.join("\n"),
        offset: group[0]!.start,
        size: group.reduce((t, n) => t + (n.end - n.start), 0),
        references: resolveIdentifierRefs(group, byName, id),
        meta: { synthetic: true, ...(groups.length > 1 ? { group: i + 1, groups: groups.length } : {}) },
      };
    });
    units.unshift(...tops);
    for (const t of tops) entryPoints.push({ unitId: t.id, reason: "main", detail: "top-level statements" });
  }
  for (const u of units) {
    if ((u.meta as { exported?: boolean }).exported) entryPoints.push({ unitId: u.id, reason: "export", detail: u.name });
  }
  return { units, entryPoints };
}

// ---------------------------------------------------------------------------
// Statement grouping for large leftover units
// ---------------------------------------------------------------------------
/** Leftover units at or below this size stay one unit (unchanged behavior). */
const LEFTOVER_SPLIT_CHARS = 8000;
/** A statement at least this large becomes its own group. */
const LARGE_STATEMENT_CHARS = 1500;
/** Cap on groups produced from one leftover unit. */
const MAX_LEFTOVER_GROUPS = 500;

/**
 * Split a large run of non-declaration statements into groups: each large
 * statement alone, consecutive small statements together. Hardened bundles park
 * tens of KB of generated statements beside an app's few real wiring lines; as
 * one unit the aggregate looks packed and the real lines get quarantined with
 * it. As groups, every cleaning pass judges each piece on its own.
 */
function groupStatements(nodes: AnyNode[], src: string, startOf: (n: AnyNode) => number = (n) => n.start): AnyNode[][] {
  const total = nodes.reduce((t, n) => t + (n.end - startOf(n)), 0);
  if (total <= LEFTOVER_SPLIT_CHARS || nodes.length < 2) return [nodes];
  const groups: AnyNode[][] = [];
  let cur: AnyNode[] = [];
  let curSize = 0;
  const flush = () => {
    if (cur.length) groups.push(cur);
    cur = [];
    curSize = 0;
  };
  for (const n of nodes) {
    const size = n.end - startOf(n);
    if (size >= LARGE_STATEMENT_CHARS) {
      flush();
      groups.push([n]);
      continue;
    }
    if (curSize + size > LARGE_STATEMENT_CHARS) flush();
    cur.push(n);
    curSize += size;
  }
  flush();
  if (groups.length > MAX_LEFTOVER_GROUPS) return [nodes];
  return groups;
}

// ---------------------------------------------------------------------------
// Wrapped bundles (IIFE / UMD / esbuild & rollup per-module wrappers)
// ---------------------------------------------------------------------------
/** Hard cap on how many wrapper levels are unwrapped (hostile-input bound). */
const MAX_WRAP_DEPTH = 8;
/** Hard cap on units recovered from wrappers. */
const MAX_WRAPPED_UNITS = 20_000;

/**
 * Bundlers hide every declaration inside a wrapper, so the flat model sees
 * nothing at the top level and the whole bundle used to become one opaque
 * chunk. This descends into wrapper function bodies — the IIFE callee, a UMD
 * factory argument, esbuild/rollup `__commonJS({ "path"(exports, module) {...} })`
 * module objects — and recovers declarations inside them as units. Statements
 * that are not declarations are grouped per scope into a synthetic unit, which
 * is where execution starts for that module.
 *
 * It only runs when the flat model found no top-level declarations, so ordinary
 * scripts and ES modules are modeled exactly as before.
 */
function buildWrappedModel(ast: AnyNode, src: string, warnings: string[]) {
  const units: CodeUnit[] = [];
  const entryPoints: EntryPoint[] = [];
  const scopeParts: Array<{ label: string; nodes: AnyNode[] }> = [];
  let counter = 0;
  let depthCapped = false;

  const pushUnit = (name: string, kind: CodeUnit["kind"], node: AnyNode, exported: boolean, scope: string) => {
    if (units.length >= MAX_WRAPPED_UNITS) return;
    units.push({
      id: `fn:${counter++}`,
      name,
      kind,
      body: src.slice(node.start, node.end),
      offset: node.start,
      size: node.end - node.start,
      references: [],
      meta: { exported, refToken: name, node, scope, wrapped: true },
    });
  };

  const visitScope = (stmts: AnyNode[], label: string, depth: number) => {
    if (depth > MAX_WRAP_DEPTH) {
      depthCapped = true;
      return;
    }
    const leftovers: AnyNode[] = [];
    for (const stmt of stmts) {
      const decl = declarationOf(stmt) ?? exportAssignmentOf(stmt, src);
      if (decl) {
        pushUnit(decl.name, decl.kind, decl.node, decl.exported, label);
        continue;
      }
      const inner = wrapperBodies(stmt);
      if (inner.length) {
        for (const w of inner) visitScope(w.body, w.label ?? (label === "<bundle>" ? "<wrapper>" : label), depth + 1);
        continue;
      }
      leftovers.push(stmt);
    }
    if (leftovers.length) scopeParts.push({ label, nodes: leftovers });
  };

  visitScope((ast.body as AnyNode[]) ?? [], "<bundle>", 0);
  if (depthCapped) warnings.push(`[anti-exhaust] wrapper nesting deeper than ${MAX_WRAP_DEPTH}; deeper scopes not unwrapped`);
  if (units.length === 0) return null;
  if (units.length >= MAX_WRAPPED_UNITS) warnings.push(`unit cap ${MAX_WRAPPED_UNITS} reached while unwrapping`);
  warnings.push(`unwrapped bundler wrappers: recovered ${units.length} unit(s) from inside IIFE/UMD/module wrappers`);

  const byName = new Map<string, string>();
  for (const u of units) if (!byName.has(u.name)) byName.set(u.name, u.id);
  for (const u of units) {
    u.references = resolveIdentifierRefs([(u.meta as { node: AnyNode }).node], byName, u.id);
    delete (u.meta as { node?: AnyNode }).node;
  }

  let scopeCounter = 0;
  for (const part of scopeParts) {
    const base = part.label === "<bundle>" ? "<top-level>" : part.label === "<wrapper>" ? "<wrapper>" : `<module ${part.label}>`;
    const groups = groupStatements(part.nodes, src);
    groups.forEach((group, i) => {
      const id = `scope:${scopeCounter++}`;
      units.unshift({
        id,
        name: i === 0 ? base : `${base}#${i + 1}`,
        kind: "module",
        body: group.map((n) => src.slice(n.start, n.end)).join("\n"),
        offset: group[0]!.start,
        size: group.reduce((t, n) => t + (n.end - n.start), 0),
        references: resolveIdentifierRefs(group, byName, id),
        meta: { synthetic: true, wrapped: true },
      });
      entryPoints.push({ unitId: id, reason: "main", detail: `statements in ${part.label}` });
    });
  }
  for (const u of units) {
    if ((u.meta as { exported?: boolean }).exported) entryPoints.push({ unitId: u.id, reason: "export", detail: u.name });
  }
  return { units, entryPoints };
}

/** `module.exports = function…`, `exports.x = () => …`, `X.prototype.y = function…` */
function exportAssignmentOf(node: AnyNode, src: string): { name: string; kind: CodeUnit["kind"]; node: AnyNode; exported: boolean } | null {
  if (node.type !== "ExpressionStatement" || node.expression?.type !== "AssignmentExpression") return null;
  const { left, right } = node.expression as AnyNode;
  if (!right || !/^(FunctionExpression|ArrowFunctionExpression|ClassExpression)$/.test(right.type)) return null;
  if (left.type !== "MemberExpression") return null;
  const lhs = src.slice(left.start, left.end);
  if (lhs.length > 120) return null;
  const exported = /^(module\.exports|exports)\b/.test(lhs);
  const name = right.id?.name && !exported ? right.id.name : lhs;
  return { name, kind: right.type === "ClassExpression" ? "class" : "function", node, exported };
}

/**
 * Function bodies that act as module scopes inside one statement: an IIFE callee,
 * function arguments of a wrapper call (UMD factory), and functions in an object
 * argument whose keys look like module paths (esbuild/rollup `__commonJS`).
 * Ordinary callbacks with tiny bodies are not treated as scopes.
 */
function wrapperBodies(stmt: AnyNode): Array<{ body: AnyNode[]; label?: string }> {
  let expr: AnyNode | null | undefined =
    stmt.type === "ExpressionStatement" ? stmt.expression
    : stmt.type === "ReturnStatement" ? stmt.argument
    : stmt.type === "VariableDeclaration" && stmt.declarations.length === 1 ? (stmt.declarations[0] as AnyNode).init
    : null;
  // Peel `!function(){}()`, `void …`, `(0, …)` and `a = …`.
  for (let i = 0; expr && i < 4; i++) {
    if (expr.type === "UnaryExpression") expr = expr.argument;
    else if (expr.type === "SequenceExpression") expr = expr.expressions[expr.expressions.length - 1];
    else if (expr.type === "AssignmentExpression") expr = expr.right;
    else break;
  }
  if (!expr || expr.type !== "CallExpression") return [];

  const out: Array<{ body: AnyNode[]; label?: string }> = [];
  const blockOf = (fn: AnyNode | null | undefined): AnyNode[] | null =>
    fn && /^(FunctionExpression|ArrowFunctionExpression)$/.test(fn.type) && fn.body?.type === "BlockStatement" ? (fn.body.body as AnyNode[]) : null;

  const callee = expr.callee as AnyNode;
  const iife = blockOf(callee);
  if (iife) out.push({ body: iife });

  for (const arg of (expr.arguments as AnyNode[]) ?? []) {
    const b = blockOf(arg);
    if (b && b.length >= 2) out.push({ body: b });
    if (arg.type === "ObjectExpression") {
      for (const prop of (arg.properties as AnyNode[]) ?? []) {
        if (prop.type !== "Property") continue;
        const key = keyName(prop.key);
        const fnBody = blockOf(prop.value);
        if (key && fnBody && /[/.]/.test(key)) out.push({ body: fnBody, label: key.split("/").slice(-2).join("/") });
      }
    }
  }
  return out;
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
