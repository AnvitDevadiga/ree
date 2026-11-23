/**
 * Format detection by content, not file name.
 *
 * `ree analyze <path>` must route any input correctly even when it has been
 * renamed or has no extension. Detection reads a bounded head and tail of the
 * file and decides from magic bytes and structure; the extension is only used
 * as a tie-breaker between two *text* interpretations, never to claim a binary.
 *
 * Every result says whether REE supports it today, and unsupported results carry
 * a short, specific hint so the CLI can print a helpful message instead of an
 * empty report.
 */
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

export type DetectedKind =
  | "asar"
  | "js-bundle"
  | "wasm"
  | "pyc"
  | "elf"
  | "macho"
  | "pe"
  | "dmg"
  | "app-bundle"
  | "directory"
  | "apk"
  | "aab"
  | "jar"
  | "ipa"
  | "zip"
  | "java-class"
  | "archive"
  | "text"
  | "unknown";

export interface Detection {
  kind: DetectedKind;
  /** Human label, e.g. "Electron .asar archive". */
  label: string;
  /** How REE handles it: a single-artifact parser, the app front-end, or not yet. */
  route: "parser" | "app" | "unsupported";
  /** For unsupported kinds: what to do instead, or what's planned. */
  hint?: string;
}

/** Bytes read from the start and end of the file for detection (hostile-input bound). */
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 1024 * 1024;

export const SUPPORTED_SUMMARY = [
  "Electron .asar archives",
  "JavaScript / webpack / esbuild / rollup bundles",
  "WebAssembly (.wasm)",
  "Python bytecode (.pyc, 3.7–3.14; structure only)",
  "ELF, Mach-O (incl. universal) and PE binaries (structure only)",
  "macOS .dmg images (macOS only) and .app bundles / extracted app directories",
];

export async function detectFormat(path: string): Promise<Detection> {
  const st = await stat(path);
  if (st.isDirectory()) {
    const isApp = path.replace(/\/+$/, "").toLowerCase().endsWith(".app") || existsSync(join(path, "Contents", "Info.plist"));
    return isApp
      ? { kind: "app-bundle", label: "macOS .app bundle", route: "app" }
      : { kind: "directory", label: "directory (scanned for .asar, executables and libraries)", route: "app" };
  }
  if (!st.isFile()) return { kind: "unknown", label: "not a regular file", route: "unsupported", hint: "point REE at a file or an app directory" };

  const fh = await open(path, "r");
  try {
    const headLen = Math.min(st.size, HEAD_BYTES);
    const head = Buffer.alloc(headLen);
    await fh.read(head, 0, headLen, 0);
    const tailLen = Math.min(st.size, TAIL_BYTES);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, st.size - tailLen);
    return classify(head, tail, path);
  } finally {
    await fh.close();
  }
}

