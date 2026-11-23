/**
 * Optional external tools (decompilers) — detection and bounded execution.
 *
 * REE wraps mature open-source decompilers instead of re-implementing them, but
 * every one is optional: it is located on PATH at runtime, and when missing REE
 * prints the exact install command and carries on with what it can do alone.
 *
 * Execution is deliberately narrow: argv arrays only (no shell), an absolute
 * input path (so a file name can never be read as a flag), a private temp
 * working directory, a wall-clock timeout, and a cap on captured output.
 * Whatever a tool writes is untrusted and goes through REE's cleaning engine.
 */
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, join, isAbsolute, resolve } from "node:path";
import { platform } from "node:os";

export interface ToolSpec {
  /** Executable name looked up on PATH. */
  bin: string;
  name: string;
  /** SPDX license of the tool (verified compatible with REE's MIT license). */
  license: string;
  /** What REE can do with it. */
  unlocks: string;
  platforms?: NodeJS.Platform[];
  install: Partial<Record<NodeJS.Platform | "any", string>>;
}

export const JADX: ToolSpec = {
  bin: "jadx",
  name: "jadx",
  license: "Apache-2.0",
  unlocks: "Android APK/AAB decompilation to Java source",
  install: {
    darwin: "brew install jadx",
    linux: "download a release from https://github.com/skylot/jadx/releases (needs Java 11+)",
    win32: "scoop install jadx  (or download from https://github.com/skylot/jadx/releases)",
  },
};

/** Locate an executable on PATH without running it. */
export function which(bin: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const exts = platform() === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").concat([""]) : [""];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, bin + ext);
      try {
        if (existsSync(p) && statSync(p).isFile()) return p;
      } catch {
        /* unreadable entry */
      }
    }
  }
  return null;
}

export function installHint(t: ToolSpec): string {
  return t.install[platform()] ?? t.install.any ?? `install ${t.name} and put '${t.bin}' on PATH`;
}

export class ToolError extends Error {}

export interface RunOptions {
  cwd: string;
  timeoutMs: number;
  /** Cap on captured stdout+stderr bytes. */
  maxOutputBytes?: number;
}

/** Run a tool with an argv array (never a shell) under a timeout. */
export function runTool(binPath: string, args: string[], o: RunOptions): Promise<{ stdout: string; stderr: string; code: number }> {
  for (const a of args) if (a.includes("\0")) throw new ToolError("argument contains a NUL byte");
  return new Promise((done, fail) => {
    execFile(
      binPath,
      args,
      { cwd: o.cwd, timeout: o.timeoutMs, killSignal: "SIGKILL", maxBuffer: o.maxOutputBytes ?? 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
        if (e?.killed) return fail(new ToolError(`${binPath} exceeded its ${Math.round(o.timeoutMs / 1000)}s time limit`));
        if (e && typeof e.code !== "number") return fail(new ToolError(`${binPath}: ${e.message}`));
        done({ stdout: String(stdout), stderr: String(stderr), code: typeof e?.code === "number" ? e.code : 0 });
      },
    );
  });
}

/** Absolute path for an input file, so it can never be parsed as a flag. */
export function safeInputPath(p: string): string {
  return isAbsolute(p) ? p : resolve(p);
}
