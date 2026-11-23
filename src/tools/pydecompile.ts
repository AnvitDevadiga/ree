/**
 * Optional Python bytecode decompilation.
 *
 * Chosen from REE's own evaluation (`npm run bench:pyc`, docs/eval/pyc-decompilers.md):
 *   - pycdc (Decompyle++, GPL-3.0) — the only maintained option aiming at 3.9+;
 *     preferred when installed.
 *   - uncompyle6 (GPL-3.0) — bytecode up to 3.8; best of the pip-installable
 *     tools in the evaluation (decompyle3 leaked parser grammar into output).
 * Both are run as separate processes and never bundled or linked, so REE stays
 * MIT. Output is checked for known decompiler failure markers and rejected
 * rather than presented as real source; accepted output is still untrusted and
 * goes through the cleaning engine.
 */
import { findTool, runTool, safeInputPath, type ToolSpec } from "./external.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PYCDC: ToolSpec = {
  bin: "pycdc",
  name: "pycdc (Decompyle++)",
  license: "GPL-3.0 (run as a separate program; not bundled)",
  unlocks: "Python .pyc decompilation for 3.9–3.12 (partial; float constants truncated); fails on 3.13+",
  install: { any: "build from source: https://github.com/zrax/pycdc (cmake), then put 'pycdc' on PATH" },
};

export const UNCOMPYLE6: ToolSpec = {
  bin: "uncompyle6",
  name: "uncompyle6",
  license: "GPL-3.0 (run as a separate program; not bundled)",
  unlocks: "Python .pyc decompilation for bytecode up to 3.8",
  extraDirs: ["~/.local/bin"],
  install: { any: "uv tool install --python 3.8 uncompyle6   (or: pipx install uncompyle6)" },
};

/** First magic number of Python 3.9 bytecode; uncompyle6 stops before it. */
const MAGIC_3_9 = 3420;

const FAILURE_MARKERS = [/Unsupported Python version/i, /Parse error at or near/i, /::=/, /--- This code section failed/i, /Unknown opcode/i, /Bad MAGIC/i];

export interface PyDecompileResult {
  tool: string;
  source: string;
  /** pycdc marks sections it could not decompile. */
  incomplete: boolean;
  /** First problem line the tool reported (e.g. "Unsupported opcode: MAKE_FUNCTION (122)"). */
  problem?: string;
}

/**
 * Per REE's evaluation: for bytecode <= 3.8 uncompyle6 was behaviorally exact on
 * colorsys where pycdc was not (pycdc truncates float literals), so uncompyle6
 * goes first; for 3.9+ pycdc is the only tool that produces anything.
 */
export function pickPyDecompiler(magic: number, env: NodeJS.ProcessEnv = process.env): { spec: ToolSpec; bin: string } | null {
  if (env.REE_DISABLE_PYDECOMPILE) return null;
  const pycdc = findTool(PYCDC, env);
  const u6 = magic < MAGIC_3_9 ? findTool(UNCOMPYLE6, env) : null;
  if (u6) return { spec: UNCOMPYLE6, bin: u6 };
  if (pycdc) return { spec: PYCDC, bin: pycdc };
  return null;
}

/** Hint for the limitations report: which tool would help this version. */
export function pyDecompileHint(magic: number): string {
  if (magic < MAGIC_3_9) return `install uncompyle6 (${UNCOMPYLE6.install.any}) or pycdc (${PYCDC.install.any})`;
  if (magic < 3570) return `pycdc can partially decompile this version (${PYCDC.install.any})`;
  return "no open-source decompiler REE evaluated supports this Python version yet (pycdc fails on 3.13+)";
}

export async function decompilePyc(tool: { spec: ToolSpec; bin: string }, path: string, timeoutMs = 120_000): Promise<PyDecompileResult> {
  const work = mkdtempSync(join(tmpdir(), "ree-pydecomp-"));
  try {
    const r = await runTool(tool.bin, [safeInputPath(path)], {
      cwd: work,
      timeoutMs: Number(process.env.REE_PYDECOMPILE_TIMEOUT_MS) || timeoutMs,
      maxOutputBytes: 32 * 1024 * 1024,
    });
    const source = r.stdout;
    const failed = FAILURE_MARKERS.find((re) => re.test(source) || re.test(r.stderr));
    if (failed) throw new Error(`${tool.spec.bin} could not decompile this file (${(source + r.stderr).split("\n").find((l) => failed.test(l))?.trim().slice(0, 120)})`);
    if (!/\b(def|class|import)\b|=/.test(source)) throw new Error(`${tool.spec.bin} produced no usable source`);
    const all = `${r.stderr}\n${source}`.split("\n");
    const problem = (all.find((l) => /Unsupported opcode/i.test(l)) ?? all.find((l) => /Decompyle incomplete/i.test(l)))?.replace(/^#\s*/, "").trim().slice(0, 120);
    return { tool: tool.spec.bin, source, incomplete: /WARNING: Decompyle incomplete|Unsupported opcode/i.test(source), problem };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Split decompiled module source into top-level blocks: `def`/`class` (with
 * their decorators) keyed by name, and everything else as the module body.
 */
export function splitTopLevel(source: string): { blocks: Map<string, string>; module: string } {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks = new Map<string, string>();
  const moduleLines: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const startsBlock = /^(@|async\s+def\s|def\s|class\s)/.test(line);
    if (!startsBlock) {
      moduleLines.push(line);
      i++;
      continue;
    }
    const start = i;
    while (i < lines.length && lines[i]!.startsWith("@")) i++; // decorators
    const header = lines[i] ?? "";
    const name = /^(?:async\s+def|def|class)\s+(\w+)/.exec(header)?.[1];
    i++;
    // The block continues through indented, blank, or comment lines.
    while (i < lines.length && (lines[i]!.trim() === "" || /^[ \t]/.test(lines[i]!) || /^#/.test(lines[i]!))) i++;
    const text = lines.slice(start, i).join("\n").trimEnd();
    if (name && !blocks.has(name)) blocks.set(name, text);
    else moduleLines.push(text);
  }
  return { blocks, module: moduleLines.join("\n").trim() };
}