/** Pure classification over a head and tail buffer. Exported for tests. */
export function classify(head: Uint8Array, tail: Uint8Array, path = ""): Detection {
  const b = head;
  const u32be = (o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
  const u32le = (o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
  const ascii = (o: number, s: string) => s.split("").every((c, i) => b[o + i] === c.charCodeAt(0));

  if (b.length >= 8 && ascii(0, "\0asm")) return { kind: "wasm", label: "WebAssembly module", route: "parser" };
  if (b.length >= 17 && u32le(0) === 4 && b[16] === 0x7b) return { kind: "asar", label: "Electron .asar archive", route: "parser" };
  if (b.length >= 16 && b[2] === 0x0d && b[3] === 0x0a) {
    const magic = b[0]! | (b[1]! << 8);
    if (magic >= 3000 && magic < 4000) return { kind: "pyc", label: "Python bytecode (.pyc)", route: "parser" };
  }
  if (b.length >= 4 && ascii(0, "\x7fELF")) return { kind: "elf", label: "ELF binary", route: "parser" };
  if (b.length >= 4) {
    const be = u32be(0);
    if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(be)) return { kind: "macho", label: "Mach-O binary", route: "parser" };
    if (be === 0xcafebabe && b.length >= 8) {
      // Shared magic: universal Mach-O has a small arch count; a Java class has major version >= 45.
      const second = u32be(4);
      if (second < 32) return { kind: "macho", label: "universal Mach-O binary", route: "parser" };
      return { kind: "java-class", label: "Java .class file", route: "unsupported", hint: "Java bytecode support (via an optional decompiler) is planned" };
    }
  }
  if (b.length >= 2 && b[0] === 0x4d && b[1] === 0x5a) return { kind: "pe", label: "PE (Windows) binary", route: "parser" };

  // UDIF disk image: 'koly' trailer 512 bytes from the end.
  if (tail.length >= 512 && String.fromCharCode(...tail.subarray(tail.length - 512, tail.length - 508)) === "koly") {
    return { kind: "dmg", label: "macOS .dmg disk image", route: "app" };
  }

  if (b.length >= 4 && ascii(0, "PK\x03\x04")) return classifyZip(tail);

  if (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) return { kind: "archive", label: "gzip archive", route: "unsupported", hint: "extract it first, then point REE at the contents" };
  if (b.length >= 6 && ascii(0, "\xfd7zXZ\0")) return { kind: "archive", label: "xz archive", route: "unsupported", hint: "extract it first, then point REE at the contents" };
  if (b.length >= 6 && ascii(0, "7z\xbc\xaf\x27\x1c")) return { kind: "archive", label: "7-Zip archive", route: "unsupported", hint: "extract it first, then point REE at the contents" };
  if (b.length >= 262 && ascii(257, "ustar")) return { kind: "archive", label: "tar archive", route: "unsupported", hint: "extract it first, then point REE at the contents" };
  if (b.length >= 5 && ascii(0, "%PDF-")) return { kind: "unknown", label: "PDF document", route: "unsupported", hint: "REE analyzes software artifacts, not documents" };

  if (isText(b)) {
    if (looksLikeJs(b) || /\.(m|c)?jsx?$/i.test(path)) return { kind: "js-bundle", label: "JavaScript source / bundle", route: "parser" };
    return { kind: "text", label: "text file (not recognized as JavaScript)", route: "unsupported", hint: "REE analyzes JavaScript; other text formats are not parsed" };
  }
  return { kind: "unknown", label: "unrecognized binary", route: "unsupported" };
}

function classifyZip(tail: Uint8Array): Detection {
  // The central directory (with every entry name in plain text) sits at the end.
  const names = Buffer.from(tail).toString("latin1");
  if (/base\/manifest\/AndroidManifest\.xml/.test(names)) return { kind: "aab", label: "Android App Bundle (.aab)", route: "unsupported", hint: "Android support (via the optional jadx decompiler) is planned" };
  if (/AndroidManifest\.xml/.test(names) && /classes\d*\.dex/.test(names)) return { kind: "apk", label: "Android APK", route: "unsupported", hint: "Android support (via the optional jadx decompiler) is planned" };
  if (/Payload\/[^/]+\.app\//.test(names)) return { kind: "ipa", label: "iOS app archive (.ipa)", route: "unsupported", hint: "structure-only .ipa support for unencrypted builds is planned" };
  if (/META-INF\/MANIFEST\.MF/.test(names) || /\.class/.test(names)) return { kind: "jar", label: "Java archive (.jar)", route: "unsupported", hint: "Java support (via an optional decompiler) is planned" };
  return { kind: "zip", label: "ZIP archive", route: "unsupported", hint: "extract it first, then point REE at the contents" };
}

function isText(b: Uint8Array): boolean {
  const n = Math.min(b.length, 8192);
  if (n === 0) return false;
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const c = b[i]!;
    if (c === 0) return false;
    if (c < 0x09 || (c > 0x0d && c < 0x20)) bad++;
  }
  return bad / n < 0.01;
}

function looksLikeJs(b: Uint8Array): boolean {
  const s = Buffer.from(b.subarray(0, 16384)).toString("utf8");
  // Strip a leading license block / hashbang, which can push code past a short window.
  const body = s.replace(/^#![^\n]*\n/, "").replace(/^\s*(\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*/, "");
  return /\b(function|const|let|var|require\(|import\s|export\s|module\.exports)\b|=>/.test(body);
}

/** One-line message for an unsupported or unrecognized input. */
export function unsupportedMessage(path: string, d: Detection): string {
  const lines = [`ree: ${path} looks like: ${d.label}. REE can't analyze this yet.`];
  if (d.hint) lines.push(`     ${d.hint}.`);
  lines.push("     Supported today:");
  for (const s of SUPPORTED_SUMMARY) lines.push(`       • ${s}`);
  return lines.join("\n");
}
