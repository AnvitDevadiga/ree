/**
 * CPython bytecode (`.pyc`) parser.
 *
 * Reads the 16-byte PEP 552 header, then unmarshals the module code object with
 * a complete implementation of the marshal type codes used by CPython 3.7+.
 * Code-object field order differs by version, so the layout is chosen from the
 * magic number:
 *   3.7        argcount kwonly nlocals stacksize flags | code consts names varnames freevars cellvars filename name firstlineno lnotab
 *   3.8–3.10   argcount posonly kwonly nlocals stacksize flags | (same as 3.7)
 *   3.11+      argcount posonly kwonly stacksize flags | code consts names localsplusnames localspluskinds filename name qualname firstlineno linetable exceptiontable
 *
 * Every nested code object (functions, classes, lambdas, comprehensions) becomes
 * a CodeUnit carrying its parameters, referenced names, and string constants.
 * REE does not yet recover a call graph from bytecode, so `graphComplete` is
 * false and the reachability pass never prunes .pyc units.
 */
import type { ArtifactModel, CodeUnit, ExtractedString, Parser, ParserInput } from "../core/types.js";
import { ByteReader } from "./reader.js";
import { decompilePyc, pickPyDecompiler, pyDecompileHint, splitTopLevel } from "../tools/pydecompile.js";

/**
 * Optional: decompile with the best available tool (see tools/pydecompile.ts)
 * and attach source to the code-object units — top-level functions to
 * `<module>.name`, classes (methods included) to `<module>.Class`, the rest to
 * `<module>`. Method/nested code objects inside a class that received source
 * are folded into it. On failure or with no tool, structure is kept.
 */
async function enrichWithDecompiler(model: ArtifactModel, path: string): Promise<ArtifactModel> {
  const magic = (model.meta as { magic?: number }).magic ?? 0;
  const tool = pickPyDecompiler(magic);
  if (!tool) return { ...model, meta: { ...model.meta, decompiler: "none", decompileHint: pyDecompileHint(magic) } };
  let result;
  try {
    result = await decompilePyc(tool, path);
  } catch (e) {
    return {
      ...model,
      warnings: [...model.warnings, `${(e as Error).message}; structure-only analysis kept`],
      meta: { ...model.meta, decompiler: "none", decompileFailed: tool.spec.bin, decompileHint: pyDecompileHint(magic) },
    };
  }
  const { blocks, module } = splitTopLevel(result.source);
  const units = model.units.map((u) => ({ ...u, meta: { ...u.meta } }));
  let attached = 0;
  for (const u of units) {
    if (u.name === "<module>") {
      if (module) (u.body = module), attached++;
      continue;
    }
    const m = /^<module>\.([^.]+)$/.exec(u.name);
    const block = m ? blocks.get(m[1]!) : undefined;
    if (block) {
      u.body = block;
      u.meta = { ...u.meta, decompiler: result.tool };
      attached++;
    }
  }
  // Code objects nested in a block that now has source are part of that source.
  const withSource = new Set(units.filter((u) => u.body && u.name !== "<module>").map((u) => u.name));
  const kept = units.filter((u) => {
    const top = /^(<module>\.[^.]+)\./.exec(u.name)?.[1];
    return !(top && withSource.has(top));
  });
  const live = new Set(kept.map((u) => u.id));
  for (const u of kept) u.references = u.references.filter((r) => live.has(r));
  return {
    ...model,
    units: kept,
    meta: { ...model.meta, decompiler: result.tool, decompiledBlocks: attached, decompileIncomplete: result.incomplete },
  };
}

const FLAG_REF = 0x80;
const NULL = Symbol("marshal-null");

interface PyCode {
  __code: true;
  name: string;
  qualname: string;
  filename: string;
  argcount: number;
  posonly: number;
  kwonly: number;
  flags: number;
  firstlineno: number;
  names: string[];
  localNames: string[];
  consts: unknown[];
  code: Uint8Array;
}

type Layout = "py37" | "py38" | "py311";

export function pythonVersionFromMagic(magic: number): string {
  if (magic < 3394) return `<3.7 (${magic})`;
  if (magic < 3413) return "3.7";
  if (magic < 3425) return "3.8";
  if (magic < 3439) return "3.9";
  if (magic < 3450) return "3.10";
  if (magic < 3500) return "3.11";
  if (magic < 3550) return "3.12";
  if (magic < 3600) return "3.13";
  return "3.14+";
}

