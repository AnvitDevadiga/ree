/**
 * Native binary parser for ELF, Mach-O, and PE.
 *
 * A structural parser, not a disassembler: it validates the container and
 * recovers sections, defined function symbols, imported symbols, the entry
 * point, and a bounded string table. Defined functions become CodeUnits; imports
 * are recorded as boundary evidence (they tell triage which OS/library APIs the
 * program touches).
 *
 * REE does not disassemble machine code, so no call graph exists here:
 * `graphComplete` is false and nothing is pruned. Deeper decompilation is the
 * job of an external disassembler; REE's role for native targets is budget-safe
 * triage — a compact symbol/import/string skeleton instead of raw bytes.
 */
import { decompileWithGhidra, findGhidra, GHIDRA } from "../tools/ghidra.js";
import { installHint } from "../tools/external.js";
import type { ArtifactFormat, ArtifactModel, CodeUnit, EntryPoint, ExtractedString, Parser, ParserInput } from "../core/types.js";
import { ByteReader, extractStrings } from "./reader.js";

const MAX_SYMBOLS = 100_000;

export class NativeParser implements Parser {
  readonly format = "elf" as const; // representative; parse() reports the detected format

  canParse(input: ParserInput): boolean {
    return detectNative(input.bytes) !== "unknown";
  }

  async parse(input: ParserInput): Promise<ArtifactModel> {
    const fmt = detectNative(input.bytes);
    let model: ArtifactModel;
    try {
      if (fmt === "elf") model = parseElf(input);
      else if (fmt === "macho") model = parseMachO(input);
      else if (fmt === "pe") model = parsePe(input);
      else return stringsOnly(input, "unknown", "unrecognized native format");
    } catch (e) {
      model = stringsOnly(input, fmt, `structural parse failed: ${(e as Error).message}`);
    }
    return enrichWithGhidra(model, input.path);
  }
}

/** Structure-only parse (no Ghidra), for callers that embed a native binary (e.g. an .ipa). */
export function parseNativeStructure(input: ParserInput): ArtifactModel {
  const fmt = detectNative(input.bytes);
  try {
    if (fmt === "elf") return parseElf(input);
    if (fmt === "macho") return parseMachO(input);
    if (fmt === "pe") return parsePe(input);
  } catch (e) {
    return stringsOnly(input, fmt, `structural parse failed: ${(e as Error).message}`);
  }
  return stringsOnly(input, "unknown", "unrecognized native format");
}

/**
 * Optional: decompile functions to C with Ghidra headless and merge them into
 * the structural model — by name (Mach-O's leading underscore tolerated), then
 * by address; functions only Ghidra found (stripped binaries) become new units;
 * callees become reference edges. Without Ghidra, the model is unchanged and
 * the limitations report gives the install command.
 */
async function enrichWithGhidra(model: ArtifactModel, path: string): Promise<ArtifactModel> {
  const tool = process.env.REE_DISABLE_GHIDRA ? null : findGhidra();
  if (!tool) return { ...model, meta: { ...model.meta, decompiler: "none", ghidraInstall: installHint(GHIDRA) } };
  let result;
  try {
    result = await decompileWithGhidra(tool, path);
  } catch (e) {
    return {
      ...model,
      warnings: [...model.warnings, `Ghidra failed: ${(e as Error).message}; structure-only analysis kept`],
      meta: { ...model.meta, decompiler: "none", ghidraFailed: true },
    };
  }
  const norm = (n: string) => n.replace(/^_+/, "");
  const units = model.units.map((u) => ({ ...u, meta: { ...u.meta } }));
  const byName = new Map<string, CodeUnit>();
  const byAddr = new Map<number, CodeUnit>();
  for (const u of units) {
    if (u.kind !== "function") continue;
    if (!byName.has(norm(u.name))) byName.set(norm(u.name), u);
    if (typeof u.offset === "number") byAddr.set(u.offset, u);
  }
  let matched = 0;
  let added = 0;
  let withC = 0;
  const unitOf = new Map<string, CodeUnit>();
  for (const f of result.functions) {
    const addr = Number.parseInt(f.entry.replace(/^.*:/, ""), 16);
    let u = byName.get(norm(f.name)) ?? (Number.isFinite(addr) ? byAddr.get(addr) : undefined);
    if (u) matched++;
    else {
      u = { id: `ghidra:${f.entry}`, name: f.name, kind: "function", offset: Number.isFinite(addr) ? addr : undefined, references: [], meta: { addr: `0x${f.entry}`, refToken: f.name } };
      units.push(u);
      byName.set(norm(f.name), u);
      added++;
    }
    if (f.c) {
      u.body = f.c;
      withC++;
    }
    u.meta = { ...u.meta, decompiler: "ghidra", signature: f.signature };
    unitOf.set(norm(f.name), u);
  }
  for (const f of result.functions) {
    const u = unitOf.get(norm(f.name));
    if (!u) continue;
    const refs = new Set(u.references);
    for (const c of f.callees) {
      const t = unitOf.get(norm(c)) ?? byName.get(norm(c));
      if (t && t.id !== u.id) refs.add(t.id);
    }
    u.references = [...refs];
  }
  const warnings = [...model.warnings];
  if (result.rejected) warnings.push(`${result.rejected} malformed line(s) in Ghidra output were ignored`);
  return {
    ...model,
    units,
    warnings,
    meta: { ...model.meta, decompiler: "ghidra", ghidraFunctions: result.functions.length, ghidraWithC: withC, ghidraMatched: matched, ghidraAdded: added },
  };
}

