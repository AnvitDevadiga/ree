/**
 * Bounded .NET (ECMA-335) metadata reader.
 *
 * Every managed assembly carries metadata tables describing its types, methods
 * (with parameter names), fields, dependencies and entry point, plus a heap of
 * string literals. Reading them gives REE a no-tool baseline for .NET, the way
 * the class-file reader does for Java. Row widths depend on other tables' row
 * counts and heap sizes, so the full table schema (0x00–0x2C) is encoded here
 * just to compute offsets. Every read is bounds-checked; counts are capped.
 */
export interface DotnetType {
  token: number;
  namespace: string;
  name: string;
  /** Namespace-qualified name, nested types as Outer+Inner. */
  fullName: string;
  flags: number;
  extends?: string;
  methods: Array<{ name: string; params: string[]; flags: number; rva: number }>;
  fields: string[];
}

export interface DotnetMetadata {
  runtimeVersion: string;
  assembly?: { name: string; version: string };
  assemblyRefs: Array<{ name: string; version: string }>;
  types: DotnetType[];
  /** External types referenced (TypeRef), e.g. System.Net.Http.HttpClient. */
  typeRefs: string[];
  /** Platform-invoke imports: "dll!function". */
  pinvokes: string[];
  userStrings: string[];
  /** Method that runs first, when the assembly is an executable. */
  entryPoint?: { type: string; method: string };
  /** The assembly contains only IL (no native code). */
  ilOnly: boolean;
}

export class DotnetError extends Error {}

const MAX_ROWS = 1_000_000;
const MAX_USER_STRINGS = 20_000;

// Column kinds: fixed widths, heap indexes, simple table indexes, coded indexes.
type Col = 1 | 2 | 4 | "str" | "guid" | "blob" | { t: number } | { c: keyof typeof CODED };

const CODED = {
  TypeDefOrRef: { bits: 2, tables: [0x02, 0x01, 0x1b] },
  HasConstant: { bits: 2, tables: [0x04, 0x08, 0x17] },
  HasCustomAttribute: {
    bits: 5,
    tables: [0x06, 0x04, 0x01, 0x02, 0x08, 0x09, 0x0a, 0x00, 0x0e, 0x17, 0x14, 0x11, 0x1a, 0x1b, 0x20, 0x23, 0x26, 0x27, 0x28, 0x2a, 0x2c, 0x2b],
  },
  HasFieldMarshal: { bits: 1, tables: [0x04, 0x08] },
  HasDeclSecurity: { bits: 2, tables: [0x02, 0x06, 0x20] },
  MemberRefParent: { bits: 3, tables: [0x02, 0x01, 0x1a, 0x06, 0x1b] },
  HasSemantics: { bits: 1, tables: [0x14, 0x17] },
  MethodDefOrRef: { bits: 1, tables: [0x06, 0x0a] },
  MemberForwarded: { bits: 1, tables: [0x04, 0x06] },
  Implementation: { bits: 2, tables: [0x26, 0x23, 0x27] },
  CustomAttributeType: { bits: 3, tables: [0x06, 0x0a] },
  ResolutionScope: { bits: 2, tables: [0x00, 0x1a, 0x23, 0x01] },
  TypeOrMethodDef: { bits: 1, tables: [0x02, 0x06] },
} as const;