function layoutFor(magic: number): Layout {
  if (magic < 3413) return "py37";
  if (magic < 3450) return "py38";
  return "py311";
}

export class PycParser implements Parser {
  readonly format = "pyc" as const;

  canParse(input: ParserInput): boolean {
    const b = input.bytes;
    if (b.length < 16 || b[2] !== 0x0d || b[3] !== 0x0a) return false;
    const magic = b[0]! | (b[1]! << 8);
    return magic >= 3000 && magic < 4000;
  }

  async parse(input: ParserInput): Promise<ArtifactModel> {
    return enrichWithDecompiler(this.parseStructure(input), input.path);
  }

  private parseStructure(input: ParserInput): ArtifactModel {
    const warnings: string[] = [];
    const r = new ByteReader(input.bytes);
    const magic = r.u16();
    r.u16(); // \r\n
    const flags = r.u32(); // PEP 552 bit field (0 = timestamp-based, 1/3 = hash-based)
    r.seek(16);
    const version = pythonVersionFromMagic(magic);
    if (magic < 3394) warnings.push(`pre-3.7 bytecode (magic ${magic}); header/layout may not match`);

    const um = new Unmarshaller(r, layoutFor(magic));
    const units: CodeUnit[] = [];
    const strings: ExtractedString[] = [];

    let top: unknown;
    try {
      top = um.read();
    } catch (e) {
      warnings.push(`marshal decode stopped: ${(e as Error).message}`);
    }

    if (isCode(top)) {
      const visit = (code: PyCode, parent: string | undefined) => {
        const id = `pyc:${units.length}`;
        const name = parent ? `${parent}.${code.name}` : code.name;
        const params = code.localNames.slice(0, code.argcount + code.kwonly);
        const strConsts = code.consts.filter((c): c is string => typeof c === "string");
        const children = code.consts.filter(isCode);
        units.push({
          id,
          name,
          kind: code.name === "<module>" ? "module" : /^[A-Z]/.test(code.name) && !params.length ? "class" : "function",
          size: code.code.length,
          references: [],
          meta: {
            qualname: code.qualname,
            filename: code.filename,
            firstlineno: code.firstlineno,
            params,
            names: code.names.slice(0, 200),
            stringConsts: strConsts.slice(0, 100),
            children: children.map((c) => c.name),
            isAsync: (code.flags & 0x80) !== 0 || (code.flags & 0x100) !== 0,
            refToken: code.name,
          },
        });
        for (const s of strConsts) if (s.length >= 3) strings.push({ value: s, source: "literal", unitId: id });
        for (const child of children) visit(child, name);
      };
      visit(top, undefined);
    } else if (top !== undefined) {
      warnings.push("top-level marshal object is not a code object");
    }

    return {
      format: "pyc",
      sourcePath: input.path,
      byteLength: input.bytes.length,
      units,
      strings,
      entryPoints: units[0] ? [{ unitId: units[0].id, reason: "main", detail: "<module>" }] : [],
      warnings,
      meta: { pythonVersion: version, magic, headerFlags: flags, graphComplete: false },
    };
  }
}

function isCode(v: unknown): v is PyCode {
  return typeof v === "object" && v !== null && (v as PyCode).__code === true;
}

class Unmarshaller {
  private readonly refs: unknown[] = [];
  private depth = 0;

  constructor(private readonly r: ByteReader, private readonly layout: Layout) {}

  read(): unknown {
    if (++this.depth > 200) throw new RangeError("marshal nesting too deep");
    try {
      return this.readInner();
    } finally {
      this.depth--;
    }
  }

