/**
 * WebAssembly (`.wasm`) module parser.
 *
 * Validates the header, walks every section, and recovers imports, exports, the
 * start function, element segments (indirect-call targets), and the `name`
 * custom section. Each defined function is decoded instruction by instruction:
 * immediates are consumed per the spec, so `call` targets are exact rather than
 * guessed from raw bytes, and a compact WAT-style listing becomes the unit body
 * that downstream agents read.
 *
 * Reachability roots: the start function, exported functions, and every function
 * placed in a table by an element segment (anything reachable via
 * `call_indirect`). If any body fails to decode, the graph is marked incomplete
 * and nothing is pruned.
 */
import type { ArtifactModel, CodeUnit, EntryPoint, ExtractedString, Parser, ParserInput } from "../core/types.js";
import { ByteReader } from "./reader.js";

const SECTION_NAMES: Record<number, string> = {
  0: "custom", 1: "type", 2: "import", 3: "function", 4: "table", 5: "memory", 6: "global",
  7: "export", 8: "start", 9: "element", 10: "code", 11: "data", 12: "datacount", 13: "tag",
};

export class WasmParser implements Parser {
  readonly format = "wasm" as const;

  canParse(input: ParserInput): boolean {
    const b = input.bytes;
    return b.length >= 8 && b[0] === 0x00 && b[1] === 0x61 && b[2] === 0x73 && b[3] === 0x6d;
  }

