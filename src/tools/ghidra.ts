/**
 * Optional Ghidra headless decompilation for native binaries.
 *
 * Ghidra (Apache-2.0) is the mature open-source decompiler for ELF, Mach-O and
 * PE. REE never bundles it: it is found at runtime (PATH, GHIDRA_INSTALL_DIR,
 * or a Homebrew install) and run as `analyzeHeadless` with a small export
 * script REE writes into a private temp dir. The script decompiles each
 * function to C and writes one JSON line per function. Everything it returns
 * is untrusted and goes through the cleaning engine.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { platform } from "node:os";
import { findTool, runTool, safeInputPath, type ToolSpec } from "./external.js";

export const GHIDRA: ToolSpec = {
  bin: "analyzeHeadless",
  name: "Ghidra (headless)",
  license: "Apache-2.0",
  unlocks: "native ELF/Mach-O/PE decompilation to C pseudocode, plus a call graph",
  extraDirs: ["/opt/homebrew/opt/ghidra/libexec/support", "/usr/local/opt/ghidra/libexec/support", "/opt/ghidra/support", "/usr/share/ghidra/support"],
  install: {
    darwin: "brew install ghidra",
    linux: "download Ghidra from https://github.com/NationalSecurityAgency/ghidra/releases, unzip it, and set GHIDRA_INSTALL_DIR (needs JDK 21)",
    win32: "download Ghidra from https://github.com/NationalSecurityAgency/ghidra/releases, unzip it, and set GHIDRA_INSTALL_DIR (needs JDK 21)",
  },
};

/** Locate analyzeHeadless, honoring GHIDRA_INSTALL_DIR first. */
export function findGhidra(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.GHIDRA_INSTALL_DIR) {
    for (const n of ["analyzeHeadless", "analyzeHeadless.bat"]) {
      const p = join(env.GHIDRA_INSTALL_DIR, "support", n);
      if (existsSync(p)) return p;
    }
  }
  return findTool(GHIDRA, env);
}

/**
 * Environment for Ghidra's launcher. It uses the first `java` on PATH — on macOS
 * often the /usr/bin/java stub with no runtime behind it — so put a real JDK
 * first: the user's JAVA_HOME if set, else a standard install (Ghidra 12 needs
 * Java 21+). Only the Ghidra child process sees this.
 */
export function ghidraEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const hasJava = (home: string) => existsSync(join(home, "bin", platform() === "win32" ? "java.exe" : "java"));
  let home = env.JAVA_HOME && hasJava(env.JAVA_HOME) ? env.JAVA_HOME : undefined;
  if (!home) {
    const candidates = ["/opt/homebrew/opt/openjdk@25", "/opt/homebrew/opt/openjdk@21", "/opt/homebrew/opt/openjdk", "/usr/local/opt/openjdk@21", "/usr/local/opt/openjdk"];
    for (const root of ["/Library/Java/JavaVirtualMachines", "/usr/lib/jvm"]) {
      try {
        for (const d of readdirSync(root).sort().reverse()) candidates.push(join(root, d, root.startsWith("/Library") ? "Contents/Home" : ""));
      } catch {
        /* not present */
      }
    }
    home = candidates.find(hasJava);
  }
  if (!home) return {};
  return { JAVA_HOME: home, PATH: `${join(home, "bin")}${delimiter}${env.PATH ?? ""}` };
}