  private readInner(): unknown {
    const r = this.r;
    const raw = r.u8();
    const type = String.fromCharCode(raw & ~FLAG_REF);
    const slot = raw & FLAG_REF ? this.reserve() : -1;
    const keep = <T>(v: T): T => {
      if (slot >= 0) this.refs[slot] = v;
      return v;
    };

    switch (type) {
      case "0": return NULL;
      case "N": return null;
      case "F": return false;
      case "T": return true;
      case "S": return keep("StopIteration");
      case ".": return keep("Ellipsis");
      case "i": return keep(r.u32() | 0);
      case "l": {
        const n = r.u32() | 0;
        let value = 0;
        for (let i = 0, mul = 1; i < Math.abs(n); i++, mul *= 32768) value += r.u16() * mul;
        return keep(n < 0 ? -value : value);
      }
      case "f": return keep(Number(this.latin1(r.u8())));
      case "g": return keep(new DataView(r.bytesSlice(8).slice().buffer).getFloat64(0, true));
      case "x": { this.latin1(r.u8()); this.latin1(r.u8()); return keep("<complex>"); }
      case "y": { r.bytesSlice(16); return keep("<complex>"); }
      case "s": return keep(r.bytesSlice(this.len()).slice());
      case "t": case "u": return keep(new TextDecoder().decode(r.bytesSlice(this.len())));
      case "a": case "A": return keep(this.latin1(this.len()));
      case "z": case "Z": return keep(this.latin1(r.u8()));
      case "(": case "[": case "<": case ">": return this.readSeq(this.len(), keep);
      case ")": return this.readSeq(r.u8(), keep);
      case "{": {
        const obj: Record<string, unknown> = keep({});
        for (;;) {
          const k = this.read();
          if (k === NULL) break;
          obj[String(k)] = this.read();
        }
        return obj;
      }
      case ":": { // slice (marshal v5, 3.14+)
        const v = keep({ start: undefined as unknown, stop: undefined as unknown, step: undefined as unknown });
        v.start = this.read(); v.stop = this.read(); v.step = this.read();
        return v;
      }
      case "r": {
        const idx = r.u32();
        if (idx >= this.refs.length) throw new RangeError(`bad back-reference ${idx}`);
        return this.refs[idx];
      }
      case "c": return keep(this.readCode());
      default:
        throw new RangeError(`unknown marshal type '${type}' (0x${raw.toString(16)}) at ${r.pos - 1}`);
    }
  }

  private readSeq(n: number, keep: <T>(v: T) => T): unknown[] {
    const arr: unknown[] = keep([]);
    for (let i = 0; i < n; i++) arr.push(this.read());
    return arr;
  }

  private readCode(): PyCode {
    const r = this.r;
    const argcount = r.u32();
    const posonly = this.layout === "py37" ? 0 : r.u32();
    const kwonly = r.u32();
    if (this.layout !== "py311") r.u32(); // nlocals
    r.u32(); // stacksize
    const flags = r.u32();
    const code = this.read();
    const consts = this.read();
    const names = this.read();
    let localNames: unknown;
    let filename: unknown;
    let name: unknown;
    let qualname: unknown;
    if (this.layout === "py311") {
      localNames = this.read(); // co_localsplusnames
      this.read(); // co_localspluskinds
      filename = this.read();
      name = this.read();
      qualname = this.read();
    } else {
      localNames = this.read(); // co_varnames
      this.read(); // co_freevars
      this.read(); // co_cellvars
      filename = this.read();
      name = this.read();
    }
    const firstlineno = r.u32();
    this.read(); // lnotab / linetable
    if (this.layout === "py311") this.read(); // exceptiontable

    const strs = (v: unknown) => (Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : String(x))) : []);
    return {
      __code: true,
      name: typeof name === "string" ? name : "<unknown>",
      qualname: typeof qualname === "string" ? qualname : typeof name === "string" ? name : "<unknown>",
      filename: typeof filename === "string" ? filename : "",
      argcount,
      posonly,
      kwonly,
      flags,
      firstlineno,
      names: strs(names),
      localNames: strs(localNames),
      consts: Array.isArray(consts) ? consts : [],
      code: code instanceof Uint8Array ? code : new Uint8Array(0),
    };
  }

  private reserve(): number {
    this.refs.push(undefined);
    return this.refs.length - 1;
  }

  private len(): number {
    const n = this.r.u32();
    if (n > this.r.remaining()) throw new RangeError(`length ${n} exceeds remaining ${this.r.remaining()} bytes`);
    return n;
  }

  private latin1(n: number): string {
    let s = "";
    for (const b of this.r.bytesSlice(n)) s += String.fromCharCode(b);
    return s;
  }
}
