/**
 * REE — Reverse Engineer Everything.
 * Public library surface. For authorized security research and interoperability
 * analysis only; see README "Responsible use".
 */
export * from "./core/types.js";
export { analyze, type AnalyzeOptions, type AnalyzeResult } from "./core/analyze.js";
export { estimateTokens } from "./core/tokens.js";
export { shannonEntropy, repetitionScore } from "./core/entropy.js";

export { ingest, defaultParsers, type IngestOptions } from "./parsers/index.js";
export { runAntiBla, toContextSlices, type EngineOptions } from "./anti-bla/index.js";
export { deriveLimitations } from "./core/limitations.js";
export {
  analyzeApp,
  withMountedDmg,
  canMountDmg,
  type AppAnalysis,
  type AppArtifactResult,
  type AppAnalyzeOptions,
} from "./apps/dmg.js";
export { collectAppArtifacts, findAppBundles, type BundleArtifact, type ArtifactRole } from "./apps/appbundle.js";
export {
  ReconstructionPipeline,
  AnthropicClient,
  DryRunClient,
  TIER_MODELS,
  type LlmClient,
  type ModelTier,
} from "./agents/index.js";