const SCHEMA: Record<number, Col[]> = {
  0x00: [2, "str", "guid", "guid", "guid"],
  0x01: [{ c: "ResolutionScope" }, "str", "str"],
  0x02: [4, "str", "str", { c: "TypeDefOrRef" }, { t: 0x04 }, { t: 0x06 }],
  0x03: [{ t: 0x04 }],
  0x04: [2, "str", "blob"],
  0x05: [{ t: 0x06 }],
  0x06: [4, 2, 2, "str", "blob", { t: 0x08 }],
  0x07: [{ t: 0x08 }],
  0x08: [2, 2, "str"],
  0x09: [{ t: 0x02 }, { c: "TypeDefOrRef" }],
  0x0a: [{ c: "MemberRefParent" }, "str", "blob"],
  0x0b: [2, { c: "HasConstant" }, "blob"],
  0x0c: [{ c: "HasCustomAttribute" }, { c: "CustomAttributeType" }, "blob"],
  0x0d: [{ c: "HasFieldMarshal" }, "blob"],
  0x0e: [2, { c: "HasDeclSecurity" }, "blob"],
  0x0f: [2, 4, { t: 0x02 }],
  0x10: [4, { t: 0x04 }],
  0x11: ["blob"],
  0x12: [{ t: 0x02 }, { t: 0x14 }],
  0x13: [{ t: 0x14 }],
  0x14: [2, "str", { c: "TypeDefOrRef" }],
  0x15: [{ t: 0x02 }, { t: 0x17 }],
  0x16: [{ t: 0x17 }],
  0x17: [2, "str", "blob"],
  0x18: [2, { t: 0x06 }, { c: "HasSemantics" }],
  0x19: [{ t: 0x02 }, { c: "MethodDefOrRef" }, { c: "MethodDefOrRef" }],
  0x1a: ["str"],
  0x1b: ["blob"],
  0x1c: [2, { c: "MemberForwarded" }, "str", { t: 0x1a }],
  0x1d: [4, { t: 0x04 }],
  0x1e: [4, 4],
  0x1f: [4],
  0x20: [4, 2, 2, 2, 2, 4, "blob", "str", "str"],
  0x21: [4],
  0x22: [4, 4, 4],
  0x23: [2, 2, 2, 2, 4, "blob", "str", "str", "blob"],
  0x24: [4, { t: 0x23 }],
  0x25: [4, 4, 4, { t: 0x23 }],
  0x26: [4, "str", "blob"],
  0x27: [4, 4, "str", "str", { c: "Implementation" }],
  0x28: [4, 4, "str", { c: "Implementation" }],
  0x29: [{ t: 0x02 }, { t: 0x02 }],
  0x2a: [2, 2, { c: "TypeOrMethodDef" }, "str"],
  0x2b: [{ c: "MethodDefOrRef" }, "blob"],
  0x2c: [{ t: 0x2a }, { c: "TypeDefOrRef" }],
};

/** Returns the CLI header location if `b` is a managed PE, else null. */
export function findCliHeader(b: Uint8Array): { dv: DataView; rvaToOffset: (rva: number) => number; cli: number } | null {
  if (b.length < 0x40 || b[0] !== 0x4d || b[1] !== 0x5a) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const pe = dv.getUint32(0x3c, true);
  if (pe + 24 > b.length || dv.getUint32(pe, true) !== 0x00004550) return null;
  const sections = dv.getUint16(pe + 6, true);
  const optSize = dv.getUint16(pe + 20, true);
  const opt = pe + 24;
  if (opt + optSize > b.length || optSize < 96) return null;
  const magic = dv.getUint16(opt, true);
  const dirs = opt + (magic === 0x20b ? 112 : 96);
  const numDirs = dv.getUint32(dirs - 4, true);
  if (numDirs < 15 || dirs + 15 * 8 > b.length) return null;
  const cliRva = dv.getUint32(dirs + 14 * 8, true);
  if (!cliRva) return null;
  const secTable = opt + optSize;
  const secs: Array<{ va: number; vsize: number; raw: number; rawSize: number }> = [];
  for (let i = 0; i < Math.min(sections, 96); i++) {
    const s = secTable + i * 40;
    if (s + 40 > b.length) break;
    secs.push({ vsize: dv.getUint32(s + 8, true), va: dv.getUint32(s + 12, true), rawSize: dv.getUint32(s + 16, true), raw: dv.getUint32(s + 20, true) });
  }
  const rvaToOffset = (rva: number) => {
    for (const s of secs) if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rawSize)) return rva - s.va + s.raw;
    throw new DotnetError(`RVA 0x${rva.toString(16)} is outside every section`);
  };
  try {
    const cli = rvaToOffset(cliRva);
    if (cli + 72 > b.length) return null;
    return { dv, rvaToOffset, cli };
  } catch {
    return null;
  }
}