export function detectNative(b: Uint8Array): ArtifactFormat {
  if (b.length < 4) return "unknown";
  if (b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) return "elf";
  const be = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(be)) return "macho";
  // 0xcafebabe is shared with Java class files; universal binaries have a small arch count.
  if (be === 0xcafebabe && b.length >= 8 && ((b[4]! << 24) | (b[5]! << 16) | (b[6]! << 8) | b[7]!) < 32) return "macho";
  if (b[0] === 0x4d && b[1] === 0x5a) return "pe";
  return "unknown";
}

class SymbolTable {
  readonly units: CodeUnit[] = [];
  readonly imports: string[] = [];
  private readonly byAddr = new Map<number, CodeUnit>();

  addFunction(name: string, addr: number, size?: number): void {
    if (!name || this.units.length >= MAX_SYMBOLS) return;
    const existing = this.byAddr.get(addr);
    if (existing) {
      const aliases = (existing.meta.aliases as string[] | undefined) ?? [];
      if (existing.name !== name && aliases.length < 16) aliases.push(name);
      existing.meta.aliases = aliases;
      return;
    }
    const unit: CodeUnit = {
      id: `sym:${addr.toString(16)}`,
      name,
      kind: "function",
      offset: addr,
      size,
      references: [],
      meta: { addr: `0x${addr.toString(16)}`, refToken: name },
    };
    this.byAddr.set(addr, unit);
    this.units.push(unit);
  }

  addImport(name: string): void {
    if (name && this.imports.length < MAX_SYMBOLS) this.imports.push(name);
  }

  at(addr: number): CodeUnit | undefined {
    return this.byAddr.get(addr);
  }

  named(...names: string[]): CodeUnit | undefined {
    return this.units.find((u) => names.includes(u.name));
  }
}

