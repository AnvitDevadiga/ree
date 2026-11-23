/**
 * `ree doctor`: what this machine can do with REE.
 *
 * Reports the Node version, which optional external tools are installed, what
 * each missing one would unlock, and the exact command to install it — plus the
 * model-provider configuration (never printing a key). Tools are located by
 * searching PATH; doctor never executes them.
 */
import { platform } from "node:os";
import { resolveProvider } from "../agents/providers.js";
import { ILSPY, JADX, VINEFLOWER, findTool, which, type ToolSpec } from "../tools/external.js";
import { GHIDRA } from "../tools/ghidra.js";

export { which };

export interface OptionalTool {
  /** Executable name looked up on PATH. */
  bin: string;
  /** Human name. */
  name: string;
  /** What REE can do with it. */
  unlocks: string;
  /** Platforms where the tool can exist at all (omit for all). */
  platforms?: NodeJS.Platform[];
  /** Install commands per platform. */
  install: Partial<Record<NodeJS.Platform, string>>;
  /** Full spec when the tool also lives outside PATH (e.g. ~/.dotnet/tools). */
  spec?: ToolSpec;
}

/** Registry of optional tools. Each new integration adds an entry here. */
export const OPTIONAL_TOOLS: OptionalTool[] = [
  {
    bin: "hdiutil",
    name: "hdiutil",
    unlocks: ".dmg analysis (mounts the image read-only)",
    platforms: ["darwin"],
    install: { darwin: "ships with macOS" },
  },
  { bin: JADX.bin, name: JADX.name, unlocks: JADX.unlocks, install: JADX.install as OptionalTool["install"] },
  { bin: VINEFLOWER.bin, name: VINEFLOWER.name, unlocks: VINEFLOWER.unlocks, install: VINEFLOWER.install as OptionalTool["install"] },
  { bin: ILSPY.bin, name: ILSPY.name, unlocks: ILSPY.unlocks, install: ILSPY.install as OptionalTool["install"], spec: ILSPY },
  { bin: GHIDRA.bin, name: GHIDRA.name, unlocks: GHIDRA.unlocks, install: GHIDRA.install as OptionalTool["install"], spec: GHIDRA },
];

export interface DoctorReport {
  node: { version: string; ok: boolean; required: string };
  platform: NodeJS.Platform;
  tools: Array<{ name: string; bin: string; found: string | null; unlocks: string; install?: string; applicable: boolean }>;
  provider: { kind: string; note: string; error?: string };
}

export function runDoctor(env: NodeJS.ProcessEnv = process.env, required = ">=20"): DoctorReport {
  const major = Number(process.versions.node.split(".")[0]);
  const min = Number(/\d+/.exec(required)?.[0] ?? 20);
  const plat = platform();
  const tools = OPTIONAL_TOOLS.map((t) => {
    const applicable = !t.platforms || t.platforms.includes(plat);
    return {
      name: t.name,
      bin: t.bin,
      found: applicable ? (t.spec ? findTool(t.spec, env) : which(t.bin, env)) : null,
      unlocks: t.unlocks,
      install: t.install[plat],
      applicable,
    };
  });
  let provider: DoctorReport["provider"];
  try {
    const p = resolveProvider(env);
    provider = { kind: p.kind, note: p.note };
  } catch (e) {
    provider = { kind: "misconfigured", note: "reconstruction will refuse to run until this is fixed", error: (e as Error).message };
  }
  return { node: { version: process.versions.node, ok: major >= min, required }, platform: plat, tools, provider };
}