/** Ghidra post-script: decompile every function, one JSON object per line. */
export const EXPORT_SCRIPT = `import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.io.PrintWriter;
import java.util.Set;

public class ReeExport extends GhidraScript {
  private static String q(String s) {
    if (s == null) return "null";
    StringBuilder b = new StringBuilder("\\"");
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      if (c == '"' || c == '\\\\') b.append('\\\\').append(c);
      else if (c < 0x20) b.append(String.format("\\\\u%04x", (int) c));
      else b.append(c);
    }
    return b.append('"').toString();
  }

  @Override
  public void run() throws Exception {
    String[] a = getScriptArgs();
    String outPath = a[0];
    int max = a.length > 1 ? Integer.parseInt(a[1]) : 5000;
    int perFn = a.length > 2 ? Integer.parseInt(a[2]) : 30;
    long maxChars = a.length > 3 ? Long.parseLong(a[3]) : 64L * 1024 * 1024;
    DecompInterface ifc = new DecompInterface();
    ifc.openProgram(currentProgram);
    long written = 0;
    try (PrintWriter w = new PrintWriter(new OutputStreamWriter(new FileOutputStream(outPath), "UTF-8"))) {
      FunctionIterator it = currentProgram.getFunctionManager().getFunctions(true);
      int n = 0;
      while (it.hasNext() && n < max && written < maxChars && !monitor.isCancelled()) {
        Function f = it.next();
        if (f.isExternal() || f.isThunk()) continue;
        String c = null;
        DecompileResults r = ifc.decompileFunction(f, perFn, monitor);
        if (r != null && r.decompileCompleted() && r.getDecompiledFunction() != null) c = r.getDecompiledFunction().getC();
        StringBuilder callees = new StringBuilder("[");
        Set<Function> called = f.getCalledFunctions(monitor);
        int k = 0;
        for (Function g : called) {
          if (k++ > 0) callees.append(',');
          callees.append(q(g.getName()));
          if (k >= 200) break;
        }
        callees.append(']');
        String line = "{\\"name\\":" + q(f.getName()) + ",\\"entry\\":" + q(f.getEntryPoint().toString())
            + ",\\"signature\\":" + q(f.getSignature().getPrototypeString()) + ",\\"c\\":" + q(c)
            + ",\\"callees\\":" + callees + "}";
        w.println(line);
        written += line.length();
        n++;
      }
    } finally {
      ifc.dispose();
    }
  }
}
`;

export interface GhidraFunction {
  name: string;
  /** Entry address as Ghidra prints it, e.g. "100003f20". */
  entry: string;
  signature?: string;
  c?: string | null;
  callees: string[];
}

export interface GhidraOptions {
  timeoutMs: number;
  maxFunctions: number;
  perFunctionTimeoutSec: number;
  maxOutputChars: number;
}

export const DEFAULT_GHIDRA_OPTIONS: GhidraOptions = {
  timeoutMs: 900_000,
  maxFunctions: 5_000,
  perFunctionTimeoutSec: 30,
  maxOutputChars: 64 * 1024 * 1024,
};

/** Run Ghidra headless on one binary and return its decompiled functions. */
export async function decompileWithGhidra(
  tool: string,
  binaryPath: string,
  o: GhidraOptions = DEFAULT_GHIDRA_OPTIONS,
): Promise<{ functions: GhidraFunction[]; rejected: number }> {
  const work = mkdtempSync(join(tmpdir(), "ree-ghidra-"));
  try {
    const scripts = join(work, "scripts");
    const project = join(work, "project");
    const out = join(work, "functions.jsonl");
    for (const d of [scripts, project]) mkdirSync(d, { recursive: true });
    writeFileSync(join(scripts, "ReeExport.java"), EXPORT_SCRIPT);
    const run = await runTool(
      tool,
      [
        project, "ree",
        "-import", safeInputPath(binaryPath),
        "-scriptPath", scripts,
        "-postScript", "ReeExport.java", out, String(o.maxFunctions), String(o.perFunctionTimeoutSec), String(o.maxOutputChars),
        "-deleteProject",
        "-analysisTimeoutPerFile", String(Math.max(60, Math.floor(o.timeoutMs / 1000) - 30)),
      ],
      { cwd: work, timeoutMs: Number(process.env.REE_GHIDRA_TIMEOUT_MS) || o.timeoutMs, maxOutputBytes: 16 * 1024 * 1024, env: ghidraEnv() },
    );
    if (!existsSync(out)) {
      const reason = `${run.stderr}\n${run.stdout}`.split("\n").map((l) => l.trim()).find((l) => /ERROR|Unable|Exception|not found/i.test(l));
      throw new Error(`Ghidra produced no output (exit ${run.code}${reason ? `: ${reason.slice(0, 200)}` : ""})`);
    }
    if (statSync(out).size > o.maxOutputChars * 2) throw new Error("Ghidra output exceeds the size limit");
    const functions: GhidraFunction[] = [];
    let rejected = 0;
    for (const line of readFileSync(out, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line) as Partial<GhidraFunction>;
        if (typeof j.name !== "string" || typeof j.entry !== "string" || !Array.isArray(j.callees)) throw new Error("shape");
        functions.push({
          name: j.name.slice(0, 512),
          entry: j.entry.slice(0, 64),
          signature: typeof j.signature === "string" ? j.signature.slice(0, 2048) : undefined,
          c: typeof j.c === "string" ? j.c.slice(0, 512 * 1024) : null,
          callees: j.callees.filter((x): x is string => typeof x === "string").slice(0, 200).map((x) => x.slice(0, 512)),
        });
        if (functions.length >= o.maxFunctions) break;
      } catch {
        rejected++;
      }
    }
    return { functions, rejected };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