export function readDotnetMetadata(b: Uint8Array): DotnetMetadata {
  const h = findCliHeader(b);
  if (!h) throw new DotnetError("not a .NET assembly (no CLI header)");
  const { dv, rvaToOffset, cli } = h;
  const flags = dv.getUint32(cli + 16, true);
  const entryToken = dv.getUint32(cli + 20, true);
  const mdOff = rvaToOffset(dv.getUint32(cli + 8, true));
  if (mdOff + 32 > b.length || dv.getUint32(mdOff, true) !== 0x424a5342) throw new DotnetError("metadata signature (BSJB) missing");
  const verLen = dv.getUint32(mdOff + 12, true);
  if (verLen > 256) throw new DotnetError("implausible metadata version length");
  const runtimeVersion = new TextDecoder().decode(b.subarray(mdOff + 16, mdOff + 16 + verLen)).replace(/\0+$/, "");
  let p = mdOff + 16 + verLen + 2;
  const nStreams = Math.min(dv.getUint16(p, true), 16);
  p += 2;
  const streams = new Map<string, { off: number; size: number }>();
  for (let i = 0; i < nStreams; i++) {
    if (p + 8 > b.length) break;
    const off = dv.getUint32(p, true);
    const size = dv.getUint32(p + 4, true);
    p += 8;
    let name = "";
    while (p < b.length && b[p] !== 0 && name.length < 32) name += String.fromCharCode(b[p++]!);
    p = (p + 4) & ~3; // name is NUL-terminated and padded to 4 bytes
    if (mdOff + off + size <= b.length) streams.set(name, { off: mdOff + off, size });
  }
  const tbl = streams.get("#~") ?? streams.get("#-");
  const strHeap = streams.get("#Strings");
  if (!tbl || !strHeap) throw new DotnetError("metadata tables or #Strings heap missing");
  const dec = new TextDecoder();

  const heapSizes = b[tbl.off + 6]!;
  const strW = heapSizes & 1 ? 4 : 2;
  const guidW = heapSizes & 2 ? 4 : 2;
  const blobW = heapSizes & 4 ? 4 : 2;
  const valid = dv.getBigUint64(tbl.off + 8, true);
  const rows = new Array<number>(64).fill(0);
  let q = tbl.off + 24;
  for (let t = 0; t < 64; t++) {
    if ((valid >> BigInt(t)) & 1n) {
      rows[t] = dv.getUint32(q, true);
      if (rows[t]! > MAX_ROWS) throw new DotnetError(`table 0x${t.toString(16)} claims ${rows[t]} rows`);
      q += 4;
    }
  }
  if (heapSizes & 0x40) q += 4; // extra data in uncompressed (#-) streams
  for (let t = 0x2d; t < 64; t++) if (rows[t]) throw new DotnetError(`unsupported metadata table 0x${t.toString(16)}`);

  const idxW = (t: number) => (rows[t]! < 0x10000 ? 2 : 4);
  const codedW = (k: keyof typeof CODED) => {
    const c = CODED[k];
    const max = Math.max(...c.tables.map((t) => rows[t]!));
    return max < 1 << (16 - c.bits) ? 2 : 4;
  };
  const colW = (c: Col): number =>
    typeof c === "number" ? c : c === "str" ? strW : c === "guid" ? guidW : c === "blob" ? blobW : "t" in c ? idxW(c.t) : codedW(c.c);
  const tableAt: number[] = [];
  const rowSize: number[] = [];
  for (let t = 0; t <= 0x2c; t++) {
    tableAt[t] = q;
    rowSize[t] = SCHEMA[t]!.reduce((s, c) => s + colW(c), 0);
    q += rowSize[t]! * rows[t]!;
  }
  if (q > tbl.off + tbl.size + 8 || q > b.length) throw new DotnetError("metadata tables run past their stream");

  /** Read column `col` (0-based) of row `r` (1-based) of table `t`. */
  const cell = (t: number, r: number, col: number): number => {
    let o = tableAt[t]! + (r - 1) * rowSize[t]!;
    const cols = SCHEMA[t]!;
    for (let i = 0; i < col; i++) o += colW(cols[i]!);
    const w = colW(cols[col]!);
    return w === 1 ? dv.getUint8(o) : w === 2 ? dv.getUint16(o, true) : dv.getUint32(o, true);
  };
  const str = (i: number): string => {
    const s = strHeap.off + i;
    if (i >= strHeap.size) return "";
    let e = s;
    while (e < strHeap.off + strHeap.size && b[e] !== 0 && e - s < 4096) e++;
    return dec.decode(b.subarray(s, e));
  };
  const decodeCoded = (k: keyof typeof CODED, v: number) => {
    const c = CODED[k];
    return { table: c.tables[v & ((1 << c.bits) - 1)], row: v >>> c.bits };
  };

  // Type references (external types) and nesting.
  const typeRefName = (r: number) => {
    const ns = str(cell(0x01, r, 2));
    return (ns ? ns + "." : "") + str(cell(0x01, r, 1));
  };
  const typeRefs: string[] = [];
  for (let r = 1; r <= rows[0x01]!; r++) typeRefs.push(typeRefName(r));
  const enclosing = new Map<number, number>();
  for (let r = 1; r <= rows[0x29]!; r++) enclosing.set(cell(0x29, r, 0), cell(0x29, r, 1));

  const nTypes = rows[0x02]!;
  const typeName = (r: number, depth = 0): string => {
    const ns = str(cell(0x02, r, 2));
    const name = str(cell(0x02, r, 1));
    const outer = enclosing.get(r);
    if (outer && depth < 16) return `${typeName(outer, depth + 1)}+${name}`;
    return (ns ? ns + "." : "") + name;
  };
  const paramName = (r: number) => (r >= 1 && r <= rows[0x08]! ? str(cell(0x08, r, 2)) : "");
  const types: DotnetType[] = [];
  const methodOwner = new Map<number, string>();
  for (let r = 1; r <= nTypes; r++) {
    const mStart = cell(0x02, r, 5);
    const mEnd = r < nTypes ? cell(0x02, r + 1, 5) : rows[0x06]! + 1;
    const fStart = cell(0x02, r, 4);
    const fEnd = r < nTypes ? cell(0x02, r + 1, 4) : rows[0x04]! + 1;
    const ext = cell(0x02, r, 3);
    let extendsName: string | undefined;
    if (ext) {
      const d = decodeCoded("TypeDefOrRef", ext);
      if (d.table === 0x01 && d.row >= 1 && d.row <= rows[0x01]!) extendsName = typeRefName(d.row);
      else if (d.table === 0x02 && d.row >= 1 && d.row <= nTypes) extendsName = typeName(d.row);
    }
    const fullName = typeName(r);
    const methods: DotnetType["methods"] = [];
    for (let m = mStart; m < mEnd && m <= rows[0x06]!; m++) {
      const pStart = cell(0x06, m, 5);
      const pEnd = m < rows[0x06]! ? cell(0x06, m + 1, 5) : rows[0x08]! + 1;
      const params: string[] = [];
      for (let pi = pStart; pi < pEnd && params.length < 64; pi++) {
        if (cell(0x08, pi, 1) === 0) continue; // sequence 0 is the return value
        params.push(paramName(pi));
      }
      const name = str(cell(0x06, m, 3));
      methods.push({ name, params, flags: cell(0x06, m, 2), rva: cell(0x06, m, 0) });
      methodOwner.set(m, fullName);
    }
    const fields: string[] = [];
    for (let f = fStart; f < fEnd && f <= rows[0x04]!; f++) fields.push(str(cell(0x04, f, 1)));
    types.push({ token: 0x02000000 | r, namespace: str(cell(0x02, r, 2)), name: str(cell(0x02, r, 1)), fullName, flags: cell(0x02, r, 0), extends: extendsName, methods, fields });
  }

  const pinvokes: string[] = [];
  for (let r = 1; r <= rows[0x1c]!; r++) {
    const scope = cell(0x1c, r, 3);
    const dll = scope >= 1 && scope <= rows[0x1a]! ? str(cell(0x1a, scope, 0)) : "?";
    pinvokes.push(`${dll}!${str(cell(0x1c, r, 2))}`);
  }
  const version = (t: number, r: number, first: number) => [0, 1, 2, 3].map((i) => cell(t, r, first + i)).join(".");
  const assembly = rows[0x20] ? { name: str(cell(0x20, 1, 7)), version: version(0x20, 1, 1) } : undefined;
  const assemblyRefs: DotnetMetadata["assemblyRefs"] = [];
  for (let r = 1; r <= rows[0x23]!; r++) assemblyRefs.push({ name: str(cell(0x23, r, 6)), version: version(0x23, r, 0) });

  // #US: user-string heap (string literals), each a compressed length + UTF-16LE + 1 flag byte.
  const userStrings: string[] = [];
  const us = streams.get("#US");
  if (us) {
    let u = us.off + 1;
    const end = us.off + us.size;
    while (u < end && userStrings.length < MAX_USER_STRINGS) {
      const first = b[u]!;
      let len: number;
      if ((first & 0x80) === 0) (len = first), (u += 1);
      else if ((first & 0xc0) === 0x80) (len = ((first & 0x3f) << 8) | b[u + 1]!), (u += 2);
      else (len = ((first & 0x1f) << 24) | (b[u + 1]! << 16) | (b[u + 2]! << 8) | b[u + 3]!), (u += 4);
      if (len === 0 || u + len > end) break;
      const chars = len - 1;
      let s = "";
      for (let k = 0; k + 1 < chars && s.length < 4096; k += 2) s += String.fromCharCode(b[u + k]! | (b[u + k + 1]! << 8));
      if (s) userStrings.push(s);
      u += len;
    }
  }

  let entryPoint: DotnetMetadata["entryPoint"];
  if ((entryToken >>> 24) === 0x06) {
    const m = entryToken & 0xffffff;
    if (m >= 1 && m <= rows[0x06]!) entryPoint = { type: methodOwner.get(m) ?? "?", method: str(cell(0x06, m, 3)) };
  }
  return { runtimeVersion, assembly, assemblyRefs, types, typeRefs, pinvokes, userStrings, entryPoint, ilOnly: (flags & 1) === 1 };
}
