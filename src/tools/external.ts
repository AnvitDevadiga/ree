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
  /** Extra directories to search besides PATH (e.g. ~/.dotnet/tools). Leading ~ is the home dir. */
  extraDirs?: string[];
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

export const VINEFLOWER: ToolSpec = {
  bin: "vineflower",
  name: "Vineflower",
  license: "Apache-2.0",
  unlocks: "Java JAR/.class decompilation to Java source",
  install: {
    darwin: "brew install vineflower",
    linux: "download vineflower.jar from https://github.com/Vineflower/vineflower/releases and add a 'vineflower' wrapper that runs 'java -jar vineflower.jar \"$@\"' (needs Java 17+)",
    win32: "download vineflower.jar from https://github.com/Vineflower/vineflower/releases and add a 'vineflower.cmd' wrapper (needs Java 17+)",
  },
};

export const ILSPY: ToolSpec = {
  bin: "ilspycmd",
  name: "ilspycmd",
  license: "MIT",
  unlocks: ".NET assembly decompilation to C# source",
  extraDirs: ["~/.dotnet/tools"],
  install: {
    darwin: "brew install dotnet && dotnet tool install -g ilspycmd",
    linux: "install the .NET SDK (https://dotnet.microsoft.com/download), then: dotnet tool install -g ilspycmd",
    win32: "install the .NET SDK (https://dotnet.microsoft.com/download), then: dotnet tool install -g ilspycmd",
  },
};

/**
 * Environment for running a .NET global tool. Homebrew and other installs put
 * the runtime outside the default location, so DOTNET_ROOT is set when unset
 * and a standard install exists; roll-forward lets a tool built for an older
 * .NET run on a newer one. The user's own settings always win.
 */
export function dotnetToolEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  if (!env.DOTNET_ROOT) {
    const home = env.HOME ?? env.USERPROFILE ?? "";
    const candidates = ["/opt/homebrew/opt/dotnet/libexec", "/usr/local/opt/dotnet/libexec", "/usr/local/share/dotnet", "/usr/share/dotnet", "/usr/lib/dotnet", join(home, ".dotnet")];
    const root = candidates.find((d) => existsSync(join(d, platform() === "win32" ? "dotnet.exe" : "dotnet")));
    if (root) out.DOTNET_ROOT = root;
  }
  if (!env.DOTNET_ROLL_FORWARD) out.DOTNET_ROLL_FORWARD = "Major";
  return out;
}

/** Locate a tool on PATH or in its extra directories, without running it. */
export function findTool(t: ToolSpec, env: NodeJS.ProcessEnv = process.env): string | null {
  const found = which(t.bin, env);
  if (found) return found;
  const home = env.HOME ?? env.USERPROFILE ?? "";
  for (const d of t.extraDirs ?? []) {
    const dir = d.startsWith("~") ? join(home, d.slice(1)) : d;
    const hit = which(t.bin, { ...env, PATH: dir });
    if (hit) return hit;
  }
  return null;
}

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
  /** Extra environment for the child process (merged over process.env). */
  env?: NodeJS.ProcessEnv;
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
      { cwd: o.cwd, env: o.env ? { ...process.env, ...o.env } : process.env, timeout: o.timeoutMs, killSignal: "SIGKILL", maxBuffer: o.maxOutputBytes ?? 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
        if (e?.killed) return fail(new ToolError(`${binPath} exceeded its ${Math.round(o.timeoutMs / 1000)}s time limit`));
        if (e && typeof e.code !== "number") return fail(new ToolError(`${binPath}: ${e.message}`));
        done({ stdout: String(stdout), stderr: String(stderr), code: typeof e?.code === "number" ? e.code : 0 });
      },
    );
  });
}

/** First meaningful line of a tool's error output, for warnings. */
export function toolError(r: { stdout: string; stderr: string; code: number }): string {
  const line = `${r.stderr}\n${r.stdout}`.split("\n").map((l) => l.trim()).find((l) => l && !/^(INFO|DEBUG)\b/.test(l));
  return `exit ${r.code}${line ? `: ${line.slice(0, 200)}` : ""}`;
}

/** Absolute path for an input file, so it can never be parsed as a flag. */
export function safeInputPath(p: string): string {
  return isAbsolute(p) ? p : resolve(p);
}
