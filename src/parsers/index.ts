/**
 * Parser registry and the top-level `ingest()` entry point.
 *
 * `ingest` routes a file to the first parser that claims it and hands every
 * parser the same ParserLimits, so structural "Exhaust" traps (inflated headers,
 * deep nesting, entry floods) are bounded inside the parser rather than trusted.
 * Nothing here calls an LLM.
 */
import { readFile, stat } from "node:fs/promises";
import { DEFAULT_LIMITS, type ArtifactModel, type Parser, type ParserInput, type ParserLimits } from "../core/types.js";
import { AsarParser } from "./asar.js";
import { JsBundleParser } from "./js-bundle.js";
import { WasmParser } from "./wasm.js";
import { PycParser } from "./pyc.js";
import { NativeParser } from "./native.js";
import { ApkParser } from "./apk.js";
import { JarParser } from "./jar.js";
import { DotnetParser } from "./dotnet.js";

export { AsarParser, JsBundleParser, WasmParser, PycParser, NativeParser, ApkParser, JarParser, DotnetParser };

export interface IngestOptions {
  /** Max bytes REE will read; larger files are rejected, never silently truncated. */
  maxBytes?: number;
  limits?: Partial<ParserLimits>;
}

const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

/** Order matters: magic-number formats first, JS (text sniffing) next, native last. */
export function defaultParsers(): Parser[] {
  return [new AsarParser(), new WasmParser(), new PycParser(), new ApkParser(), new JarParser(), new DotnetParser(), new NativeParser(), new JsBundleParser()];
}

export async function ingest(path: string, opts: IngestOptions = {}): Promise<ArtifactModel> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const st = await stat(path);
  if (!st.isFile()) throw new Error(`not a regular file: ${path}`);
  if (st.size > maxBytes) {
    throw new Error(`artifact is ${st.size} bytes, above the ${maxBytes}-byte limit; raise maxBytes deliberately if intended`);
  }
  const buf = await readFile(path);
  const input: ParserInput = {
    path,
    bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
    limits: { ...DEFAULT_LIMITS, ...opts.limits },
  };

  for (const parser of defaultParsers()) {
    if (parser.canParse(input)) return parser.parse(input);
  }
  return {
    format: "unknown",
    sourcePath: path,
    byteLength: input.bytes.length,
    units: [],
    strings: [],
    entryPoints: [],
    warnings: ["no parser recognized this artifact"],
    meta: { graphComplete: false },
  };
}
