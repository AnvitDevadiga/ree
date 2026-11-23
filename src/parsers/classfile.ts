/**
 * Bounded Java class-file reader (JVMS §4).
 *
 * Gives REE a no-tool baseline for Java: class name, superclass, interfaces,
 * fields, methods (with descriptors) and every class the constant pool
 * references — a precise class-level reference graph straight from bytecode.
 * String constants are returned separately so they pass through the sanitizer;
 * names are untrusted too (bytecode names can contain almost any character).
 */
export interface ClassInfo {
  name: string;
  superName?: string;
  interfaces: string[];
  fields: Array<{ name: string; desc: string; access: number }>;
  methods: Array<{ name: string; desc: string; access: number }>;
  /** Classes referenced from the constant pool (dotted names). */
  references: string[];
  /** CONSTANT_String values. */
  strings: string[];
  major: number;
  minor: number;
  access: number;
  sourceFile?: string;
}

export class ClassFileError extends Error {}

const MAX_MEMBERS = 65_535;
const MAX_STRINGS = 10_000;

export function javaVersion(major: number): string {
  return major >= 49 ? String(major - 44) : major >= 45 ? `1.${major - 44}` : "?";
}

const dotted = (internal: string) => internal.replace(/\//g, ".");

export function parseClassFile(b: Uint8Array): ClassInfo {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 0;
  const need = (n: number) => {
    if (p + n > b.length) throw new ClassFileError("truncated class file");
  };
  const u1 = () => (need(1), dv.getUint8(p++));
  const u2 = () => {
    need(2);
    const v = dv.getUint16(p);
    p += 2;
    return v;
  };
  const u4 = () => {
    need(4);
    const v = dv.getUint32(p);
    p += 4;
    return v;
  };

  if (u4() !== 0xcafebabe) throw new ClassFileError("not a Java class file");
  const minor = u2();
  const major = u2();
  if (major < 45 || major > 200) throw new ClassFileError(`implausible class-file version ${major}`);

  const cpCount = u2();
  const utf8: (string | undefined)[] = new Array(cpCount);
  const classIdx: (number | undefined)[] = new Array(cpCount);
  const stringIdx: number[] = [];
  const dec = new TextDecoder("utf-8", { fatal: false });
  for (let i = 1; i < cpCount; i++) {
    const tag = u1();
    switch (tag) {
      case 1: {
        const len = u2();
        need(len);
        // Modified UTF-8 differs from UTF-8 only for NUL and supplementary chars.
        utf8[i] = dec.decode(b.subarray(p, p + len));
        p += len;
        break;
      }
      case 7:
        classIdx[i] = u2();
        break;
      case 8:
        stringIdx.push(u2());
        break;
      case 3: case 4: case 9: case 10: case 11: case 12: case 17: case 18:
        p += 4;
        break;
      case 5: case 6:
        p += 8;
        i++; // longs and doubles take two slots
        break;
      case 15:
        p += 3;
        break;
      case 16: case 19: case 20:
        p += 2;
        break;
      default:
        throw new ClassFileError(`unknown constant-pool tag ${tag} at entry ${i}`);
    }
    need(0);
  }
  const cls = (i: number) => {
    const n = classIdx[i];
    return n !== undefined ? utf8[n] : undefined;
  };

  const access = u2();
  const self = cls(u2());
  if (!self) throw new ClassFileError("class name missing from constant pool");
  const superI = u2();
  const superName = superI ? cls(superI) : undefined;
  const interfaces: string[] = [];
  const ifCount = u2();
  for (let i = 0; i < ifCount; i++) {
    const n = cls(u2());
    if (n) interfaces.push(dotted(n));
  }

  const skipAttributes = (onAttr?: (name: string, start: number, len: number) => void) => {
    const count = u2();
    for (let i = 0; i < count; i++) {
      const name = utf8[u2()] ?? "";
      const len = u4();
      need(len);
      onAttr?.(name, p, len);
      p += len;
    }
  };
  const members = () => {
    const out: Array<{ name: string; desc: string; access: number }> = [];
    const count = Math.min(u2(), MAX_MEMBERS);
    for (let i = 0; i < count; i++) {
      const acc = u2();
      const name = utf8[u2()] ?? "?";
      const desc = utf8[u2()] ?? "?";
      skipAttributes();
      out.push({ name, desc, access: acc });
    }
    return out;
  };
  const fields = members();
  const methods = members();
  let sourceFile: string | undefined;
  skipAttributes((name, start) => {
    if (name === "SourceFile") sourceFile = utf8[dv.getUint16(start)];
  });

  const references = new Set<string>();
  for (let i = 1; i < cpCount; i++) {
    const n = cls(i);
    if (!n || n === self) continue;
    // Array descriptors like "[Ljava/lang/String;" name their element type.
    const m = /^\[+L(.+);$/.exec(n);
    const base = m ? m[1]! : n.startsWith("[") ? null : n;
    if (base) references.add(dotted(base));
  }
  const strings: string[] = [];
  for (const i of stringIdx) {
    if (strings.length >= MAX_STRINGS) break;
    const s = utf8[i];
    if (s !== undefined) strings.push(s);
  }

  return {
    name: dotted(self),
    superName: superName ? dotted(superName) : undefined,
    interfaces,
    fields,
    methods,
    references: [...references],
    strings,
    major,
    minor,
    access,
    sourceFile,
  };
}

/** `([Ljava/lang/String;)V` → `(String[]) void` for readable summaries. */
export function prettyDescriptor(desc: string): string {
  const one = (d: string, i: { p: number }): string => {
    let dims = 0;
    while (d[i.p] === "[") (dims++, i.p++);
    const c = d[i.p++];
    let t: string;
    if (c === "L") {
      const end = d.indexOf(";", i.p);
      t = d.slice(i.p, end).split("/").pop()!.replace(/\$/g, ".");
      i.p = end + 1;
    } else t = ({ B: "byte", C: "char", D: "double", F: "float", I: "int", J: "long", S: "short", Z: "boolean", V: "void" } as Record<string, string>)[c ?? ""] ?? "?";
    return t + "[]".repeat(dims);
  };
  try {
    const i = { p: 1 };
    const params: string[] = [];
    while (desc[i.p] !== ")" && i.p < desc.length) params.push(one(desc, i));
    i.p++;
    return `(${params.join(", ")}) ${one(desc, i)}`;
  } catch {
    return desc;
  }
}
