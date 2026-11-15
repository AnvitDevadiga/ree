export { runAntiBla, toContextSlices, renderUnit, type EngineOptions } from "./engine.js";
export { analyzeReachability, keepReachable } from "./reachability.js";
export { detectContextBombs, DEFAULT_THRESHOLDS, type BombThresholds } from "./context-bomb.js";
export { foldOpaquePredicates, simplifyOpaquePredicates, evaluateOpaque } from "./opaque-predicates.js";
export { sanitizeBody, sanitizeStrings, detectStringDecoder, looksInjected, scanJs } from "./sanitizer.js";
