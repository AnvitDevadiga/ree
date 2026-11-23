/**
 * Core shared types for REE.
 *
 * The central idea: nothing raw ever reaches an LLM. A parser turns an artifact
 * into a deterministic `ArtifactModel` (structure, symbols, strings, call graph),
 * the anti-BLA engine prunes and sanitizes that model, and only the resulting
 * high-signal slices are handed to an agent.
 */

export type ArtifactFormat =
  | "asar"
  | "js-bundle"
  | "wasm"
  | "pyc"
  | "elf"
  | "macho"
  | "pe"
  | "apk"
  | "unknown";

/** A single logical unit of code recovered from an artifact (a module, function, section). */
export interface CodeUnit {
  /** Stable id, unique within the artifact. */
  id: string;
  /** Human-facing name (function name, module path, export name). */
  name: string;
  kind: "module" | "function" | "section" | "chunk" | "class";
  /** Source text or disassembly, when available deterministically. */
  body?: string;
  /** Byte offset / size in the original artifact, when meaningful. */
  offset?: number;
  size?: number;
  /** ids of other CodeUnits this unit references (call/require/import edges). */
  references: string[];
  /** Whether this unit is reachable from a declared entry point. Filled by the pruner. */
  reachable?: boolean;
  /** Free-form, parser-specific metadata. */
  meta: Record<string, unknown>;
}

/** An extracted string with provenance, used by the sanitizer and triage. */
export interface ExtractedString {
  value: string;
  /** Where it came from: a symbol name, a comment, a data section, etc. */
  source: "symbol" | "comment" | "literal" | "section" | "metadata";
  unitId?: string;
  offset?: number;
}

/** A declared or inferred entry point — the roots for reachability analysis. */
export interface EntryPoint {
  unitId: string;
  reason: "main" | "export" | "ipc-handler" | "start-section" | "declared" | "heuristic" | "electron";
  detail?: string;
}

/**
 * The deterministic, pre-LLM representation of an artifact.
 * Every parser produces one of these; the LLM only ever sees derived slices.
 */
export interface ArtifactModel {
  format: ArtifactFormat;
  /** Absolute path the artifact was read from. */
  sourcePath: string;
  /** Total bytes of the original artifact. */
  byteLength: number;
  units: CodeUnit[];
  strings: ExtractedString[];
  entryPoints: EntryPoint[];
  /** Parser-level warnings (truncated sections, unsupported sub-formats, etc.). */
  warnings: string[];
  meta: Record<string, unknown>;
}

export interface Parser {
  readonly format: ArtifactFormat;
  /** Fast magic/extension check so the registry can route a file. */
  canParse(input: ParserInput): boolean;
  parse(input: ParserInput): Promise<ArtifactModel>;
}

export interface ParserInput {
  path: string;
  bytes: Uint8Array;
  limits?: ParserLimits;
}

export interface ParserLimits {
  /** Hard cap on structural header bytes a parser will decode (anti-Exhaust). */
  maxHeaderBytes: number;
  /** Header size above which the header is flagged as a likely decoy. */
  suspiciousHeaderBytes: number;
  /** Max nesting depth a parser will descend into (anti deep-nesting traps). */
  maxDepth: number;
  /** Max entries/units a parser will materialize. */
  maxUnits: number;
}

export const DEFAULT_LIMITS: ParserLimits = {
  maxHeaderBytes: 64 * 1024 * 1024,
  suspiciousHeaderBytes: 8 * 1024 * 1024,
  maxDepth: 128,
  maxUnits: 200_000,
};

/**
 * Conventions for `ArtifactModel.meta` keys shared across passes:
 *  - graphComplete: true when the parser recovered a call/reference graph it
 *    trusts. Reachability pruning only runs when this is true; for formats where
 *    REE cannot yet recover calls (pyc, native) nothing is pruned.
 */
export interface SharedMeta {
  graphComplete?: boolean;
}

/** A finding produced by an anti-BLA pass. */
export interface AntiBlaFinding {
  pass: string;
  severity: "info" | "suspicious" | "malicious";
  unitId?: string;
  message: string;
  /** Action the engine took or recommends. */
  action: "flagged" | "quarantined" | "pruned" | "sanitized";
  evidence?: Record<string, unknown>;
}

/** Result of running the anti-BLA engine over an ArtifactModel. */
export interface AntiBlaReport {
  findings: AntiBlaFinding[];
  /** The cleaned model, safe to slice for an LLM. */
  model: ArtifactModel;
  stats: {
    unitsIn: number;
    unitsOut: number;
    unitsPruned: number;
    unitsQuarantined: number;
    /** Subset of unitsQuarantined that were removed as structural-clone decoy families. */
    decoyFamilyUnits?: number;
    stringsSanitized: number;
    estTokensBefore: number;
    estTokensAfter: number;
  };
}

/** A minimal, high-signal context slice destined for an LLM. */
export interface ContextSlice {
  unitId: string;
  name: string;
  /** The exact text the agent should reason over. */
  content: string;
  /** Names of directly referenced units, for optional follow-up. */
  neighbors: string[];
  estTokens: number;
}
