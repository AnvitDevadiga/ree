/** Scoring helpers for the reconstruction benchmark (see run.ts). */
import vm from "node:vm";
import { transformSync } from "esbuild";

export interface Probe {
  label: string;
  cases: Array<{ args: unknown[]; expect: unknown }>;
}

// ---------------------------------------------------------------------------
// scoring
// ---------------------------------------------------------------------------
export function definedNames(src: string): Set<string> {
  const out = new Set<string>();
  const res = [
    /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g,
    /^\s*def\s+([A-Za-z_]\w*)\s*\(/gm,
  ];
  for (const re of res) for (const m of src.matchAll(re)) out.add(m[1]!);
  return out;
}

/** Evaluate one reconstruction and return every callable it defines. */
export function callables(src: string): Map<string, Function> {
  const fns = new Map<string, Function>();
  let code: string;
  try {
    code = transformSync(src, { loader: "ts", format: "cjs", logLevel: "silent" }).code;
  } catch {
    return fns;
  }
  const module = { exports: {} as Record<string, unknown> };
  const ctx = vm.createContext({ module, exports: module.exports });
  try {
    vm.runInContext(code, ctx, { timeout: 1000 });
  } catch {
    /* partial definitions may still be usable */
  }
  const take = (k: string, v: unknown) => {
    if (typeof v === "function" && !fns.has(k)) fns.set(k, v as Function);
  };
  for (const k of Object.getOwnPropertyNames(ctx)) take(k, (ctx as Record<string, unknown>)[k]);
  const ex = module.exports as unknown;
  if (typeof ex === "function") take("module.exports", ex);
  else if (ex && typeof ex === "object") for (const [k, v] of Object.entries(ex)) take(`exports.${k}`, v);
  return fns;
}

function same(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

export function probePasses(fn: Function, probe: Probe): boolean {
  for (const c of probe.cases) {
    try {
      const args = JSON.parse(JSON.stringify(c.args)); // isolate from mutation
      const got = vm.runInNewContext("f(...a)", { f: fn, a: args }, { timeout: 500 });
      if (!same(got, c.expect)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