  async parse(input: ParserInput): Promise<ArtifactModel> {
    const warnings: string[] = [];
    const r = new ByteReader(input.bytes);
    r.u32(); // magic
    const version = r.u32();

    const strings: ExtractedString[] = [];
    const imports: Array<{ module: string; name: string; kind: number }> = [];
    const exports: Array<{ name: string; kind: number; index: number }> = [];
    const funcNames = new Map<number, string>();
    const tableTargets = new Set<number>();
    const codeRanges: Array<{ start: number; size: number }> = [];
    let startFunc: number | undefined;
    let importedFuncs = 0;

    while (r.remaining() > 0) {
      const id = r.u8();
      const len = r.uleb();
      const end = r.pos + len;
      if (end > r.length) {
        warnings.push(`section ${SECTION_NAMES[id] ?? id} overruns the file; stopping`);
        break;
      }
      try {
        switch (id) {
          case 2: {
            const count = r.uleb();
            for (let i = 0; i < count; i++) {
              const mod = readName(r);
              const name = readName(r);
              const kind = r.u8();
              skipImportDesc(r, kind);
              imports.push({ module: mod, name, kind });
              if (kind === 0) funcNames.set(importedFuncs++, `${mod}.${name}`);
              strings.push({ value: `${mod}.${name}`, source: "symbol" });
            }
            break;
          }
          case 7: {
            const count = r.uleb();
            for (let i = 0; i < count; i++) {
              const name = readName(r);
              const kind = r.u8();
              const index = r.uleb();
              exports.push({ name, kind, index });
              if (kind === 0 && !funcNames.has(index)) funcNames.set(index, name);
              strings.push({ value: name, source: "symbol" });
            }
            break;
          }
          case 8:
            startFunc = r.uleb();
            break;
          case 9:
            parseElements(r, tableTargets);
            break;
          case 10: {
            const count = r.uleb();
            for (let i = 0; i < count; i++) {
              const size = r.uleb();
              codeRanges.push({ start: r.pos, size });
              r.seek(r.pos + size);
            }
            break;
          }
          case 0: {
            const name = readName(r);
            if (name === "name") parseNameSection(r, end, funcNames);
            else strings.push({ value: `custom section: ${name}`, source: "metadata" });
            break;
          }
          default:
            break;
        }
      } catch (e) {
        warnings.push(`malformed ${SECTION_NAMES[id] ?? id} section: ${(e as Error).message}`);
      }
      r.seek(end);
    }

    let graphComplete = true;
    const units: CodeUnit[] = codeRanges.map((range, i) => {
      const index = importedFuncs + i;
      const decoded = decodeFunction(input.bytes.subarray(range.start, range.start + range.size), funcNames);
      if (!decoded.ok) {
        graphComplete = false;
        warnings.push(`func ${index}: ${decoded.error}; call graph marked incomplete`);
      }
      return {
        id: `wfn:${index}`,
        name: funcNames.get(index) ?? `func_${index}`,
        kind: "function",
        body: decoded.listing,
        offset: range.start,
        size: range.size,
        references: decoded.calls.filter((c) => c >= importedFuncs).map((c) => `wfn:${c}`),
        meta: {
          listing: true,
          importCalls: decoded.calls.filter((c) => c < importedFuncs).map((c) => funcNames.get(c) ?? `import_${c}`),
          exported: exports.some((e) => e.kind === 0 && e.index === index),
          refToken: funcNames.get(index) ?? `func_${index}`,
        },
      };
    });

    const entryPoints: EntryPoint[] = [];
    const defined = new Set(units.map((u) => u.id));
    const addEntry = (index: number, reason: EntryPoint["reason"], detail: string) => {
      const unitId = `wfn:${index}`;
      if (defined.has(unitId) && !entryPoints.some((e) => e.unitId === unitId)) entryPoints.push({ unitId, reason, detail });
    };
    if (startFunc !== undefined) addEntry(startFunc, "start-section", "start function");
    for (const e of exports) if (e.kind === 0) addEntry(e.index, "export", e.name);
    for (const t of tableTargets) addEntry(t, "declared", "indirect-call table target");

    return {
      format: "wasm",
      sourcePath: input.path,
      byteLength: input.bytes.length,
      units,
      strings,
      entryPoints,
      warnings,
      meta: {
        version,
        importedFuncCount: importedFuncs,
        definedFuncCount: codeRanges.length,
        tableTargets: tableTargets.size,
        imports,
        exports,
        graphComplete,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// section helpers
// ---------------------------------------------------------------------------
function readName(r: ByteReader): string {
  return new TextDecoder().decode(r.bytesSlice(r.uleb()));
}

function skipLimits(r: ByteReader): void {
  const flags = r.uleb();
  r.uleb();
  if (flags & 1) r.uleb();
}

function skipImportDesc(r: ByteReader, kind: number): void {
  switch (kind) {
    case 0: r.uleb(); break; // func typeidx
    case 1: r.u8(); skipLimits(r); break; // table
    case 2: skipLimits(r); break; // memory
    case 3: r.u8(); r.u8(); break; // global
    case 4: r.u8(); r.uleb(); break; // tag
    default: throw new RangeError(`unknown import kind ${kind}`);
  }
}

/** Constant expression: collect `ref.func` targets, stop at `end`. */
function readConstExpr(r: ByteReader, refs?: Set<number>): void {
  for (;;) {
    const op = r.u8();
    switch (op) {
      case 0x0b: return;
      case 0x41: case 0x42: readSleb(r); break;
      case 0x43: r.bytesSlice(4); break;
      case 0x44: r.bytesSlice(8); break;
      case 0x23: r.uleb(); break; // global.get
      case 0xd0: r.u8(); break; // ref.null
      case 0xd2: { const f = r.uleb(); refs?.add(f); break; } // ref.func
      case 0x6a: case 0x6b: case 0x6c: case 0x7c: case 0x7d: case 0x7e: break; // extended-const arithmetic
      default: throw new RangeError(`unsupported const-expr opcode 0x${op.toString(16)}`);
    }
  }
}

function parseElements(r: ByteReader, targets: Set<number>): void {
  const count = r.uleb();
  for (let i = 0; i < count; i++) {
    const flags = r.uleb();
    const usesExprs = (flags & 0b100) !== 0;
    if (flags & 0b001) {
      r.u8(); // passive/declarative segments always carry an elemkind or reftype
    } else {
      if (flags & 0b010) r.uleb(); // explicit table index
      readConstExpr(r); // offset
      if (flags & 0b010) r.u8(); // elemkind / reftype
    }
    const n = r.uleb();
    for (let j = 0; j < n; j++) {
      if (usesExprs) readConstExpr(r, targets);
      else targets.add(r.uleb());
    }
  }
}

function parseNameSection(r: ByteReader, end: number, names: Map<number, string>): void {
  while (r.pos < end) {
    const sub = r.u8();
    const len = r.uleb();
    const subEnd = r.pos + len;
    if (sub === 1) {
      const count = r.uleb();
      for (let i = 0; i < count; i++) {
        const idx = r.uleb();
        names.set(idx, readName(r));
      }
    }
    r.seek(subEnd);
  }
}

// ---------------------------------------------------------------------------
// instruction decoder
// ---------------------------------------------------------------------------
const OP_NAMES: Record<number, string> = {
  0x00: "unreachable", 0x01: "nop", 0x02: "block", 0x03: "loop", 0x04: "if", 0x05: "else", 0x0b: "end",
  0x0c: "br", 0x0d: "br_if", 0x0e: "br_table", 0x0f: "return", 0x10: "call", 0x11: "call_indirect",
  0x12: "return_call", 0x13: "return_call_indirect", 0x1a: "drop", 0x1b: "select", 0x1c: "select",
  0x20: "local.get", 0x21: "local.set", 0x22: "local.tee", 0x23: "global.get", 0x24: "global.set",
  0x25: "table.get", 0x26: "table.set",
  0x28: "i32.load", 0x29: "i64.load", 0x2a: "f32.load", 0x2b: "f64.load", 0x2c: "i32.load8_s", 0x2d: "i32.load8_u",
  0x2e: "i32.load16_s", 0x2f: "i32.load16_u", 0x30: "i64.load8_s", 0x31: "i64.load8_u", 0x32: "i64.load16_s",
  0x33: "i64.load16_u", 0x34: "i64.load32_s", 0x35: "i64.load32_u", 0x36: "i32.store", 0x37: "i64.store",
  0x38: "f32.store", 0x39: "f64.store", 0x3a: "i32.store8", 0x3b: "i32.store16", 0x3c: "i64.store8",
  0x3d: "i64.store16", 0x3e: "i64.store32", 0x3f: "memory.size", 0x40: "memory.grow",
  0x41: "i32.const", 0x42: "i64.const", 0x43: "f32.const", 0x44: "f64.const",
  0x45: "i32.eqz", 0x46: "i32.eq", 0x47: "i32.ne", 0x48: "i32.lt_s", 0x49: "i32.lt_u", 0x4a: "i32.gt_s",
  0x4b: "i32.gt_u", 0x4c: "i32.le_s", 0x4d: "i32.le_u", 0x4e: "i32.ge_s", 0x4f: "i32.ge_u",
  0x50: "i64.eqz", 0x51: "i64.eq", 0x52: "i64.ne",
  0x67: "i32.clz", 0x68: "i32.ctz", 0x69: "i32.popcnt", 0x6a: "i32.add", 0x6b: "i32.sub", 0x6c: "i32.mul",
  0x6d: "i32.div_s", 0x6e: "i32.div_u", 0x6f: "i32.rem_s", 0x70: "i32.rem_u", 0x71: "i32.and", 0x72: "i32.or",
  0x73: "i32.xor", 0x74: "i32.shl", 0x75: "i32.shr_s", 0x76: "i32.shr_u", 0x77: "i32.rotl", 0x78: "i32.rotr",
  0x7c: "i64.add", 0x7d: "i64.sub", 0x7e: "i64.mul", 0x83: "i64.and", 0x84: "i64.or", 0x85: "i64.xor",
  0x92: "f32.add", 0x93: "f32.sub", 0x94: "f32.mul", 0x95: "f32.div",
  0xa0: "f64.add", 0xa1: "f64.sub", 0xa2: "f64.mul", 0xa3: "f64.div",
  0xa7: "i32.wrap_i64", 0xac: "i64.extend_i32_s", 0xad: "i64.extend_i32_u",
  0xd0: "ref.null", 0xd1: "ref.is_null", 0xd2: "ref.func",
};

interface Decoded {
  ok: boolean;
  error?: string;
  calls: number[];
  listing: string;
}

const MAX_LISTING_LINES = 400;

export function decodeFunction(body: Uint8Array, names: Map<number, string>): Decoded {
  const r = new ByteReader(body);
  const calls = new Set<number>();
  const lines: string[] = [];
  let indent = 1;
  const emit = (s: string) => {
    if (lines.length < MAX_LISTING_LINES) lines.push(`${"  ".repeat(Math.max(indent, 0))}${s}`);
  };
  try {
    const declCount = r.uleb();
    const locals: string[] = [];
    for (let i = 0; i < declCount; i++) {
      const n = r.uleb();
      locals.push(`${n}x${valType(r.u8())}`);
    }
    if (locals.length) emit(`(local ${locals.join(" ")})`);

    while (r.remaining() > 0) {
      const op = r.u8();
      const name = OP_NAMES[op] ?? `op_0x${op.toString(16)}`;
      switch (op) {
        case 0x02: case 0x03: case 0x04: readBlockType(r); emit(name); indent++; break;
        case 0x05: indent--; emit(name); indent++; break;
        case 0x0b: indent--; if (r.remaining() > 0) emit(name); break;
        case 0x0c: case 0x0d: emit(`${name} ${r.uleb()}`); break;
        case 0x0e: { const n = r.uleb(); for (let i = 0; i <= n; i++) r.uleb(); emit(`${name} (${n + 1} targets)`); break; }
        case 0x10: case 0x12: { const f = r.uleb(); calls.add(f); emit(`${name} $${names.get(f) ?? f}`); break; }
        case 0x11: case 0x13: r.uleb(); r.uleb(); emit(name); break;
        case 0x1c: { const n = r.uleb(); for (let i = 0; i < n; i++) r.u8(); emit(name); break; }
        case 0x20: case 0x21: case 0x22: case 0x23: case 0x24: case 0x25: case 0x26: emit(`${name} ${r.uleb()}`); break;
        case 0x3f: case 0x40: r.u8(); emit(name); break;
        case 0x41: case 0x42: emit(`${name} ${readSleb(r)}`); break;
        case 0x43: r.bytesSlice(4); emit(name); break;
        case 0x44: r.bytesSlice(8); emit(name); break;
        case 0xd0: r.u8(); emit(name); break;
        case 0xd2: { const f = r.uleb(); calls.add(f); emit(`${name} $${names.get(f) ?? f}`); break; }
        case 0xfc: decodeFc(r, emit); break;
        default:
          if (op >= 0x28 && op <= 0x3e) {
            r.uleb(); // align
            emit(`${name} offset=${r.uleb()}`);
          } else if ((op >= 0x45 && op <= 0xc4) || op === 0x00 || op === 0x01 || op === 0x0f || op === 0x1a || op === 0x1b || op === 0xd1) {
            emit(name); // no immediates
          } else {
            throw new RangeError(`unsupported opcode 0x${op.toString(16)} at +${r.pos - 1}`);
          }
      }
    }
    if (lines.length >= MAX_LISTING_LINES) lines.push("  ;; … listing truncated");
    return { ok: true, calls: [...calls], listing: lines.join("\n") };
  } catch (e) {
    return { ok: false, error: (e as Error).message, calls: [...calls], listing: lines.join("\n") };
  }
}

function decodeFc(r: ByteReader, emit: (s: string) => void): void {
  const sub = r.uleb();
  switch (sub) {
    case 8: r.uleb(); r.u8(); break; // memory.init
    case 9: case 13: r.uleb(); break; // data.drop / elem.drop
    case 10: r.u8(); r.u8(); break; // memory.copy
    case 11: r.u8(); break; // memory.fill
    case 12: case 14: r.uleb(); r.uleb(); break; // table.init / table.copy
    case 15: case 16: case 17: r.uleb(); break; // table.grow/size/fill
    default: if (sub > 7) throw new RangeError(`unsupported 0xfc sub-opcode ${sub}`);
  }
  emit(`misc.${sub}`);
}

function readBlockType(r: ByteReader): void {
  const b = r.bytes[r.pos];
  if (b === 0x40 || (b !== undefined && b >= 0x6f && b <= 0x7f)) r.u8();
  else readSleb(r); // type index (s33)
}

function readSleb(r: ByteReader): number {
  let result = 0;
  let shift = 0;
  let byte: number;
  do {
    byte = r.u8();
    if (shift < 32) result |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  if (shift < 32 && byte & 0x40) result |= -1 << shift;
  return result;
}

function valType(b: number): string {
  return ({ 0x7f: "i32", 0x7e: "i64", 0x7d: "f32", 0x7c: "f64", 0x7b: "v128", 0x70: "funcref", 0x6f: "externref" } as Record<number, string>)[b] ?? `t${b}`;
}