function finish(
  input: ParserInput,
  format: ArtifactFormat,
  syms: SymbolTable,
  entry: EntryPoint | undefined,
  strings: string[],
  warnings: string[],
  meta: Record<string, unknown>,
): ArtifactModel {
  const out: ExtractedString[] = [];
  const seen = new Set<string>();
  const push = (value: string, source: ExtractedString["source"]) => {
    const k = `${source}:${value}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push({ value, source });
    }
  };
  for (const u of syms.units) push(u.name, "symbol");
  for (const i of syms.imports) push(i, "symbol");
  for (const s of strings) push(s, "section");
  return {
    format,
    sourcePath: input.path,
    byteLength: input.bytes.length,
    units: syms.units,
    strings: out,
    entryPoints: entry ? [entry] : [],
    warnings,
    meta: { ...meta, imports: syms.imports.slice(0, 2000), importCount: syms.imports.length, graphComplete: false },
  };
}

function stringsOnly(input: ParserInput, format: ArtifactFormat, warning: string): ArtifactModel {
  return {
    format,
    sourcePath: input.path,
    byteLength: input.bytes.length,
    units: [],
    strings: extractStrings(input.bytes, 5, 5000).map((v) => ({ value: v, source: "section" as const })),
    entryPoints: [],
    warnings: [warning],
    meta: { graphComplete: false },
  };
}

// ---------------------------------------------------------------------------
// ELF
// ---------------------------------------------------------------------------
function parseElf(input: ParserInput): ArtifactModel {
  const b = input.bytes;
  const warnings: string[] = [];
  const is64 = b[4] === 2;
  const le = b[5] === 1;
  const r = new ByteReader(b);
  const word = () => (is64 ? Number(r.u64(le)) : r.u32(le));

  r.seek(24);
  const entry = word();
  word(); // phoff
  const shoff = word();
  r.u32(le); // flags
  r.u16(le); r.u16(le); r.u16(le); // ehsize, phentsize, phnum
  const shentsize = r.u16(le);
  const shnum = r.u16(le);
  const shstrndx = r.u16(le);

  interface Sect { nameOff: number; name: string; type: number; addr: number; offset: number; size: number; link: number; entsize: number }
  const sects: Sect[] = [];
  for (let i = 0; i < shnum; i++) {
    const base = shoff + i * shentsize;
    if (base + shentsize > b.length) {
      warnings.push("section headers truncated");
      break;
    }
    r.seek(base);
    const nameOff = r.u32(le);
    const type = r.u32(le);
    word(); // flags
    const addr = word();
    const offset = word();
    const size = word();
    const link = r.u32(le);
    r.u32(le); // info
    word(); // addralign
    const entsize = word();
    sects.push({ nameOff, name: "", type, addr, offset, size, link, entsize });
  }
  const shstr = sects[shstrndx];
  for (const s of sects) s.name = shstr ? readCStr(b, shstr.offset + s.nameOff) : "";

  const syms = new SymbolTable();
  for (const st of sects.filter((s) => s.type === 2 || s.type === 11)) {
    const strtab = sects[st.link];
    if (!strtab || st.entsize === 0) continue;
    const count = Math.floor(st.size / st.entsize);
    for (let i = 0; i < count; i++) {
      const base = st.offset + i * st.entsize;
      if (base + st.entsize > b.length) break;
      r.seek(base);
      let info: number, shndx: number, value: number, size: number;
      const nameOff = r.u32(le);
      if (is64) {
        info = r.u8(); r.u8(); shndx = r.u16(le);
        value = Number(r.u64(le)); size = Number(r.u64(le));
      } else {
        value = r.u32(le); size = r.u32(le);
        info = r.u8(); r.u8(); shndx = r.u16(le);
      }
      if ((info & 0xf) !== 2) continue; // STT_FUNC
      const name = readCStr(b, strtab.offset + nameOff);
      if (shndx === 0) syms.addImport(name);
      else syms.addFunction(name, value, size);
    }
  }

  const strings: string[] = [];
  for (const s of sects.filter((s) => /^\.(rodata|data\.rel\.ro|comment)/.test(s.name) && s.type !== 8)) {
    strings.push(...extractStrings(b.subarray(s.offset, Math.min(s.offset + s.size, b.length)), 5, 5000));
  }

  const target = syms.at(entry) ?? syms.named("main", "_start");
  const ep: EntryPoint | undefined = target ? { unitId: target.id, reason: "start-section", detail: `e_entry 0x${entry.toString(16)}` } : undefined;
  if (!syms.units.length) warnings.push("no function symbols (stripped binary); triage relies on imports and strings");

  return finish(input, "elf", syms, ep, strings, warnings, {
    bits: is64 ? 64 : 32,
    entry: `0x${entry.toString(16)}`,
    sections: sects.map((s) => s.name).filter(Boolean),
  });
}

// ---------------------------------------------------------------------------
// Mach-O
// ---------------------------------------------------------------------------
function parseMachO(input: ParserInput): ArtifactModel {
  const b = input.bytes;
  const head = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
  if (head === 0xcafebabe) return parseFat(input);

  const warnings: string[] = [];
  const le = head === 0xcefaedfe || head === 0xcffaedfe;
  const is64 = head === 0xfeedfacf || head === 0xcffaedfe;
  const r = new ByteReader(b);
  r.seek(16);
  const ncmds = r.u32(le);
  r.seek(is64 ? 32 : 28);

  let entryoff: number | undefined;
  let textVmaddr = 0;
  let textFileoff = 0;
  let symoff = 0, nsyms = 0, stroff = 0;
  const dylibs: string[] = [];

  for (let i = 0; i < ncmds; i++) {
    const start = r.pos;
    const cmd = r.u32(le);
    const size = r.u32(le);
    if (size < 8 || start + size > b.length) {
      warnings.push("malformed load command");
      break;
    }
    if (cmd === 0x80000028) entryoff = Number(r.u64(le)); // LC_MAIN
    else if (cmd === 0x2) { symoff = r.u32(le); nsyms = r.u32(le); stroff = r.u32(le); } // LC_SYMTAB
    else if (cmd === 0x19 || cmd === 0x1) { // LC_SEGMENT_64 / LC_SEGMENT
      const segname = readCStr(b, r.pos, 16);
      r.seek(r.pos + 16);
      const vmaddr = is64 ? Number(r.u64(le)) : r.u32(le);
      if (is64) r.u64(le); else r.u32(le); // vmsize
      const fileoff = is64 ? Number(r.u64(le)) : r.u32(le);
      if (segname === "__TEXT") { textVmaddr = vmaddr; textFileoff = fileoff; }
    } else if (cmd === 0xc || cmd === 0x80000018 || cmd === 0xd) { // LC_LOAD_DYLIB / WEAK / ID
      const nameOff = r.u32(le);
      dylibs.push(readCStr(b, start + nameOff));
    }
    r.seek(start + size);
  }

  const syms = new SymbolTable();
  const nlist = is64 ? 16 : 12;
  for (let i = 0; i < nsyms; i++) {
    const base = symoff + i * nlist;
    if (base + nlist > b.length) break;
    r.seek(base);
    const strx = r.u32(le);
    const type = r.u8();
    const sect = r.u8();
    r.u16(le);
    const value = is64 ? Number(r.u64(le)) : r.u32(le);
    if (type & 0xe0) continue; // debugging (stab) entry
    const name = readCStr(b, stroff + strx);
    const kind = type & 0x0e;
    if (kind === 0x0 && (type & 0x1)) syms.addImport(name); // N_UNDF | N_EXT
    else if (kind === 0x0e && sect === 1) syms.addFunction(name, value); // N_SECT in __text
  }

  let ep: EntryPoint | undefined;
  if (entryoff !== undefined) {
    const addr = textVmaddr - textFileoff + entryoff;
    const u = syms.at(addr) ?? syms.named("_main");
    if (u) ep = { unitId: u.id, reason: "start-section", detail: `LC_MAIN entryoff 0x${entryoff.toString(16)}` };
  }

  return finish(input, "macho", syms, ep, extractStrings(b, 6, 5000), warnings, {
    bits: is64 ? 64 : 32,
    entryoff: entryoff !== undefined ? `0x${entryoff.toString(16)}` : undefined,
    dylibs,
  });
}

function parseFat(input: ParserInput): ArtifactModel {
  const b = input.bytes;
  const r = new ByteReader(b);
  r.seek(4);
  const n = r.u32(false);
  const arches: Array<{ cputype: number; offset: number; size: number }> = [];
  for (let i = 0; i < n; i++) {
    const cputype = r.u32(false);
    r.u32(false); // subtype
    const offset = r.u32(false);
    const size = r.u32(false);
    r.u32(false); // align
    arches.push({ cputype, offset, size });
  }
  // Analyze the first slice (prefer arm64 = 0x0100000c).
  const pick = arches.find((a) => a.cputype === 0x0100000c) ?? arches[0];
  if (!pick || pick.offset + pick.size > b.length) return stringsOnly(input, "macho", "universal binary with no readable slice");
  const slice = parseMachO({ ...input, bytes: b.subarray(pick.offset, pick.offset + pick.size) });
  slice.byteLength = b.length;
  slice.warnings.unshift(`universal binary: ${arches.length} slice(s); analyzed cputype 0x${pick.cputype.toString(16)}`);
  return slice;
}

// ---------------------------------------------------------------------------
// PE / COFF
// ---------------------------------------------------------------------------
function parsePe(input: ParserInput): ArtifactModel {
  const b = input.bytes;
  const warnings: string[] = [];
  const r = new ByteReader(b);
  r.seek(0x3c);
  const peOff = r.u32(true);
  if (peOff + 24 > b.length || b[peOff] !== 0x50 || b[peOff + 1] !== 0x45) {
    return stringsOnly(input, "pe", "MZ header without a valid PE signature");
  }
  r.seek(peOff + 6);
  const numSections = r.u16(true);
  r.u32(true); // timestamp
  const symOff = r.u32(true);
  const numSyms = r.u32(true);
  const optSize = r.u16(true);
  r.u16(true); // characteristics
  const opt = r.pos;
  const pe32plus = r.u16(true) === 0x20b;
  r.seek(opt + 16);
  const entryRva = r.u32(true);
  const ddBase = opt + (pe32plus ? 112 : 96);
  const dataDir = (i: number) => {
    if (ddBase + i * 8 + 8 > opt + optSize) return { rva: 0, size: 0 };
    r.seek(ddBase + i * 8);
    return { rva: r.u32(true), size: r.u32(true) };
  };

  interface Sect { name: string; vaddr: number; vsize: number; rawOff: number; rawSize: number }
  const sects: Sect[] = [];
  const sectBase = opt + optSize;
  for (let i = 0; i < numSections; i++) {
    const base = sectBase + i * 40;
    if (base + 40 > b.length) break;
    r.seek(base + 8);
    const vsize = r.u32(true);
    const vaddr = r.u32(true);
    const rawSize = r.u32(true);
    const rawOff = r.u32(true);
    sects.push({ name: readCStr(b, base, 8), vaddr, vsize, rawOff, rawSize });
  }
  const rvaToOff = (rva: number): number => {
    for (const s of sects) if (rva >= s.vaddr && rva < s.vaddr + Math.max(s.vsize, s.rawSize)) return rva - s.vaddr + s.rawOff;
    return -1;
  };

  const syms = new SymbolTable();

  // Export directory (index 0).
  const exp = dataDir(0);
  const expOff = exp.rva ? rvaToOff(exp.rva) : -1;
  if (expOff > 0 && expOff + 40 <= b.length) {
    r.seek(expOff + 24);
    const nNames = r.u32(true);
    const funcsOff = rvaToOff(r.u32(true));
    const namesOff = rvaToOff(r.u32(true));
    const ordsOff = rvaToOff(r.u32(true));
    for (let i = 0; i < Math.min(nNames, MAX_SYMBOLS) && namesOff > 0 && ordsOff > 0 && funcsOff > 0; i++) {
      r.seek(namesOff + i * 4);
      const name = readCStr(b, rvaToOff(r.u32(true)));
      r.seek(ordsOff + i * 2);
      const ord = r.u16(true);
      r.seek(funcsOff + ord * 4);
      const rva = r.u32(true);
      const isForwarder = rva >= exp.rva && rva < exp.rva + exp.size;
      if (isForwarder) syms.addImport(`${name} -> ${readCStr(b, rvaToOff(rva))}`);
      else syms.addFunction(name, rva);
    }
  }

  // Import directory (index 1).
  const imp = dataDir(1);
  let impOff = imp.rva ? rvaToOff(imp.rva) : -1;
  for (let d = 0; impOff > 0 && impOff + 20 <= b.length && d < 4096; d++, impOff += 20) {
    r.seek(impOff);
    const oft = r.u32(true);
    r.u32(true); r.u32(true);
    const nameRva = r.u32(true);
    const ft = r.u32(true);
    if (!nameRva) break;
    const dll = readCStr(b, rvaToOff(nameRva));
    let thunk = rvaToOff(oft || ft);
    for (let t = 0; thunk > 0 && t < 10000; t++) {
      r.seek(thunk);
      const entry = pe32plus ? r.u64(true) : BigInt(r.u32(true));
      if (entry === 0n) break;
      const byOrdinal = pe32plus ? (entry & (1n << 63n)) !== 0n : (entry & 0x80000000n) !== 0n;
      syms.addImport(byOrdinal ? `${dll}!#${Number(entry & 0xffffn)}` : `${dll}!${readCStr(b, rvaToOff(Number(entry & 0x7fffffffn)) + 2)}`);
      thunk += pe32plus ? 8 : 4;
    }
  }

  // COFF symbols (usually stripped from release images).
  const strBase = symOff + numSyms * 18;
  for (let i = 0; symOff && i < numSyms && i < MAX_SYMBOLS; i++) {
    const base = symOff + i * 18;
    if (base + 18 > b.length) break;
    r.seek(base);
    const zeros = r.u32(true);
    const name = zeros === 0 ? readCStr(b, strBase + r.u32(true)) : readCStr(b, base, 8);
    r.seek(base + 8);
    const value = r.u32(true);
    const sectNum = r.u16(true);
    const type = r.u16(true);
    const cls = r.u8();
    const aux = r.u8();
    if (cls === 2 && sectNum > 0 && (type >> 4) === 2) {
      const s = sects[sectNum - 1];
      syms.addFunction(name, (s?.vaddr ?? 0) + value);
    }
    i += aux;
  }

  const strings: string[] = [];
  for (const s of sects.filter((s) => /^\.(rdata|data)/.test(s.name))) {
    strings.push(...extractStrings(b.subarray(s.rawOff, Math.min(s.rawOff + s.rawSize, b.length)), 5, 4000));
  }

  const target = syms.at(entryRva);
  const ep: EntryPoint | undefined = target ? { unitId: target.id, reason: "start-section", detail: `AddressOfEntryPoint 0x${entryRva.toString(16)}` } : undefined;

  return finish(input, "pe", syms, ep, strings, warnings, {
    pe32plus,
    entryRva: `0x${entryRva.toString(16)}`,
    sections: sects.map((s) => s.name),
  });
}

function readCStr(b: Uint8Array, off: number, max = 4096): string {
  if (off < 0 || off >= b.length) return "";
  let end = off;
  const limit = Math.min(off + max, b.length);
  while (end < limit && b[end] !== 0) end++;
  return new TextDecoder().decode(b.subarray(off, end));
}
