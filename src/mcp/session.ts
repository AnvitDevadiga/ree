/**
 * Shared, cached analysis state for the MCP server.
 *
 * MCP clients tend to call several tools against the same artifact in a row
 * (inspect -> strip -> trace -> reconstruct). Re-parsing each time wastes work,
 * so results are cached per (path, size, mtime) and invalidated automatically
 * when the file changes.
 */
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { analyze, type AnalyzeResult } from "../core/analyze.js";
import type { EngineOptions } from "../anti-bla/engine.js";

interface CacheEntry {
  key: string;
  result: AnalyzeResult;
}

const MAX_ENTRIES = 16;
const cache = new Map<string, CacheEntry>();

export async function getAnalysis(path: string, antiBla?: EngineOptions): Promise<AnalyzeResult> {
  const abs = resolve(path);
  const st = await stat(abs);
  if (!st.isFile()) throw new Error(`not a file: ${abs}`);
  const key = `${abs}|${st.size}|${st.mtimeMs}|${JSON.stringify(antiBla ?? {})}`;
  const hit = cache.get(key);
  if (hit) {
    // refresh LRU position
    cache.delete(key);
    cache.set(key, hit);
    return hit.result;
  }
  const result = await analyze(abs, { antiBla });
  cache.set(key, { key, result });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return result;
}

export function clearAnalysisCache(): void {
  cache.clear();
}
