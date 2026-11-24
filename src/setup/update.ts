/**
 * `ree update`: is a newer REE published, and how do I get it?
 *
 * One GET to the public npm registry for this package's `latest` version (no
 * personal data, a generic user agent, a short timeout). How to update depends
 * on how REE was installed, so that's detected from where it runs.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PACKAGE } from "./setup.js";

export type InstallKind = "npx" | "global" | "other-global" | "checkout" | "project";

export function installKind(scriptPath: string): InstallKind {
  const p = scriptPath.split(/[/\\]/).join("/");
  if (p.includes("/_npx/")) return "npx";
  const root = resolve(dirname(scriptPath), "..", "..");
  if (existsSync(join(root, ".git")) && existsSync(join(root, "src", "cli"))) return "checkout";
  // Global installs by other package managers: REE can't update them with npm.
  if (/\/pnpm\/global\/|\/\.bun\/install\/global\/|\/\.volta\/tools\//i.test(p)) return "other-global";
  // A pnpm *project* install lives under <project>/node_modules/.pnpm/ — not global.
  if (/\/node_modules\/\.pnpm\//.test(p)) return "project";
  // npm's global prefix: <prefix>/lib/node_modules (Unix) or %APPDATA%\npm\node_modules (Windows).
  if (/\/lib\/node_modules\/ree-reverse-engineer-everything\//.test(p) || /\/npm\/node_modules\/ree-reverse-engineer-everything\//i.test(p)) return "global";
  return "project";
}

/** -1, 0 or 1. Pre-release suffixes sort before the release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [main, pre] = v.replace(/^v/, "").split("-", 2);
    return { nums: (main ?? "").split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre && !y.pre) return -1;
  if (!x.pre && y.pre) return 1;
  return x.pre === y.pre ? 0 : (x.pre ?? "") < (y.pre ?? "") ? -1 : 1;
}

export type Fetcher = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export async function latestVersion(fetcher: Fetcher = fetch as unknown as Fetcher, timeoutMs = 5000): Promise<{ latest?: string; error?: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetcher(`https://registry.npmjs.org/${PACKAGE}/latest`, { headers: { accept: "application/json", "user-agent": "ree-cli" }, signal: ctrl.signal });
    if (res.status === 404) return { error: `${PACKAGE} isn't published on npm yet` };
    if (!res.ok) return { error: `the npm registry answered HTTP ${res.status}` };
    const body = (await res.json()) as { version?: unknown };
    const v = typeof body.version === "string" && /^\d+\.\d+\.\d+([-.+][\w.-]+)?$/.test(body.version) ? body.version : undefined;
    return v ? { latest: v } : { error: "the npm registry returned an unexpected answer" };
  } catch (e) {
    return { error: ctrl.signal.aborted ? "the npm registry didn't answer within 5 seconds" : `couldn't reach the npm registry (${(e as Error).message})` };
  } finally {
    clearTimeout(t);
  }
}

export interface UpdateAdvice {
  /** A command REE can run for the user (global installs only). */
  run?: string[];
  /** What to tell the user. */
  message: string;
}

export function updateAdvice(kind: InstallKind, latest: string): UpdateAdvice {
  switch (kind) {
    case "global":
      return { run: ["npm", "install", "--global", `${PACKAGE}@${latest}`], message: `npm install --global ${PACKAGE}@${latest}` };
    case "other-global":
      return { message: `update it with the package manager that installed it (pnpm add -g / bun add -g / volta install ${PACKAGE}@${latest})` };
    case "npx":
      return { message: `npx always uses its cache; run 'npx ${PACKAGE}@latest' (and 'npx ${PACKAGE}@latest setup' to point your agents at it).` };
    case "checkout":
      return { message: "this is a git checkout: git pull && npm install && npm run build" };
    case "project":
      return { message: `in your project: npm install ${PACKAGE}@${latest}` };
  }
}

