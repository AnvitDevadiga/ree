/**
 * Context-bomb and tarpit detector.
 *
 * "Exhaust"-style defenses inflate analyzer cost with two opposite payloads:
 *  - high-entropy blobs (packed or encrypted data posing as code), and
 *  - low-entropy, highly repetitive filler built to fill a context window.
 * Units that trip either signal are quarantined: kept out of LLM context, but
 * still listed in the report, since a packed blob may deserve a targeted look.
 *
 * Size alone is not grounds for quarantine (large legitimate modules exist);
 * oversized units are flagged and the slicer truncates them instead.
 * Generated listings (WASM disassembly) are naturally repetitive, so only the
 * size check applies to them.
 */
import type { AntiBlaFinding, CodeUnit } from "../core/types.js";
import { repetitionScore, shannonEntropy } from "../core/entropy.js";
import { estimateTokens } from "../core/tokens.js";

export interface BombThresholds {
  /** Bits per character above which text looks packed or encrypted. */
  highEntropy: number;
  /** Repeated-chunk ratio above which text looks like filler. */
  highRepetition: number;
  /** Units must be at least this many estimated tokens to be judged at all. */
  minTokens: number;
  /** Estimated tokens above which a unit is flagged as oversized. */
  oversized: number;
}

export const DEFAULT_THRESHOLDS: BombThresholds = {
  highEntropy: 5.6,
  highRepetition: 0.55,
  minTokens: 1500,
  oversized: 12000,
};

export interface BombResult {
  findings: AntiBlaFinding[];
  quarantined: Set<string>;
}

export function detectContextBombs(units: CodeUnit[], t: BombThresholds = DEFAULT_THRESHOLDS): BombResult {
  const findings: AntiBlaFinding[] = [];
  const quarantined = new Set<string>();

  for (const u of units) {
    const text = u.body;
    if (!text) continue;
    const tokens = estimateTokens(text);
    if (tokens < t.minTokens) continue;
    const generated = (u.meta as { listing?: boolean }).listing === true;

    const reasons: string[] = [];
    let entropy = 0;
    let repetition = 0;
    if (!generated) {
      entropy = shannonEntropy(text);
      repetition = repetitionScore(text);
      if (entropy >= t.highEntropy) reasons.push(`entropy ${entropy.toFixed(2)} bits/char (packed or encrypted)`);
      if (repetition >= t.highRepetition) reasons.push(`${(repetition * 100).toFixed(0)}% repeated chunks (filler)`);
    }

    if (reasons.length) {
      quarantined.add(u.id);
      findings.push({
        pass: "context-bomb",
        severity: reasons.length > 1 ? "malicious" : "suspicious",
        action: "quarantined",
        unitId: u.id,
        message: `quarantined "${u.name}" from LLM context: ${reasons.join("; ")}`,
        evidence: { tokens, entropy: round(entropy), repetition: round(repetition) },
      });
    } else if (tokens >= t.oversized) {
      findings.push({
        pass: "context-bomb",
        severity: "info",
        action: "flagged",
        unitId: u.id,
        message: `"${u.name}" is ~${tokens} tokens; slices of it will be truncated`,
        evidence: { tokens },
      });
    }
  }
  return { findings, quarantined };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
