/**
 * High-level façade: the deterministic half of REE in one call.
 *
 * `analyze()` ingests an artifact and runs the full anti-BLA pre-pass, returning
 * the cleaned model, the findings report, and ready-to-send context slices —
 * with no LLM involved. This is the budget-safe boundary: callers (CLI, MCP,
 * agents) build on top of it and decide whether to spend tokens.
 */
import { ingest, type IngestOptions } from "../parsers/index.js";
import { runAntiBla, toContextSlices, type EngineOptions } from "../anti-bla/engine.js";
import type { AntiBlaReport, ContextSlice } from "./types.js";

export interface AnalyzeOptions extends IngestOptions {
  antiBla?: EngineOptions;
  tokenBudget?: number;
}

export interface AnalyzeResult {
  report: AntiBlaReport;
  slices: ContextSlice[];
}

export async function analyze(path: string, opts: AnalyzeOptions = {}): Promise<AnalyzeResult> {
  const model = await ingest(path, opts);
  const report = runAntiBla(model, opts.antiBla);
  const slices = toContextSlices(report.model, opts.tokenBudget ?? 60000);
  return { report, slices };
}
